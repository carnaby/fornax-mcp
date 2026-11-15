//! Runs the tray (spec 06 4.7). One thread applies every input to the model in order, shows the snapshot and carries
//! out the effects. The UI's main thread only sends inputs and never waits for this thread; process output arrives on
//! reader threads that only send inputs too; Tauri calls made from here hop to the main thread, which is free.
//!
//! The model's contract: every [`Effect::CheckCli`] is answered by exactly one [`Input::CliChecked`] and every
//! [`Effect::RunAction`] by exactly one [`Input::ActionDone`], whatever fails (an [`Answer`] makes sure of it).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::{self, Paths, TrayConfig};
use crate::lock;
use crate::process::{self, CliProcess, Output, Sink};
use crate::protocol::{parse_event, parse_watch_line, WorkerEvent};
use crate::state::{Effect, Input, Model, Snapshot};

/// How long a killed process is awaited before the tray goes on without it.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// How long Quit lets the worker end by itself once it reported `stopped` (within the quit wait).
const AFTER_STOPPED: Duration = Duration::from_secs(2);
/// How long the queue reader gets to end by itself once its input is closed.
const WATCH_END: Duration = Duration::from_secs(2);

/// What the controller shows and asks of the desktop.
pub trait Ui: Send + Sync + 'static {
    fn render(&self, snapshot: &Snapshot);
    fn notify(&self, title: &str, body: &str);
    fn show_window(&self);
    fn exit(&self);
}

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// How often [`Input::Tick`] comes.
    pub tick: Duration,
    /// How long Quit waits for the worker to give its job back (spec 06 4.5).
    pub quit_wait: Duration,
    /// How long a `fornax queue move|cancel|pause|resume` may take (spec 06 4.7).
    pub action_timeout: Duration,
    pub version_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { tick: Duration::from_secs(1), quit_wait: Duration::from_secs(15), action_timeout: Duration::from_secs(30), version_timeout: Duration::from_secs(15) }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One input owed to the controller: the first [`Answer::send`] goes out, later ones are dropped, and an answer
/// dropped unsent (its thread panicked or never started) sends its fallback.
struct Answer {
    tx: Sender<Input>,
    fallback: Mutex<Option<Input>>,
}

impl Answer {
    fn new(tx: &Sender<Input>, fallback: Input) -> Answer {
        Answer { tx: tx.clone(), fallback: Mutex::new(Some(fallback)) }
    }

    fn send(&self, input: Input) {
        if guard(&self.fallback).take().is_some() {
            let _ = self.tx.send(input);
        }
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        if let Some(fallback) = self.fallback.get_mut().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = self.tx.send(fallback);
        }
    }
}

/// A handle to the controller's thread; cheap to call from any thread.
pub struct Controller {
    tx: Sender<Input>,
    latest: Arc<Mutex<Snapshot>>,
}

impl Controller {
    /// Start the controller thread and the ticker. `warning` (e.g. Redirection Guard) shows in the window; a broken
    /// tray.json does too, and the defaults are used.
    pub fn start(paths: Paths, ui: Arc<dyn Ui>, timing: Timing, warning: Option<String>) -> Controller {
        let (tx, rx) = mpsc::channel();
        let latest = Arc::new(Mutex::new(Model::new().snapshot()));
        let (start_worker, config_warning) = match config::load(&paths) {
            Ok(cfg) => (cfg.start_worker, None),
            Err(message) => (true, Some(message)),
        };
        let _ = tx.send(Input::Launched { start_worker, warning: warning.or(config_warning) });
        {
            let runner = Runner::new(paths, tx.clone(), ui, timing);
            let latest = Arc::clone(&latest);
            thread::Builder::new().name("fornax controller".into()).spawn(move || run(rx, runner, &latest)).expect("the controller thread starts");
        }
        {
            let tx = tx.clone();
            thread::Builder::new()
                .name("fornax ticker".into())
                .spawn(move || loop {
                    thread::sleep(timing.tick);
                    if tx.send(Input::Tick).is_err() {
                        return;
                    }
                })
                .expect("the ticker starts");
        }
        Controller { tx, latest }
    }

    /// False when the controller thread is gone (it panicked): nothing then acts on the input.
    pub fn send(&self, input: Input) -> bool {
        self.tx.send(input).is_ok()
    }

    /// What the tray shows now (the window's first paint, the menu's pause item).
    pub fn snapshot(&self) -> Snapshot {
        guard(&self.latest).clone()
    }
}

/// The tray's worker process, and whether it reported `stopped` (set by its sink, read by Quit).
struct Worker {
    process: Arc<CliProcess>,
    stopped: Arc<AtomicBool>,
}

/// tray.json as it is now; a broken one gives the defaults (the window was told why at start).
fn settings(paths: &Paths) -> TrayConfig {
    config::load(paths).unwrap_or_else(|_| config::defaults(paths))
}

/// The controller's loop: every input in order, the snapshot shown, then the effects carried out.
fn run(rx: Receiver<Input>, mut runner: Runner, latest: &Mutex<Snapshot>) {
    let mut model = Model::new();
    for input in rx {
        runner.seen(&input);
        let effects = model.apply(input, now_ms());
        let snapshot = model.snapshot();
        *guard(latest) = snapshot.clone();
        runner.ui.render(&snapshot);
        for effect in effects {
            runner.carry_out(effect);
        }
    }
}

/// Carries out the model's effects with real processes and keeps the processes they started.
struct Runner {
    paths: Paths,
    tx: Sender<Input>,
    ui: Arc<dyn Ui>,
    timing: Timing,
    worker: Option<Worker>,
    watch: Option<Arc<CliProcess>>,
}

impl Runner {
    fn new(paths: Paths, tx: Sender<Input>, ui: Arc<dyn Ui>, timing: Timing) -> Runner {
        Runner { paths, tx, ui, timing, worker: None, watch: None }
    }

    /// Forget a process once its end is applied. The model starts no other one before it saw that end, so the end
    /// always belongs to the process kept here (or to one Quit took already).
    fn seen(&mut self, input: &Input) {
        match input {
            Input::WorkerExited { .. } => self.worker = None,
            Input::WatchExited => self.watch = None,
            _ => {}
        }
    }

    fn carry_out(&mut self, effect: Effect) {
        match effect {
            Effect::CheckCli => check_cli(&self.paths, &self.tx, self.timing.version_timeout),
            Effect::SpawnWorker => match spawn_worker(&self.paths, &self.tx) {
                Ok(w) => self.worker = Some(w),
                Err(message) => {
                    let _ = self.tx.send(Input::WorkerSpawnFailed(message));
                }
            },
            // Without a worker (it could not start, or it ended and its end is not applied yet) there is nothing to
            // stop; a worker that ended has a closed input, and the stop is dropped.
            Effect::SendStop => {
                if let Some(w) = &self.worker {
                    w.process.send_stop();
                }
            }
            Effect::KillWorker => {
                if let Some(w) = &self.worker {
                    w.process.kill_tree();
                }
            }
            Effect::SpawnWatch => match spawn_watch(&self.paths, &self.tx) {
                Ok(p) => self.watch = Some(p),
                Err(message) => {
                    let _ = self.tx.send(Input::WatchSpawnFailed(message));
                }
            },
            Effect::RunAction { key, args } => run_action(&self.paths, &self.tx, key, args, self.timing.action_timeout),
            Effect::CheckLock => {
                let _ = self.tx.send(Input::LockChecked { held: lock::held(&self.paths.lock(), SystemTime::now()) });
            }
            Effect::Notify { title, body } => self.ui.notify(&title, &body),
            Effect::ShowWindow => self.ui.show_window(),
            Effect::SaveStartWorker(on) => {
                if let Err(message) = config::save_start_worker(&self.paths, on) {
                    let _ = self.tx.send(Input::Warning(message));
                }
            }
            Effect::ExitAfterStop => {
                let (w, r, ui, wait) = (self.worker.take(), self.watch.take(), Arc::clone(&self.ui), self.timing.quit_wait);
                // On a thread of its own: the controller keeps taking the worker's output meanwhile.
                let waiting = thread::Builder::new().name("fornax quit".into()).spawn(move || {
                    if let Some(w) = w {
                        quit_worker(&w, wait);
                    }
                    end_watch(r);
                    ui.exit();
                });
                if waiting.is_err() {
                    // Without the thread nobody waits: exit now; the worker stops when its input closes.
                    self.ui.exit();
                }
            }
            Effect::Exit => {
                end_watch(self.watch.take());
                self.ui.exit();
            }
        }
    }
}

/// Quit with the worker asked to stop: wait at most `wait` for it to end or report `stopped`, give it a moment to end
/// after `stopped` (still within `wait`), then end what is left by force.
fn quit_worker(w: &Worker, wait: Duration) {
    let deadline = Instant::now() + wait;
    let mut ended = false;
    while !ended && !w.stopped.load(Ordering::SeqCst) && Instant::now() < deadline {
        ended = w.process.wait_exit(Duration::from_millis(50));
    }
    let grace = if w.stopped.load(Ordering::SeqCst) { AFTER_STOPPED.min(deadline.saturating_duration_since(Instant::now())) } else { Duration::ZERO };
    if !ended && !w.process.wait_exit(grace) {
        w.process.kill_tree();
        w.process.wait_exit(KILL_WAIT);
    }
}

/// The queue reader ends when its input closes (spec 06 3.1); one that does not is ended by force.
fn end_watch(watch: Option<Arc<CliProcess>>) {
    if let Some(p) = watch {
        p.close_input();
        if !p.wait_exit(WATCH_END) {
            p.kill_tree();
            p.wait_exit(KILL_WAIT);
        }
    }
}

fn spawn_worker(paths: &Paths, tx: &Sender<Input>) -> Result<Worker, String> {
    let cfg = settings(paths);
    process::check_cli(&cfg)?;
    let stopped = Arc::new(AtomicBool::new(false));
    let (tx, seen) = (tx.clone(), Arc::clone(&stopped));
    // The sink runs on the process's reader threads and must never block: it only sends on an unbounded channel.
    let sink: Sink = Arc::new(move |out: Output| {
        let _ = tx.send(match out {
            Output::Stdout(line) => match parse_event(&line) {
                Some(event) => {
                    if matches!(event, WorkerEvent::Stopped { .. }) {
                        seen.store(true, Ordering::SeqCst);
                    }
                    Input::WorkerEvent(event)
                }
                None => Input::WorkerText(line),
            },
            Output::Stderr(line) => Input::WorkerText(line),
            Output::Exited(code) => Input::WorkerExited { code },
        });
    });
    let process = CliProcess::start(process::command(&cfg, &["worker", "--events"]), sink).map_err(|e| process::spawn_error(&cfg, &e))?;
    Ok(Worker { process, stopped })
}

fn spawn_watch(paths: &Paths, tx: &Sender<Input>) -> Result<Arc<CliProcess>, String> {
    let cfg = settings(paths);
    process::check_cli(&cfg)?;
    let tx = tx.clone();
    let sink: Sink = Arc::new(move |out: Output| {
        let _ = tx.send(match out {
            Output::Stdout(line) => match parse_watch_line(&line) {
                Some(watch) => Input::Watch(watch),
                None => Input::WatchText(line),
            },
            Output::Stderr(line) => Input::WatchText(line),
            Output::Exited(_) => Input::WatchExited,
        });
    });
    CliProcess::start(process::command(&cfg, &["queue", "--json", "--watch"]), sink).map_err(|e| process::spawn_error(&cfg, &e))
}

/// The lines and exit code of a short command.
struct TextRun {
    stdout: Vec<String>,
    stderr: Vec<String>,
    code: Option<i32>,
}

/// Run `fornax <args>` to its end, at most `timeout` (then it is ended and the answer says so).
fn run_text(cfg: &TrayConfig, args: &[&str], timeout: Duration) -> Result<TextRun, String> {
    process::check_cli(cfg)?;
    let seen = Arc::new(Mutex::new(TextRun { stdout: Vec::new(), stderr: Vec::new(), code: None }));
    let sink: Sink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |out: Output| {
            let mut s = guard(&seen);
            match out {
                Output::Stdout(line) => s.stdout.push(line),
                Output::Stderr(line) => s.stderr.push(line),
                Output::Exited(code) => s.code = code,
            }
        })
    };
    let p = CliProcess::start(process::command(cfg, args), sink).map_err(|e| process::spawn_error(cfg, &e))?;
    p.close_input();
    if !p.wait_exit(timeout) {
        p.kill_tree();
        p.wait_exit(KILL_WAIT);
        return Err(format!("fornax {} did not finish within {} s", args.join(" "), timeout.as_secs()));
    }
    let s = guard(&seen);
    Ok(TextRun { stdout: s.stdout.clone(), stderr: s.stderr.clone(), code: s.code })
}

/// The sentence of a command that failed: its last stderr line (the CLI's contract), else its last stdout line.
fn failure(args: &[&str], r: &TextRun) -> String {
    r.stderr.last().or(r.stdout.last()).cloned().unwrap_or_else(|| {
        let code = r.code.map_or_else(|| "?".to_string(), |c| c.to_string());
        format!("fornax {} ended with code {code}", args.join(" "))
    })
}

/// `fornax --version` and the lock, on a thread of its own; always answered with one [`Input::CliChecked`].
fn check_cli(paths: &Paths, tx: &Sender<Input>, timeout: Duration) {
    let paths = paths.clone();
    let answer = Answer::new(tx, Input::CliChecked { result: Err("the check of fornax ended without an answer".into()), lock_held: false });
    let _ = thread::Builder::new().name("fornax version".into()).spawn(move || {
        let args = ["--version"];
        let result = match run_text(&settings(&paths), &args, timeout) {
            Ok(r) if r.code == Some(0) => r.stdout.first().cloned().ok_or_else(|| "fornax --version printed nothing: run fornax update".to_string()),
            Ok(r) => Err(failure(&args, &r)),
            Err(message) => Err(message),
        };
        answer.send(Input::CliChecked { result, lock_held: lock::held(&paths.lock(), SystemTime::now()) });
    });
}

/// `fornax queue move|cancel|pause|resume …` on a thread of its own; always answered with one [`Input::ActionDone`],
/// also when it ran out of time (it is then ended) or could not start.
fn run_action(paths: &Paths, tx: &Sender<Input>, key: String, args: Vec<String>, timeout: Duration) {
    let paths = paths.clone();
    let answer = Answer::new(tx, Input::ActionDone { key: key.clone(), result: Err("the action ended without an answer".into()) });
    let _ = thread::Builder::new().name("fornax action".into()).spawn(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = match run_text(&settings(&paths), &refs, timeout) {
            Ok(r) if r.code == Some(0) => Ok(()),
            Ok(r) => Err(failure(&refs, &r)),
            Err(message) => Err(message),
        };
        answer.send(Input::ActionDone { key, result });
    });
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::process::testing::{alive, fake_cli, set_version, watch_starts, Fake};
    use crate::state::{Icon, MoveTo};

    #[derive(Default)]
    struct Recorder {
        snapshots: Mutex<Vec<Snapshot>>,
        notes: Mutex<Vec<(String, String)>>,
        windows: AtomicUsize,
        exited: AtomicBool,
    }

    impl Ui for Recorder {
        fn render(&self, s: &Snapshot) {
            guard(&self.snapshots).push(s.clone());
        }
        fn notify(&self, title: &str, body: &str) {
            guard(&self.notes).push((title.into(), body.into()));
        }
        fn show_window(&self) {
            self.windows.fetch_add(1, Ordering::SeqCst);
        }
        fn exit(&self) {
            self.exited.store(true, Ordering::SeqCst);
        }
    }

    fn timing() -> Timing {
        Timing { tick: Duration::from_millis(50), quit_wait: Duration::from_secs(1), action_timeout: Duration::from_secs(2), version_timeout: Duration::from_secs(15) }
    }

    fn start(fake: &Fake) -> (Arc<Recorder>, Controller) {
        start_with(fake, timing())
    }

    fn start_with(fake: &Fake, timing: Timing) -> (Arc<Recorder>, Controller) {
        let ui = Arc::new(Recorder::default());
        let ctl = Controller::start(fake.paths.clone(), ui.clone(), timing, None);
        (ui, ctl)
    }

    fn wait_for(ui: &Recorder, what: &str, ok: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(s) = guard(&ui.snapshots).last().filter(|s| ok(s)).cloned() {
                return s;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}: {:?}", guard(&ui.snapshots).last());
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Wait at most `limit` for `ok`.
    fn until(what: &str, limit: Duration, ok: impl Fn() -> bool) {
        let deadline = Instant::now() + limit;
        while !ok() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn no_worker_at_start(fake: &Fake) {
        fs::create_dir_all(&fake.paths.config).unwrap();
        fs::write(fake.paths.tray_json(), r#"{ "start_worker": false }"#).unwrap();
    }

    fn ctl_last(ui: &Recorder) -> Snapshot {
        guard(&ui.snapshots).last().cloned().unwrap()
    }

    #[test]
    fn starts_reads_the_queue_and_stops_the_worker() {
        let fake = fake_cli("ok");
        let (ui, ctl) = start(&fake);
        let s = wait_for(&ui, "the worker running with the queue", |s| s.headline == "Worker running · queue active");
        assert_eq!(s.queued.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), ["Q1", "Q2"]);
        assert!(ctl.send(Input::StopWorker));
        wait_for(&ui, "the worker stopped", |s| s.headline == "Worker stopped · queue active" && s.note.is_none());
        assert_eq!(ctl.snapshot().headline, "Worker stopped · queue active");
    }

    #[test]
    fn an_old_fornax_starts_nothing() {
        let fake = fake_cli("ok");
        set_version(&fake, "0.4.1");
        let (ui, _ctl) = start(&fake);
        let s = wait_for(&ui, "the note", |s| s.note.is_some());
        assert_eq!(s.note.as_deref(), Some("fornax 0.4.1 is too old for the tray: run fornax update"));
        thread::sleep(Duration::from_millis(300));
        let s = ctl_last(&ui);
        assert!(!s.can_start && !s.queue_known);
        assert_eq!(watch_starts(&fake), 0);
    }

    #[test]
    fn a_missing_fornax_says_so() {
        let fake = fake_cli("ok");
        fs::remove_file(fake.paths.cli()).unwrap();
        let (ui, _ctl) = start(&fake);
        let s = wait_for(&ui, "the note", |s| s.note.is_some());
        assert_eq!(s.note.as_deref(), Some(crate::process::NOT_INSTALLED));
    }

    #[test]
    fn start_worker_false_in_tray_json_only_reads_the_queue() {
        let fake = fake_cli("ok");
        no_worker_at_start(&fake);
        let (ui, _ctl) = start(&fake);
        wait_for(&ui, "the queue", |s| s.queue_known);
        thread::sleep(Duration::from_millis(500));
        let s = ctl_last(&ui);
        assert_eq!(s.headline, "Worker stopped · queue active");
        assert!(s.can_start && !s.start_worker);
    }

    /// Spec 06 § 7 (crash): the worker's last line says why it ended; it can be started again.
    #[test]
    fn a_worker_that_crashes_shows_its_last_line() {
        let fake = fake_cli("ok crash");
        let (ui, _ctl) = start(&fake);
        let s = wait_for(&ui, "the worker's end and the queue", |s| s.note.is_some() && s.can_start && s.queue_known);
        // Its stdout and stderr are read on two threads, so either line can come last.
        assert!(matches!(s.note.as_deref(), Some("something broke" | "Error: boom")), "{:?}", s.note);
        assert_eq!(s.headline, "Worker stopped · queue active");
    }

    /// Ruling 2: another worker holds the lock, so the tray's worker ends at once and says so; Start is offered again.
    #[test]
    fn a_worker_locked_out_by_another_says_so() {
        let fake = fake_cli("ok locked");
        let (ui, _ctl) = start(&fake);
        let s = wait_for(&ui, "the worker's end", |s| s.note.is_some() && s.can_start);
        assert_eq!(s.note.as_deref(), Some("another fornax worker runs on this PC (pid 1); stop it first"));
        assert!(s.headline.starts_with("Worker stopped"), "{}", s.headline);
    }

    /// Spec 06 § 7 (server unreachable), ruling 2: the reader's failure line shows as an unreachable server.
    #[test]
    fn an_unreachable_server_is_shown_with_its_time() {
        let fake = fake_cli("ok down");
        no_worker_at_start(&fake);
        let (ui, ctl) = start(&fake);
        let s = wait_for(&ui, "the server down", |s| s.server_down_since_ms.is_some());
        assert_eq!(s.icon, Icon::Error);
        assert_eq!(s.server_message.as_deref(), Some("cannot reach the server: ECONNREFUSED"));
        assert_eq!(s.queue_note.as_deref(), Some("The queue cannot be read: cannot reach the server: ECONNREFUSED"));
        assert!(!s.server_refused && !s.can_pause);
        let json = serde_json::to_value(ctl.snapshot()).unwrap();
        assert!(json["serverDownSinceMs"].is_i64(), "{json}");
    }

    /// Ruling 3: a reader that fails before its first queue line says why.
    #[test]
    fn a_reader_that_fails_before_its_first_line_says_why() {
        let fake = fake_cli("ok unpaired");
        no_worker_at_start(&fake);
        let (ui, _ctl) = start(&fake);
        let s = wait_for(&ui, "the queue note", |s| s.queue_note.as_deref().is_some_and(|n| n.starts_with("The queue cannot be read")));
        assert_eq!(s.queue_note.as_deref(), Some("The queue cannot be read: this computer is not paired as a worker (fornax worker pair)"));
        assert!(!s.queue_known);
    }

    #[test]
    fn a_failed_action_shows_the_servers_sentence_next_to_its_job() {
        let fake = fake_cli("ok failaction");
        no_worker_at_start(&fake);
        let (ui, ctl) = start(&fake);
        wait_for(&ui, "the queue", |s| s.queue_known);
        ctl.send(Input::Move { id: "Q2".into(), to: MoveTo::Top });
        wait_for(&ui, "the error", |s| s.queued.get(1).and_then(|j| j.action_error.as_deref()) == Some("job Q2 is running now; only waiting jobs move"));
    }

    #[test]
    fn an_action_that_hangs_is_ended_after_its_time_limit() {
        let fake = fake_cli("ok slowaction");
        no_worker_at_start(&fake);
        let (ui, ctl) = start(&fake);
        wait_for(&ui, "the queue", |s| s.queue_known);
        ctl.send(Input::Cancel { id: "Q1".into() });
        let s = wait_for(&ui, "the time limit", |s| s.queued.first().and_then(|j| j.action_error.clone()).is_some());
        assert_eq!(s.queued[0].action_error.as_deref(), Some("fornax queue cancel Q1 did not finish within 2 s"));
        assert!(!s.queued[0].pending);
    }

    #[test]
    fn the_reader_is_started_again_after_it_ended() {
        let fake = fake_cli("ok watch-exit");
        no_worker_at_start(&fake);
        let (ui, _ctl) = start(&fake);
        wait_for(&ui, "the queue", |s| s.queue_known);
        until("the reader started again", Duration::from_secs(10), || watch_starts(&fake) >= 2);
    }

    /// Review Focus 1: Quit ends a worker that ignores stop after the quit wait, with what it started, and exits.
    #[test]
    fn quit_ends_a_worker_that_ignores_stop() {
        let fake = fake_cli("ok stubborn grandchild");
        let (ui, ctl) = start(&fake);
        let s = wait_for(&ui, "the worker running", |s| s.headline.starts_with("Worker running") && s.log.iter().any(|l| l.text.starts_with("grandchild ")));
        let line = s.log.iter().find_map(|l| l.text.strip_prefix("grandchild ")).unwrap();
        let grandchild: u32 = line.trim().parse().expect("the grandchild's pid");
        assert!(alive(grandchild));
        ctl.send(Input::Quit);
        wait_for(&ui, "the question", |s| s.confirm_quit);
        // The snapshot is shown before the window is: wait for it.
        until("the window", Duration::from_secs(5), || ui.windows.load(Ordering::SeqCst) == 1);
        let asked = Instant::now();
        ctl.send(Input::ConfirmQuit(true));
        until("the exit", Duration::from_secs(15), || ui.exited.load(Ordering::SeqCst));
        assert!(asked.elapsed() >= Duration::from_millis(900), "the worker got the quit wait first: {:?}", asked.elapsed());
        until("the grandchild's end", Duration::from_secs(5), || !alive(grandchild));
        assert_eq!(ui.windows.load(Ordering::SeqCst), 1);
    }

    /// Ruling 4: Quit waits only as long as a worker that obeys stop needs, not the whole quit wait.
    #[test]
    fn quit_exits_as_soon_as_the_worker_stopped() {
        let fake = fake_cli("ok");
        let (ui, ctl) = start_with(&fake, Timing { quit_wait: Duration::from_secs(15), ..timing() });
        wait_for(&ui, "the worker running", |s| s.headline.starts_with("Worker running"));
        ctl.send(Input::Quit);
        wait_for(&ui, "the question", |s| s.confirm_quit);
        let asked = Instant::now();
        ctl.send(Input::ConfirmQuit(true));
        until("the exit", Duration::from_secs(15), || ui.exited.load(Ordering::SeqCst));
        assert!(asked.elapsed() < Duration::from_secs(8), "{:?}", asked.elapsed());
    }

    #[test]
    fn quit_with_the_worker_stopped_exits_at_once() {
        let fake = fake_cli("ok");
        no_worker_at_start(&fake);
        let (ui, ctl) = start(&fake);
        wait_for(&ui, "the queue", |s| s.queue_known);
        ctl.send(Input::Quit);
        until("the exit", Duration::from_secs(10), || ui.exited.load(Ordering::SeqCst));
        assert_eq!(ui.windows.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_setting_is_saved() {
        let fake = fake_cli("ok");
        no_worker_at_start(&fake);
        let (ui, ctl) = start(&fake);
        wait_for(&ui, "the queue", |s| s.queue_known);
        ctl.send(Input::SetStartWorker(true));
        wait_for(&ui, "the setting", |s| s.start_worker);
        until("tray.json written", Duration::from_secs(5), || crate::config::load(&fake.paths).is_ok_and(|c| c.start_worker));
    }

    fn runner(fake: &Fake) -> (Runner, Receiver<Input>) {
        let (tx, rx) = mpsc::channel();
        (Runner::new(fake.paths.clone(), tx, Arc::new(Recorder::default()), timing()), rx)
    }

    /// The next input that `pick` takes, within 15 s.
    fn next_of<T>(rx: &Receiver<Input>, mut pick: impl FnMut(Input) -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let input = rx.recv_timeout(left).expect("the input in time");
            if let Some(found) = pick(input) {
                return found;
            }
        }
    }

    /// Ruling 4: a stop (or a kill) before the worker exists, or after it ended, does nothing.
    #[test]
    fn stopping_a_worker_that_is_not_there_is_harmless() {
        let fake = fake_cli("crash");
        let (mut r, rx) = runner(&fake);
        r.carry_out(Effect::SendStop);
        r.carry_out(Effect::KillWorker);
        r.carry_out(Effect::SpawnWorker);
        let code = next_of(&rx, |i| match i {
            Input::WorkerExited { code } => Some(code),
            _ => None,
        });
        assert_eq!(code, Some(1));
        // Ended, but the controller has not applied its end yet.
        r.carry_out(Effect::SendStop);
        r.carry_out(Effect::KillWorker);
        r.seen(&Input::WorkerExited { code });
        assert!(r.worker.is_none());
        r.carry_out(Effect::SendStop);
        r.carry_out(Effect::KillWorker);
    }

    /// Ruling 4: an action that cannot even run is still answered, so its job does not stay pending.
    #[test]
    fn an_action_without_fornax_is_answered() {
        let fake = fake_cli("ok");
        fs::remove_file(fake.paths.cli()).unwrap();
        let (mut r, rx) = runner(&fake);
        r.carry_out(Effect::RunAction { key: "Q1".into(), args: vec!["queue".into(), "cancel".into(), "Q1".into()] });
        let done = next_of(&rx, |i| match i {
            Input::ActionDone { key, result } => Some((key, result)),
            _ => None,
        });
        assert_eq!(done, ("Q1".to_string(), Err(crate::process::NOT_INSTALLED.to_string())));
    }

    #[test]
    fn an_answer_goes_out_once_and_a_lost_one_sends_its_fallback() {
        let (tx, rx) = mpsc::channel();
        let answer = Answer::new(&tx, Input::Tick);
        answer.send(Input::StopWorker);
        answer.send(Input::StartWorker);
        drop(answer);
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), [Input::StopWorker]);
        drop(Answer::new(&tx, Input::Tick));
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), [Input::Tick]);
        // An answer whose thread panicked before it answered.
        let lost = Answer::new(&tx, Input::Tick);
        let failed = thread::spawn(move || {
            let _lost = lost;
            std::panic::resume_unwind(Box::new("the action thread failed"));
        });
        assert!(failed.join().is_err());
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), [Input::Tick]);
    }
}
