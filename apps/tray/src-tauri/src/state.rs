//! The tray's model (spec 06 § 4): inputs change it in order and may ask for effects; the snapshot is what the window
//! and the tray icon show. Pure: no threads, clocks or processes (controller.rs has them), so every rule is a test.

use std::collections::{BTreeSet, VecDeque};

use serde::Serialize;

use crate::protocol::{iso_ms, version_of, Job, Queue, WatchLine, WorkerEvent, MIN_CLI};

/// Lines of the log the window keeps.
pub const LOG_LINES: usize = 200;
/// Windows cuts a tray tooltip at 127 UTF-16 units.
pub const TOOLTIP_UNITS: usize = 127;
/// After the second stop the worker gets this long before the tray ends it (spec 06 4.5).
pub const SECOND_STOP_WAIT_MS: i64 = 10_000;
/// How long a failed action's sentence stays next to its job (spec 06 4.2).
pub const ACTION_ERROR_MS: i64 = 10_000;
/// How often worker.lock is checked (spec 06 4.5).
pub const LOCK_EVERY_MS: i64 = 15_000;
/// Pauses before `fornax queue --watch` starts again after it ended (spec 06 4.5); the last one repeats.
pub const WATCH_RETRY_MS: [i64; 4] = [2_000, 5_000, 10_000, 30_000];
/// Characters of a failed job's error in its notification (spec 06 4.4).
pub const ERROR_CHARS: usize = 120;
/// The key of the pause action; job actions use the job's id.
pub const PAUSE: &str = "pause";
/// Spec 06 § 5: what the window says when the server refuses the worker token (401/403).
pub const TOKEN_REFUSED: &str = "The server refused the worker token: pair again (fornax worker pair)";

/// Where a waiting job moves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MoveTo {
    Top,
    Bottom,
    Before(String),
    After(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// The tray started, with its setting and the warnings to show (Redirection Guard, tray.json).
    Launched { start_worker: bool, warnings: Vec<String> },
    /// `fornax --version` answered (its line) or could not run (why), and whether worker.lock is held.
    CliChecked { result: Result<String, String>, lock_held: bool },
    StartWorker,
    StopWorker,
    SetPaused(bool),
    Move { id: String, to: MoveTo },
    Cancel { id: String },
    SetStartWorker(bool),
    Quit,
    ConfirmQuit(bool),
    WorkerEvent(WorkerEvent),
    /// A worker line that is no event, or its stderr.
    WorkerText(String),
    WorkerExited { code: Option<i32> },
    WorkerSpawnFailed(String),
    Watch(WatchLine),
    /// A line of the queue reader that is no queue line, or its stderr.
    WatchText(String),
    WatchExited,
    WatchSpawnFailed(String),
    /// The answer to a [`Effect::RunAction`]; main.rs also sends a failed one for a result page that did not open.
    ActionDone { key: String, result: Result<(), String> },
    LockChecked { held: bool },
    Warning(String),
    /// Every second: deadlines, the reader's restart, the lock check, old action errors.
    Tick,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    CheckCli,
    SpawnWorker,
    SendStop,
    KillWorker,
    SpawnWatch,
    RunAction { key: String, args: Vec<String> },
    CheckLock,
    Notify { title: String, body: String },
    ShowWindow,
    SaveStartWorker(bool),
    /// Quit once the worker that was asked to stop ended (at most the quit wait, then by force).
    ExitAfterStop,
    Exit,
}

/// The tray's own worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Own {
    Stopped,
    Starting,
    Running,
    Restarting,
    /// One stop sent.
    Stopping,
    /// The second stop sent: ended by force after [`SECOND_STOP_WAIT_MS`].
    StoppingNow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Cli {
    Unchecked,
    Ready,
    Problem(String),
}

/// The queue reader (`fornax queue --json --watch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Watch {
    Off,
    Running,
    Waiting { retry_at: i64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Icon {
    Stopped,
    Attention,
    Idle,
    Busy,
    Paused,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub at_ms: i64,
    pub text: String,
    pub error: bool,
}

/// One job for the window: names worked out, times in milliseconds of the server's clock.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub owner: String,
    pub what: String,
    pub state: String,
    pub priority: String,
    pub type_unavailable: bool,
    pub retry_at_ms: Option<i64>,
    pub created_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub progress: Option<f64>,
    pub progress_message: Option<String>,
    pub error: Option<String>,
    pub result_url: String,
    /// An action of this job runs.
    pub pending: bool,
    /// The sentence of its last failed action, for 10 s.
    pub action_error: Option<String>,
}

/// What the window and the tray show (src/types.ts mirrors it).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub icon: Icon,
    pub tooltip: String,
    pub headline: String,
    pub note: Option<String>,
    pub can_start: bool,
    pub can_stop: bool,
    pub stop_label: String,
    pub can_pause: bool,
    pub paused: bool,
    pub pause_label: String,
    pub pause_error: Option<String>,
    pub start_worker: bool,
    pub confirm_quit: bool,
    pub queue_known: bool,
    pub queue_note: Option<String>,
    pub server_down_since_ms: Option<i64>,
    pub server_message: Option<String>,
    /// The last failure was a refused worker token (401/403): the window shows `server_message` on its own, not under
    /// "Server unreachable since …" (spec 06 § 5).
    pub server_refused: bool,
    /// Server time minus the PC's time at the last queue line: the window corrects its clock by it.
    pub offset_ms: i64,
    pub running: Option<JobView>,
    pub queued: Vec<JobView>,
    pub finished: Vec<JobView>,
    pub log: Vec<LogLine>,
}

/// The queue reader's failures (`"ok": false` lines) since its last queue line.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Down {
    since: i64,
    message: String,
    /// The last failure was `auth`.
    refused: bool,
}

#[derive(Debug)]
pub struct Model {
    own: Own,
    stop_deadline: Option<i64>,
    /// Why the tray's worker ended by itself, or could not start.
    exit_note: Option<String>,
    last_line: Option<String>,
    /// worker.lock is held while the tray's own worker is stopped.
    external: bool,
    cli: Cli,
    start_worker: bool,
    /// Start the worker once fornax is found ready (the setting at launch); kept until it is.
    auto_start: bool,
    /// A check of fornax runs (one at a time).
    cli_checking: bool,
    /// Every warning to show, once each (Redirection Guard, tray.json).
    warnings: Vec<String>,
    watch: Watch,
    watch_failures: usize,
    queue: Option<Queue>,
    offset_ms: i64,
    /// Since when and why the queue cannot be read.
    server_down: Option<Down>,
    /// The reader's last line that was no queue line (its stderr), since the last queue line.
    watch_text: Option<String>,
    /// Why the queue reader ended without a queue line (spec 06 4.2: the sections say why), until a queue line.
    watch_problem: Option<String>,
    pending: BTreeSet<String>,
    action_errors: Vec<(String, String, i64)>,
    seen_failed: BTreeSet<String>,
    queue_seen: bool,
    wave_told: bool,
    /// When the lock is checked next while fornax is ready, or fornax again while it has a problem.
    next_check: i64,
    confirm_quit: bool,
    quitting: bool,
    log: VecDeque<LogLine>,
}

impl Default for Model {
    fn default() -> Self {
        Model::new()
    }
}

/// At most `max` characters; a cut text ends with "…".
fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push('…');
    cut
}

/// At most `max` UTF-16 units (a Windows tooltip).
fn clip_utf16(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

fn owner_of(j: &Job) -> String {
    j.owner.clone().unwrap_or_else(|| "?".to_string())
}

/// What a job works on: its label, else its first input's file name, else its group.
fn what_of(j: &Job) -> String {
    j.label.clone().or_else(|| j.inputs.values().flatten().next().cloned()).or_else(|| j.group.clone()).unwrap_or_default()
}

/// Whether a line of text can say why a process ended. Node's crash output ends with its version (`Node.js v22.16.0`)
/// after the stack frames (`    at …`) and the error's indented properties closed by `}`: the reason is the line
/// before them.
fn is_reason(line: &str) -> bool {
    let footer = line.strip_prefix("Node.js v").is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
    !footer && !line.starts_with(char::is_whitespace) && line.trim() != "}"
}

impl Model {
    pub fn new() -> Self {
        Model {
            own: Own::Stopped,
            stop_deadline: None,
            exit_note: None,
            last_line: None,
            external: false,
            cli: Cli::Unchecked,
            start_worker: true,
            auto_start: false,
            cli_checking: false,
            warnings: Vec::new(),
            watch: Watch::Off,
            watch_failures: 0,
            queue: None,
            offset_ms: 0,
            server_down: None,
            watch_text: None,
            watch_problem: None,
            pending: BTreeSet::new(),
            action_errors: Vec::new(),
            seen_failed: BTreeSet::new(),
            queue_seen: false,
            wave_told: false,
            next_check: 0,
            confirm_quit: false,
            quitting: false,
            log: VecDeque::new(),
        }
    }

    pub fn apply(&mut self, input: Input, now: i64) -> Vec<Effect> {
        match input {
            Input::Launched { start_worker, warnings } => {
                self.start_worker = start_worker;
                self.auto_start = start_worker;
                for text in warnings {
                    self.warn(now, text);
                }
                self.cli_checking = true;
                vec![Effect::CheckCli]
            }
            Input::CliChecked { result, lock_held } => self.cli_checked(result, lock_held, now),
            Input::StartWorker => {
                if self.can_start() {
                    self.start(now)
                } else {
                    Vec::new()
                }
            }
            Input::StopWorker => self.stop(now),
            Input::SetPaused(paused) => self.action(PAUSE.to_string(), vec!["queue".into(), if paused { "pause" } else { "resume" }.into()]),
            Input::Move { id, to } => {
                let mut args = vec!["queue".to_string(), "move".into(), id.clone()];
                match to {
                    MoveTo::Top => args.push("--top".into()),
                    MoveTo::Bottom => args.push("--bottom".into()),
                    MoveTo::Before(other) => args.extend(["--before".to_string(), other]),
                    MoveTo::After(other) => args.extend(["--after".to_string(), other]),
                }
                self.action(id, args)
            }
            Input::Cancel { id } => self.action(id.clone(), vec!["queue".into(), "cancel".into(), id]),
            Input::SetStartWorker(on) => {
                self.start_worker = on;
                vec![Effect::SaveStartWorker(on)]
            }
            Input::Quit => self.quit(),
            Input::ConfirmQuit(yes) => self.confirm_quit(yes),
            Input::WorkerEvent(event) => {
                self.worker_event(event, now);
                Vec::new()
            }
            Input::WorkerText(line) => {
                if is_reason(&line) {
                    self.last_line = Some(line.clone());
                }
                self.push_log(now, line, true);
                Vec::new()
            }
            Input::WorkerExited { code } => {
                self.worker_exited(code, now);
                Vec::new()
            }
            Input::WorkerSpawnFailed(message) => {
                self.own = Own::Stopped;
                self.push_log(now, message.clone(), true);
                self.exit_note = Some(message);
                Vec::new()
            }
            Input::Watch(WatchLine::Queue(queue)) => self.queue_line(*queue, now),
            Input::Watch(WatchLine::Failed { error, message }) => {
                // Spec 06 § 5: a refused token is said as what to do.
                let refused = error == "auth";
                let message = if refused { TOKEN_REFUSED.to_string() } else { message };
                if self.server_down.is_none() {
                    self.push_log(now, format!("cannot read the queue: {message}"), true);
                }
                let since = self.server_down.as_ref().map_or(now, |down| down.since);
                self.server_down = Some(Down { since, message, refused });
                Vec::new()
            }
            Input::WatchText(line) => {
                if is_reason(&line) {
                    self.watch_text = Some(line.clone());
                }
                self.push_log(now, line, true);
                Vec::new()
            }
            Input::WatchExited => {
                self.watch_ended(now);
                Vec::new()
            }
            Input::WatchSpawnFailed(message) => {
                self.watch_text = Some(message.clone());
                self.push_log(now, message, true);
                self.watch_ended(now);
                Vec::new()
            }
            Input::ActionDone { key, result } => {
                self.pending.remove(&key);
                if let Err(message) = result {
                    self.push_log(now, message.clone(), true);
                    self.action_errors.retain(|(k, _, _)| *k != key);
                    self.action_errors.push((key, message, now + ACTION_ERROR_MS));
                }
                Vec::new()
            }
            Input::LockChecked { held } => {
                self.external = held && self.own == Own::Stopped;
                Vec::new()
            }
            Input::Warning(text) => {
                self.warn(now, text);
                Vec::new()
            }
            Input::Tick => self.tick(now),
        }
    }

    fn cli_checked(&mut self, result: Result<String, String>, lock_held: bool, now: i64) -> Vec<Effect> {
        self.external = lock_held && self.own == Own::Stopped;
        self.cli_checking = false;
        self.next_check = now + LOCK_EVERY_MS;
        self.cli = match result {
            Ok(text) => match version_of(&text) {
                Some(v) if v >= MIN_CLI => Cli::Ready,
                Some(_) => Cli::Problem(format!("fornax {} is too old for the tray: run fornax update", text.trim())),
                None => Cli::Problem(format!("fornax --version printed {:?}, not a version: run fornax update", clip_chars(text.trim(), 40))),
            },
            Err(message) => Cli::Problem(message),
        };
        // The start at sign-in waits for the first good check (tick checks again while there is a problem).
        if self.cli != Cli::Ready {
            return Vec::new();
        }
        let auto = std::mem::take(&mut self.auto_start);
        let mut effects = Vec::new();
        if self.watch == Watch::Off && !self.quitting {
            self.watch = Watch::Running;
            effects.push(Effect::SpawnWatch);
        }
        if auto && self.can_start() {
            effects.extend(self.start(now));
        }
        effects
    }

    fn can_start(&self) -> bool {
        self.own == Own::Stopped && !self.external && self.cli == Cli::Ready && !self.quitting
    }

    fn start(&mut self, now: i64) -> Vec<Effect> {
        self.own = Own::Starting;
        self.exit_note = None;
        self.last_line = None;
        self.push_log(now, "starting the worker".to_string(), false);
        vec![Effect::SpawnWorker]
    }

    fn stop(&mut self, now: i64) -> Vec<Effect> {
        match self.own {
            Own::Starting | Own::Running | Own::Restarting => {
                self.own = Own::Stopping;
                vec![Effect::SendStop]
            }
            Own::Stopping => {
                self.own = Own::StoppingNow;
                self.stop_deadline = Some(now + SECOND_STOP_WAIT_MS);
                vec![Effect::SendStop]
            }
            Own::StoppingNow | Own::Stopped => Vec::new(),
        }
    }

    /// Queue actions need a known queue and a server that answers (spec 06 § 5: while it is unreachable, or refuses the
    /// token, the last known queue is shown and its actions are inactive).
    fn can_act(&self) -> bool {
        self.cli == Cli::Ready && self.queue.is_some() && self.server_down.is_none() && !self.quitting
    }

    /// One action per key at a time, only while [`Model::can_act`].
    fn action(&mut self, key: String, args: Vec<String>) -> Vec<Effect> {
        if !self.can_act() || !self.pending.insert(key.clone()) {
            return Vec::new();
        }
        self.action_errors.retain(|(k, _, _)| *k != key);
        vec![Effect::RunAction { key, args }]
    }

    fn quit(&mut self) -> Vec<Effect> {
        if self.quitting {
            return Vec::new();
        }
        if self.own == Own::Stopped {
            self.quitting = true;
            return vec![Effect::Exit];
        }
        self.confirm_quit = true;
        vec![Effect::ShowWindow]
    }

    fn confirm_quit(&mut self, yes: bool) -> Vec<Effect> {
        if !self.confirm_quit {
            return Vec::new();
        }
        self.confirm_quit = false;
        if !yes {
            return Vec::new();
        }
        self.quitting = true;
        match self.own {
            Own::Stopped => vec![Effect::Exit],
            Own::Stopping | Own::StoppingNow => vec![Effect::ExitAfterStop],
            Own::Starting | Own::Running | Own::Restarting => {
                self.own = Own::Stopping;
                vec![Effect::SendStop, Effect::ExitAfterStop]
            }
        }
    }

    fn worker_event(&mut self, event: WorkerEvent, now: i64) {
        match event {
            WorkerEvent::Started { version, .. } => {
                if matches!(self.own, Own::Starting | Own::Restarting) {
                    self.own = Own::Running;
                }
                self.push_log(now, format!("worker {version} started"), false);
            }
            WorkerEvent::Log { line } => {
                self.last_line = Some(line.clone());
                self.push_log(now, line, false);
            }
            WorkerEvent::Restarting => {
                if matches!(self.own, Own::Starting | Own::Running) {
                    self.own = Own::Restarting;
                }
                self.push_log(now, "the worker restarts for a new version".to_string(), false);
            }
            WorkerEvent::Stopped { code } => self.push_log(now, format!("the worker stopped (code {code})"), code != 0),
            WorkerEvent::Other => {}
        }
    }

    fn worker_exited(&mut self, code: Option<i32>, now: i64) {
        let asked = matches!(self.own, Own::Stopping | Own::StoppingNow);
        self.own = Own::Stopped;
        self.stop_deadline = None;
        if !asked && code != Some(0) {
            let code = code.map_or_else(|| "?".to_string(), |c| c.to_string());
            self.exit_note = Some(self.last_line.clone().unwrap_or_else(|| format!("the worker ended with code {code}")));
        }
        // A worker started elsewhere may hold the lock now: check at the next tick.
        self.next_check = now;
    }

    fn queue_line(&mut self, queue: Queue, now: i64) -> Vec<Effect> {
        if let Some(server) = iso_ms(&queue.server_time) {
            self.offset_ms = server - now;
        }
        if self.server_down.take().is_some() {
            self.push_log(now, "the queue can be read again".to_string(), false);
        }
        self.watch_text = None;
        self.watch_problem = None;
        self.watch_failures = 0;
        let effects = self.notifications(&queue);
        self.queue = Some(queue);
        effects
    }

    /// Spec 06 4.4: a failed job once (not the ones failed before the tray started); waiting jobs with a stopped worker
    /// or a paused queue once per wave.
    fn notifications(&mut self, q: &Queue) -> Vec<Effect> {
        let first = !self.queue_seen;
        self.queue_seen = true;
        let mut effects = Vec::new();
        for job in q.finished.iter().filter(|j| j.state == "failed") {
            if self.seen_failed.insert(job.id.clone()) && !first {
                let error = clip_chars(job.error.as_deref().unwrap_or("no reason given"), ERROR_CHARS);
                effects.push(Effect::Notify { title: "Fornax job failed".into(), body: format!("{} of {} failed: {error}", job.kind, owner_of(job)) });
            }
        }
        // Only jobs still listed can come again; the others are forgotten.
        self.seen_failed.retain(|id| q.finished.iter().any(|j| &j.id == id));
        let worker_on = self.own != Own::Stopped || self.external || q.worker.online;
        let stuck = !q.queued.is_empty() && (q.paused || !worker_on);
        if stuck && !self.wave_told {
            self.wave_told = true;
            let n = q.queued.len();
            let jobs = if n == 1 { "1 job waits".to_string() } else { format!("{n} jobs wait") };
            let why = if q.paused { "the queue is paused" } else { "the worker is stopped" };
            effects.push(Effect::Notify { title: "Fornax jobs wait".into(), body: format!("{jobs} and {why}") });
        } else if !stuck {
            self.wave_told = false;
        }
        effects
    }

    fn watch_ended(&mut self, now: i64) {
        if self.quitting {
            self.watch = Watch::Off;
            return;
        }
        // Its last other line since the last queue line is why it ended (e.g. not paired); shown while no queue is known.
        if self.watch_text.is_some() {
            self.watch_problem = self.watch_text.clone();
        }
        let delay = WATCH_RETRY_MS[self.watch_failures.min(WATCH_RETRY_MS.len() - 1)];
        self.watch_failures += 1;
        self.watch = Watch::Waiting { retry_at: now + delay };
    }

    fn tick(&mut self, now: i64) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.own == Own::StoppingNow && self.stop_deadline.is_some_and(|d| now >= d) {
            self.stop_deadline = None;
            self.push_log(now, "the worker did not stop: the tray ends it".to_string(), true);
            effects.push(Effect::KillWorker);
        }
        if let Watch::Waiting { retry_at } = self.watch {
            if now >= retry_at && !self.quitting {
                self.watch = Watch::Running;
                effects.push(Effect::SpawnWatch);
            }
        }
        if !self.quitting && now >= self.next_check {
            match self.cli {
                Cli::Ready => {
                    self.next_check = now + LOCK_EVERY_MS;
                    effects.push(Effect::CheckLock);
                }
                // The user may have followed the note (fornax update, Node installed): its answer sets the next time.
                Cli::Problem(_) if !self.cli_checking => {
                    self.cli_checking = true;
                    effects.push(Effect::CheckCli);
                }
                _ => {}
            }
        }
        self.action_errors.retain(|(_, _, until)| *until > now);
        effects
    }

    fn warn(&mut self, now: i64, text: String) {
        if !self.warnings.contains(&text) {
            self.warnings.push(text.clone());
        }
        self.push_log(now, text, true);
    }

    fn push_log(&mut self, at_ms: i64, text: String, error: bool) {
        self.log.push_back(LogLine { at_ms, text, error });
        while self.log.len() > LOG_LINES {
            self.log.pop_front();
        }
    }

    fn action_error(&self, key: &str) -> Option<String> {
        self.action_errors.iter().find(|(k, _, _)| k == key).map(|(_, message, _)| message.clone())
    }

    fn view(&self, j: &Job) -> JobView {
        JobView {
            id: j.id.clone(),
            kind: j.kind.clone(),
            owner: owner_of(j),
            what: what_of(j),
            state: j.state.clone(),
            priority: j.priority.clone(),
            type_unavailable: j.type_unavailable,
            retry_at_ms: j.run_after.as_deref().and_then(iso_ms),
            created_at_ms: iso_ms(&j.created_at),
            started_at_ms: j.started_at.as_deref().and_then(iso_ms),
            finished_at_ms: j.finished_at.as_deref().and_then(iso_ms),
            progress: j.progress,
            progress_message: j.progress_message.clone(),
            error: j.error.clone(),
            result_url: j.result_url.clone(),
            pending: self.pending.contains(&j.id),
            action_error: self.action_error(&j.id),
        }
    }

    fn headline(&self) -> String {
        if self.quitting {
            return "Stopping the worker and quitting…".to_string();
        }
        let worker = match self.own {
            Own::Starting => "Starting the worker…",
            Own::Restarting => "Restarting the worker…",
            Own::Stopping | Own::StoppingNow => "Stopping the worker…",
            Own::Running => "Worker running",
            Own::Stopped if self.external => "Worker runs outside the tray",
            Own::Stopped => "Worker stopped",
        };
        match &self.queue {
            Some(q) if self.cli == Cli::Ready => {
                let queue = if q.paused && q.running.is_some() {
                    "pausing after the running job"
                } else if q.paused {
                    "queue paused"
                } else {
                    "queue active"
                };
                format!("{worker} · {queue}")
            }
            _ => worker.to_string(),
        }
    }

    fn note(&self) -> Option<String> {
        match &self.cli {
            Cli::Problem(message) => Some(message.clone()),
            _ => self.exit_note.clone().or_else(|| (!self.warnings.is_empty()).then(|| self.warnings.join("\n"))),
        }
    }

    fn queue_note(&self) -> Option<String> {
        if self.queue.is_some() {
            return None;
        }
        let problem = self.server_down.as_ref().map(|down| &down.message).or(self.watch_problem.as_ref());
        Some(match (&self.cli, problem) {
            (Cli::Problem(_), _) => "The queue is shown once the tray can run fornax.".to_string(),
            (_, Some(message)) => format!("The queue cannot be read: {message}"),
            (Cli::Unchecked, None) => "Checking fornax…".to_string(),
            (Cli::Ready, None) => "Reading the queue…".to_string(),
        })
    }

    /// Spec 06 4.3, first match wins.
    fn icon(&self) -> Icon {
        let q = self.queue.as_ref();
        let queue_lost = q.is_none() && (self.server_down.is_some() || matches!(self.watch, Watch::Waiting { .. }) || self.watch_problem.is_some());
        let stopped = self.own == Own::Stopped && !self.external;
        if stopped && (self.exit_note.is_some() || matches!(self.cli, Cli::Problem(_)) || queue_lost) {
            return Icon::Error;
        }
        if q.is_some_and(|q| q.running.is_some()) {
            return Icon::Busy;
        }
        if q.is_some_and(|q| q.paused) {
            return Icon::Paused;
        }
        if !stopped {
            return Icon::Idle;
        }
        if q.is_some_and(|q| !q.queued.is_empty()) {
            return Icon::Attention;
        }
        Icon::Stopped
    }

    pub fn snapshot(&self) -> Snapshot {
        let q = self.queue.as_ref();
        let headline = self.headline();
        let tooltip = match q.and_then(|q| q.running.as_ref()) {
            Some(j) => format!("Fornax: {headline} · {} of {}", j.kind, owner_of(j)),
            None => format!("Fornax: {headline}"),
        };
        let paused = q.is_some_and(|q| q.paused);
        Snapshot {
            icon: self.icon(),
            tooltip: clip_utf16(&tooltip, TOOLTIP_UNITS),
            headline,
            note: self.note(),
            can_start: self.can_start(),
            can_stop: matches!(self.own, Own::Starting | Own::Running | Own::Restarting | Own::Stopping) && !self.quitting,
            stop_label: if matches!(self.own, Own::Stopping | Own::StoppingNow) { "Stop now" } else { "Stop worker" }.to_string(),
            can_pause: self.can_act() && !self.pending.contains(PAUSE),
            paused,
            pause_label: if paused { "Resume queue" } else { "Pause queue" }.to_string(),
            pause_error: self.action_error(PAUSE),
            start_worker: self.start_worker,
            confirm_quit: self.confirm_quit,
            queue_known: q.is_some(),
            queue_note: self.queue_note(),
            server_down_since_ms: self.server_down.as_ref().map(|down| down.since),
            server_message: self.server_down.as_ref().map(|down| down.message.clone()),
            server_refused: self.server_down.as_ref().is_some_and(|down| down.refused),
            offset_ms: self.offset_ms,
            running: q.and_then(|q| q.running.as_ref()).map(|j| self.view(j)),
            queued: q.map_or_else(Vec::new, |q| q.queued.iter().map(|j| self.view(j)).collect()),
            finished: q.map_or_else(Vec::new, |q| q.finished.iter().map(|j| self.view(j)).collect()),
            log: self.log.iter().cloned().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::protocol::WorkerInfo;

    const NOW: i64 = 1_800_000_000_000;
    /// 2026-11-15T14:00:00.000Z, the fixtures' server time.
    const SERVER: i64 = 1_794_751_200_000;

    fn job(id: &str, state: &str) -> Job {
        Job {
            id: id.into(), kind: "echo".into(), owner: Some("alice".into()), state: state.into(), label: None, group: None,
            priority: "normal".into(), inputs: BTreeMap::new(), attempts: 0, type_unavailable: false, run_after: None,
            created_at: "2026-11-15T13:56:00.000Z".into(), started_at: None, finished_at: None, progress: None,
            progress_message: None, error: None, result_url: format!("https://fornax.example.com/r/{id}"),
        }
    }

    /// A queue line; the server says the worker is offline (the tests decide the worker by the model's own state).
    fn queue(running: Option<Job>, queued: Vec<Job>, finished: Vec<Job>, paused: bool) -> Input {
        Input::Watch(WatchLine::Queue(Box::new(Queue {
            server_time: "2026-11-15T14:00:00.000Z".into(),
            change: "0123456789abcdef".into(),
            paused,
            worker: WorkerInfo { online: false, last_seen: None, version: None, waiting: None },
            running,
            queued,
            finished,
        })))
    }

    fn launched(start_worker: bool) -> Input {
        Input::Launched { start_worker, warnings: Vec::new() }
    }

    fn checked(version: &str, lock_held: bool) -> Input {
        Input::CliChecked { result: Ok(version.into()), lock_held }
    }

    /// A model whose fornax is ready; with `start_worker` the worker is starting.
    fn ready(start_worker: bool) -> Model {
        let mut m = Model::new();
        m.apply(launched(start_worker), NOW);
        m.apply(checked("0.5.0", false), NOW);
        m
    }

    fn running_worker() -> Model {
        let mut m = ready(true);
        m.apply(Input::WorkerEvent(WorkerEvent::Started { version: "0.5.0".into(), pid: 7 }), NOW);
        m
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_start_checks_fornax_then_reads_the_queue_and_starts_the_worker() {
        let mut m = Model::new();
        assert_eq!(m.apply(launched(true), NOW), vec![Effect::CheckCli]);
        assert_eq!(m.snapshot().queue_note.as_deref(), Some("Checking fornax…"));
        assert_eq!(m.apply(checked("0.5.0\n", false), NOW), vec![Effect::SpawnWatch, Effect::SpawnWorker]);
        let s = m.snapshot();
        assert_eq!(s.headline, "Starting the worker…");
        assert!(s.can_stop && !s.can_start);
        assert_eq!(s.queue_note.as_deref(), Some("Reading the queue…"));
    }

    #[test]
    fn without_start_worker_only_the_queue_is_read() {
        let mut m = Model::new();
        m.apply(launched(false), NOW);
        assert_eq!(m.apply(checked("0.5.0", false), NOW), vec![Effect::SpawnWatch]);
        assert!(m.snapshot().can_start);
        assert_eq!(m.apply(Input::StartWorker, NOW), vec![Effect::SpawnWorker]);
        assert_eq!(m.apply(Input::StartWorker, NOW), vec![], "it is starting already");
    }

    #[test]
    fn an_old_or_missing_fornax_is_explained_and_nothing_starts() {
        let mut m = Model::new();
        m.apply(launched(true), NOW);
        assert_eq!(m.apply(checked("0.4.1", false), NOW), vec![]);
        let s = m.snapshot();
        assert_eq!(s.note.as_deref(), Some("fornax 0.4.1 is too old for the tray: run fornax update"));
        assert!(!s.can_start && !s.can_pause);
        assert_eq!(s.icon, Icon::Error);
        assert_eq!(s.queue_note.as_deref(), Some("The queue is shown once the tray can run fornax."));
        assert_eq!(m.apply(Input::StartWorker, NOW), vec![]);

        let mut m = Model::new();
        m.apply(launched(true), NOW);
        m.apply(Input::CliChecked { result: Err("fornax is not installed: see the README".into()), lock_held: false }, NOW);
        assert_eq!(m.snapshot().note.as_deref(), Some("fornax is not installed: see the README"));
    }

    #[test]
    fn a_worker_outside_the_tray_blocks_start_and_stop_but_not_the_queue() {
        let mut m = Model::new();
        m.apply(launched(true), NOW);
        assert_eq!(m.apply(checked("0.5.0", true), NOW), vec![Effect::SpawnWatch]);
        m.apply(queue(None, vec![job("Q1", "queued")], vec![], false), NOW);
        let s = m.snapshot();
        assert_eq!(s.headline, "Worker runs outside the tray · queue active");
        assert!(!s.can_start && !s.can_stop && s.can_pause);
        assert_eq!(s.icon, Icon::Idle);
        m.apply(Input::LockChecked { held: false }, NOW);
        assert!(m.snapshot().can_start);
    }

    #[test]
    fn the_lock_is_checked_every_15_s_once_fornax_is_ready() {
        let mut m = ready(false);
        assert_eq!(m.apply(Input::Tick, NOW + LOCK_EVERY_MS - 1), vec![]);
        assert_eq!(m.apply(Input::Tick, NOW + LOCK_EVERY_MS), vec![Effect::CheckLock]);
        assert_eq!(m.apply(Input::Tick, NOW + LOCK_EVERY_MS + 1000), vec![]);
    }

    #[test]
    fn stop_then_stop_now_then_the_tray_ends_the_worker() {
        let mut m = running_worker();
        assert_eq!(m.snapshot().headline, "Worker running");
        assert_eq!(m.apply(Input::StopWorker, NOW), vec![Effect::SendStop]);
        let s = m.snapshot();
        assert_eq!((s.headline.as_str(), s.stop_label.as_str(), s.can_stop), ("Stopping the worker…", "Stop now", true));
        assert_eq!(m.apply(Input::StopWorker, NOW), vec![Effect::SendStop]);
        assert!(!m.snapshot().can_stop);
        assert_eq!(m.apply(Input::Tick, NOW + SECOND_STOP_WAIT_MS - 1), vec![]);
        assert_eq!(m.apply(Input::Tick, NOW + SECOND_STOP_WAIT_MS), vec![Effect::KillWorker]);
        m.apply(Input::WorkerExited { code: Some(1) }, NOW + SECOND_STOP_WAIT_MS + 10);
        let s = m.snapshot();
        assert_eq!(s.headline, "Worker stopped");
        assert_eq!(s.note, None, "a stop the user asked for is no error");
        assert!(s.can_start);
    }

    #[test]
    fn a_worker_that_ends_by_itself_shows_its_last_line() {
        let mut m = running_worker();
        m.apply(Input::WorkerEvent(WorkerEvent::Log { line: "the server does not accept this worker token".into() }), NOW);
        m.apply(Input::WorkerExited { code: Some(1) }, NOW);
        let s = m.snapshot();
        assert_eq!(s.note.as_deref(), Some("the server does not accept this worker token"));
        assert_eq!(s.icon, Icon::Error);
        m.apply(Input::StartWorker, NOW);
        assert_eq!(m.snapshot().note, None, "a new start clears it");
    }

    #[test]
    fn a_worker_that_cannot_start_says_why() {
        let mut m = ready(false);
        m.apply(Input::StartWorker, NOW);
        m.apply(Input::WorkerSpawnFailed("Node.js was not found (node)".into()), NOW);
        let s = m.snapshot();
        assert_eq!(s.note.as_deref(), Some("Node.js was not found (node)"));
        assert!(s.can_start);
    }

    #[test]
    fn a_restart_for_a_new_version_shows_until_the_new_worker_starts() {
        let mut m = running_worker();
        m.apply(Input::WorkerEvent(WorkerEvent::Restarting), NOW);
        assert_eq!(m.snapshot().headline, "Restarting the worker…");
        m.apply(Input::WorkerEvent(WorkerEvent::Started { version: "0.5.1".into(), pid: 8 }), NOW);
        assert_eq!(m.snapshot().headline, "Worker running");
    }

    #[test]
    fn the_queue_shows_jobs_with_their_names_times_and_the_clock_offset() {
        let mut m = running_worker();
        let mut r = job("R1", "running");
        r.started_at = Some("2026-11-15T13:47:13.000Z".into());
        r.inputs.insert("video".into(), Some("clip.mp4".into()));
        r.progress = Some(0.62);
        let mut l = job("Q1", "queued");
        l.label = Some("chrome".into());
        l.inputs.insert("scene".into(), Some("scene.blend".into()));
        let mut g = job("Q2", "queued");
        g.group = Some("mcup-1".into());
        g.run_after = Some("2026-11-15T14:05:00.000Z".into());
        // The PC's clock is 10 s behind the server's.
        m.apply(queue(Some(r), vec![l, g], vec![], false), SERVER - 10_000);
        let s = m.snapshot();
        assert_eq!(s.offset_ms, 10_000);
        assert_eq!(s.headline, "Worker running · queue active");
        assert_eq!(s.icon, Icon::Busy);
        let run = s.running.clone().unwrap();
        assert_eq!((run.what.as_str(), run.started_at_ms, run.progress), ("clip.mp4", Some(SERVER - 767_000), Some(0.62)));
        assert_eq!(s.queued.iter().map(|j| j.what.as_str()).collect::<Vec<_>>(), ["chrome", "mcup-1"]);
        assert_eq!(s.queued[1].retry_at_ms, Some(SERVER + 300_000));
        assert_eq!(s.tooltip, "Fornax: Worker running · queue active · echo of alice");
    }

    #[test]
    fn the_icon_follows_the_spec_table() {
        let mut m = ready(false);
        m.apply(queue(None, vec![], vec![], false), NOW);
        assert_eq!(m.snapshot().icon, Icon::Stopped);
        m.apply(queue(None, vec![job("Q1", "queued")], vec![], false), NOW);
        assert_eq!(m.snapshot().icon, Icon::Attention);
        m.apply(queue(None, vec![job("Q1", "queued")], vec![], true), NOW);
        let s = m.snapshot();
        assert_eq!((s.icon, s.headline.as_str(), s.pause_label.as_str(), s.paused), (Icon::Paused, "Worker stopped · queue paused", "Resume queue", true));
        m.apply(queue(Some(job("R1", "running")), vec![], vec![], true), NOW);
        let s = m.snapshot();
        assert_eq!((s.icon, s.headline.as_str()), (Icon::Busy, "Worker stopped · pausing after the running job"));
        m.apply(Input::StartWorker, NOW);
        m.apply(queue(None, vec![], vec![], false), NOW);
        assert_eq!(m.snapshot().icon, Icon::Idle);
    }

    #[test]
    fn an_unreadable_queue_is_said_once_and_cleared_by_the_next_answer() {
        let mut m = ready(false);
        m.apply(Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server: ECONNREFUSED".into() }), NOW);
        m.apply(Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server: ETIMEDOUT".into() }), NOW + 5000);
        let s = m.snapshot();
        assert_eq!(s.server_down_since_ms, Some(NOW));
        assert_eq!(s.server_message.as_deref(), Some("cannot reach the server: ETIMEDOUT"));
        assert_eq!(s.icon, Icon::Error);
        assert_eq!(s.queue_note.as_deref(), Some("The queue cannot be read: cannot reach the server: ETIMEDOUT"));
        assert_eq!(s.log.iter().filter(|l| l.text.starts_with("cannot read the queue")).count(), 1);
        m.apply(queue(None, vec![], vec![], false), NOW + 9000);
        let s = m.snapshot();
        assert_eq!(s.server_down_since_ms, None);
        assert_eq!(s.icon, Icon::Stopped);
    }

    #[test]
    fn a_refused_worker_token_says_to_pair_again() {
        let mut m = ready(false);
        m.apply(Input::Watch(WatchLine::Failed { error: "auth".into(), message: "unauthorized".into() }), NOW);
        assert_eq!(m.snapshot().server_message.as_deref(), Some(TOKEN_REFUSED));
    }

    /// Ruling 3 (spec 06 § 5, its own row): a refused token is not "Server unreachable since …".
    #[test]
    fn a_refused_token_is_told_apart_from_an_unreachable_server() {
        let mut m = ready(false);
        m.apply(queue(None, vec![job("Q1", "queued")], vec![], false), NOW);
        m.apply(Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server: ECONNREFUSED".into() }), NOW);
        let s = m.snapshot();
        assert_eq!(s.server_down_since_ms, Some(NOW));
        assert!(!s.server_refused, "an unreachable server is no refused token");
        m.apply(Input::Watch(WatchLine::Failed { error: "auth".into(), message: "unauthorized".into() }), NOW + 5000);
        let s = m.snapshot();
        assert!(s.server_refused);
        assert_eq!(s.server_message.as_deref(), Some(TOKEN_REFUSED));
        assert!(!s.can_pause, "the server is not usable");
        assert_eq!(m.apply(Input::Cancel { id: "Q1".into() }, NOW + 5000), vec![]);
        m.apply(Input::Watch(WatchLine::Failed { error: "server".into(), message: "the server answered 502".into() }), NOW + 7000);
        assert!(!m.snapshot().server_refused, "only while the last failure was auth");
        m.apply(Input::Watch(WatchLine::Failed { error: "auth".into(), message: "unauthorized".into() }), NOW + 8000);
        assert!(m.snapshot().server_refused);
        m.apply(queue(None, vec![job("Q1", "queued")], vec![], false), NOW + 9000);
        let s = m.snapshot();
        assert!(!s.server_refused && s.server_message.is_none() && s.can_pause);
    }

    /// Ruling 1 (spec 06 § 5): while the server is unreachable the last known queue stays, its actions are inactive.
    #[test]
    fn while_the_server_is_unreachable_no_action_runs() {
        let mut m = ready(false);
        m.apply(queue(None, vec![job("Q1", "queued"), job("Q2", "queued")], vec![], false), NOW);
        m.apply(Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server: ECONNREFUSED".into() }), NOW);
        let s = m.snapshot();
        assert!(s.queue_known && s.server_down_since_ms == Some(NOW));
        assert!(!s.can_pause);
        assert_eq!(m.apply(Input::Move { id: "Q2".into(), to: MoveTo::Top }, NOW), vec![]);
        assert_eq!(m.apply(Input::Cancel { id: "Q1".into() }, NOW), vec![]);
        assert_eq!(m.apply(Input::SetPaused(true), NOW), vec![]);
        assert!(m.snapshot().queued.iter().all(|j| !j.pending), "nothing was started");
        m.apply(queue(None, vec![job("Q1", "queued"), job("Q2", "queued")], vec![], false), NOW + 5000);
        assert!(m.snapshot().can_pause);
        assert_eq!(m.apply(Input::Move { id: "Q2".into(), to: MoveTo::Top }, NOW + 5000), vec![Effect::RunAction { key: "Q2".into(), args: args(&["queue", "move", "Q2", "--top"]) }]);
        assert_eq!(m.apply(Input::Cancel { id: "Q1".into() }, NOW + 5000), vec![Effect::RunAction { key: "Q1".into(), args: args(&["queue", "cancel", "Q1"]) }]);
        assert_eq!(m.apply(Input::SetPaused(true), NOW + 5000), vec![Effect::RunAction { key: PAUSE.into(), args: args(&["queue", "pause"]) }]);
    }

    /// Ruling 2 (spec 06 § 4.2): a reader that dies before its first queue line says why, not "Reading the queue…".
    #[test]
    fn a_reader_that_ends_before_its_first_queue_line_says_why() {
        let mut m = ready(false);
        m.apply(Input::WatchText("this computer is not paired as a worker (fornax worker pair)".into()), NOW);
        assert_eq!(m.snapshot().queue_note.as_deref(), Some("Reading the queue…"), "the reader may still answer");
        m.apply(Input::WatchExited, NOW);
        let said = Some("The queue cannot be read: this computer is not paired as a worker (fornax worker pair)");
        let s = m.snapshot();
        assert_eq!(s.queue_note.as_deref(), said);
        assert_eq!(s.icon, Icon::Error);
        assert!(m.apply(Input::Tick, NOW + 2_000).contains(&Effect::SpawnWatch));
        let s = m.snapshot();
        assert_eq!(s.queue_note.as_deref(), said, "it stays while the next reader runs");
        assert_eq!(s.icon, Icon::Error, "the icon does not turn grey while the next reader starts");
        m.apply(queue(None, vec![], vec![], false), NOW + 3_000);
        assert_eq!(m.snapshot().queue_note, None, "a good queue line clears it");

        // A reader that could not even start says why too.
        let mut m = ready(false);
        m.apply(Input::WatchSpawnFailed("Node.js was not found (node)".into()), NOW);
        assert_eq!(m.snapshot().queue_note.as_deref(), Some("The queue cannot be read: Node.js was not found (node)"));
    }

    #[test]
    fn a_reader_that_keeps_ending_is_started_again_less_and_less_often() {
        let mut m = ready(false);
        let mut at = NOW;
        for delay in [2_000, 5_000, 10_000, 30_000, 30_000] {
            m.apply(Input::WatchExited, at);
            assert!(!m.apply(Input::Tick, at + delay - 1).contains(&Effect::SpawnWatch), "not before {delay} ms");
            assert!(m.apply(Input::Tick, at + delay).contains(&Effect::SpawnWatch), "after {delay} ms");
            at += delay;
        }
        m.apply(queue(None, vec![], vec![], false), at);
        m.apply(Input::WatchExited, at);
        assert!(m.apply(Input::Tick, at + 2_000).contains(&Effect::SpawnWatch), "a good line starts the pauses over");
    }

    #[test]
    fn actions_run_one_per_job_and_a_failure_shows_next_to_its_job_for_10_s() {
        let mut m = ready(false);
        m.apply(queue(None, vec![job("Q1", "queued"), job("Q2", "queued")], vec![], false), NOW);
        assert_eq!(m.apply(Input::Move { id: "Q2".into(), to: MoveTo::Top }, NOW), vec![Effect::RunAction { key: "Q2".into(), args: args(&["queue", "move", "Q2", "--top"]) }]);
        assert_eq!(m.apply(Input::Move { id: "Q2".into(), to: MoveTo::Bottom }, NOW), vec![], "one action per job at a time");
        assert!(m.snapshot().queued[1].pending);
        m.apply(Input::ActionDone { key: "Q2".into(), result: Err("job Q2 is running now; only waiting jobs move".into()) }, NOW);
        let s = m.snapshot();
        assert!(!s.queued[1].pending);
        assert_eq!(s.queued[1].action_error.as_deref(), Some("job Q2 is running now; only waiting jobs move"));
        m.apply(Input::Tick, NOW + ACTION_ERROR_MS);
        assert_eq!(m.snapshot().queued[1].action_error, None);
        assert_eq!(m.apply(Input::Move { id: "Q1".into(), to: MoveTo::After("Q2".into()) }, NOW), vec![Effect::RunAction { key: "Q1".into(), args: args(&["queue", "move", "Q1", "--after", "Q2"]) }]);
        assert_eq!(m.apply(Input::Move { id: "Q2".into(), to: MoveTo::Before("Q1".into()) }, NOW), vec![Effect::RunAction { key: "Q2".into(), args: args(&["queue", "move", "Q2", "--before", "Q1"]) }]);
        m.apply(Input::ActionDone { key: "Q2".into(), result: Ok(()) }, NOW);
        assert_eq!(m.apply(Input::Cancel { id: "Q2".into() }, NOW), vec![Effect::RunAction { key: "Q2".into(), args: args(&["queue", "cancel", "Q2"]) }]);
        assert_eq!(m.apply(Input::SetPaused(true), NOW), vec![Effect::RunAction { key: PAUSE.into(), args: args(&["queue", "pause"]) }]);
        assert!(!m.snapshot().can_pause);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("cannot reach the server: ECONNREFUSED".into()) }, NOW);
        assert_eq!(m.snapshot().pause_error.as_deref(), Some("cannot reach the server: ECONNREFUSED"));
        assert_eq!(m.apply(Input::SetPaused(false), NOW), vec![Effect::RunAction { key: PAUSE.into(), args: args(&["queue", "resume"]) }]);
    }

    #[test]
    fn no_action_before_the_queue_is_known() {
        let mut m = ready(false);
        assert_eq!(m.apply(Input::SetPaused(true), NOW), vec![]);
        assert_eq!(m.apply(Input::Cancel { id: "Q1".into() }, NOW), vec![]);
    }

    #[test]
    fn a_failed_job_is_told_once_and_not_the_ones_failed_before_the_tray_started() {
        let mut m = ready(true);
        let mut old = job("F0", "failed");
        old.error = Some("old".into());
        assert_eq!(m.apply(queue(None, vec![], vec![old.clone()], false), NOW), vec![]);
        let mut new = job("F1", "failed");
        new.error = Some("x".repeat(300));
        let effects = m.apply(queue(None, vec![], vec![new.clone(), old.clone()], false), NOW);
        assert_eq!(effects.len(), 1, "{effects:?}");
        let Effect::Notify { title, body } = &effects[0] else { panic!("{effects:?}") };
        assert_eq!(title, "Fornax job failed");
        assert!(body.starts_with("echo of alice failed: xxx"), "{body}");
        assert_eq!(body.chars().count(), "echo of alice failed: ".chars().count() + ERROR_CHARS + 1);
        assert_eq!(m.apply(queue(None, vec![], vec![new, old], false), NOW), vec![], "the same failure again is no news");
    }

    #[test]
    fn waiting_jobs_with_a_stopped_worker_or_a_paused_queue_are_told_once_per_wave() {
        let mut m = ready(false);
        let effects = m.apply(queue(None, vec![job("Q1", "queued"), job("Q2", "queued")], vec![], false), NOW);
        assert_eq!(effects, vec![Effect::Notify { title: "Fornax jobs wait".into(), body: "2 jobs wait and the worker is stopped".into() }]);
        assert_eq!(m.apply(queue(None, vec![job("Q1", "queued")], vec![], false), NOW), vec![], "the same wave");
        m.apply(queue(None, vec![], vec![], false), NOW);
        let effects = m.apply(queue(None, vec![job("Q3", "queued")], vec![], true), NOW);
        assert_eq!(effects, vec![Effect::Notify { title: "Fornax jobs wait".into(), body: "1 job waits and the queue is paused".into() }]);
    }

    #[test]
    fn quit_asks_first_while_the_worker_runs() {
        let mut m = ready(false);
        assert_eq!(m.apply(Input::Quit, NOW), vec![Effect::Exit]);
        let mut m = running_worker();
        assert_eq!(m.apply(Input::Quit, NOW), vec![Effect::ShowWindow]);
        assert!(m.snapshot().confirm_quit);
        assert_eq!(m.apply(Input::ConfirmQuit(false), NOW), vec![]);
        assert!(!m.snapshot().confirm_quit);
        m.apply(Input::Quit, NOW);
        assert_eq!(m.apply(Input::ConfirmQuit(true), NOW), vec![Effect::SendStop, Effect::ExitAfterStop]);
        let s = m.snapshot();
        assert_eq!(s.headline, "Stopping the worker and quitting…");
        assert!(!s.can_start && !s.can_stop && !s.can_pause);
        m.apply(Input::WatchExited, NOW);
        assert!(!m.apply(Input::Tick, NOW + 60_000).contains(&Effect::SpawnWatch), "no new reader while quitting");
    }

    #[test]
    fn the_setting_and_warnings() {
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: true, warnings: vec!["tray.json is not valid: expected value".into()] }, NOW);
        assert_eq!(m.snapshot().note.as_deref(), Some("tray.json is not valid: expected value"));
        assert_eq!(m.apply(Input::SetStartWorker(false), NOW), vec![Effect::SaveStartWorker(false)]);
        assert!(!m.snapshot().start_worker);
        m.apply(Input::Warning("cannot write tray.json".into()), NOW);
        assert_eq!(m.snapshot().log.last().map(|l| (l.text.as_str(), l.error)), Some(("cannot write tray.json", true)));
    }

    #[test]
    fn the_log_keeps_the_last_200_lines_and_the_tooltip_fits_windows() {
        let mut m = running_worker();
        for i in 0..250 {
            m.apply(Input::WorkerEvent(WorkerEvent::Log { line: format!("line {i}") }), NOW + i);
        }
        let s = m.snapshot();
        assert_eq!(s.log.len(), LOG_LINES);
        assert_eq!(s.log.last().map(|l| l.text.as_str()), Some("line 249"));
        let mut long = job("R1", "running");
        long.owner = Some("ö".repeat(200));
        m.apply(queue(Some(long), vec![], vec![], false), NOW);
        assert!(m.snapshot().tooltip.encode_utf16().count() <= TOOLTIP_UNITS);
    }

    /// After the user follows the note (fornax update, install fornax or Node) the tray recovers by itself, and a start
    /// at sign-in still starts the worker.
    #[test]
    fn a_problem_with_fornax_is_checked_again_until_it_is_ready() {
        let mut m = Model::new();
        m.apply(launched(true), NOW);
        assert_eq!(m.apply(checked("0.4.1", false), NOW), vec![]);
        assert_eq!(m.apply(Input::Tick, NOW + LOCK_EVERY_MS - 1), vec![]);
        assert_eq!(m.apply(Input::Tick, NOW + LOCK_EVERY_MS), vec![Effect::CheckCli]);
        assert_eq!(m.apply(Input::Tick, NOW + 2 * LOCK_EVERY_MS), vec![], "one check at a time");
        let s = m.snapshot();
        assert_eq!(s.note.as_deref(), Some("fornax 0.4.1 is too old for the tray: run fornax update"), "the note stays while it is checked");
        assert!(!s.can_start);
        let node = r#"Node.js was not found (node): install Node.js 22 or newer, or set "node" in tray.json"#;
        assert_eq!(m.apply(Input::CliChecked { result: Err(node.into()), lock_held: false }, NOW + 2 * LOCK_EVERY_MS), vec![]);
        assert_eq!(m.snapshot().note.as_deref(), Some(node));
        assert_eq!(m.apply(Input::Tick, NOW + 3 * LOCK_EVERY_MS - 1), vec![]);
        assert_eq!(m.apply(Input::Tick, NOW + 3 * LOCK_EVERY_MS), vec![Effect::CheckCli]);
        assert_eq!(m.apply(checked("0.5.0", false), NOW + 3 * LOCK_EVERY_MS), vec![Effect::SpawnWatch, Effect::SpawnWorker], "the start at sign-in waited");
        assert_eq!(m.snapshot().note, None);
        assert_eq!(m.apply(Input::Tick, NOW + 4 * LOCK_EVERY_MS), vec![Effect::CheckLock], "from now on only the lock");
    }

    /// Node's crash output ends with its version and the stack: the line before them says why.
    #[test]
    fn a_crash_footer_and_stack_frames_are_no_reason() {
        let crash = [
            "Error: boom",
            "    at main (file:///app/fornax.mjs:10:5)",
            "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5) {",
            "  code: 'ERR_BOOM'",
            "}",
            "Node.js v22.16.0",
        ];
        let mut m = running_worker();
        for line in crash {
            m.apply(Input::WorkerText(line.into()), NOW);
        }
        m.apply(Input::WorkerExited { code: Some(1) }, NOW);
        let s = m.snapshot();
        assert_eq!(s.note.as_deref(), Some("Error: boom"));
        assert_eq!(s.log.last().map(|l| l.text.as_str()), Some("Node.js v22.16.0"), "the log keeps every line");

        let mut m = ready(false);
        for line in crash {
            m.apply(Input::WatchText(line.into()), NOW);
        }
        m.apply(Input::WatchExited, NOW);
        assert_eq!(m.snapshot().queue_note.as_deref(), Some("The queue cannot be read: Error: boom"));
    }

    #[test]
    fn a_new_start_forgets_the_last_line_of_the_run_before() {
        let mut m = running_worker();
        m.apply(Input::WorkerEvent(WorkerEvent::Log { line: "offering: echo".into() }), NOW);
        m.apply(Input::StopWorker, NOW);
        m.apply(Input::WorkerExited { code: Some(0) }, NOW);
        m.apply(Input::StartWorker, NOW);
        m.apply(Input::WorkerExited { code: Some(3) }, NOW);
        assert_eq!(m.snapshot().note.as_deref(), Some("the worker ended with code 3"));
    }

    #[test]
    fn a_version_check_that_answers_during_quit_starts_nothing() {
        let mut m = Model::new();
        m.apply(launched(true), NOW);
        assert_eq!(m.apply(Input::Quit, NOW), vec![Effect::Exit]);
        assert_eq!(m.apply(checked("0.5.0", false), NOW), vec![], "no reader and no worker while quitting");
        assert_eq!(m.apply(Input::Tick, NOW + 60_000), vec![]);
    }

    #[test]
    fn every_warning_shows_once() {
        let guard = "Windows protects this tray against folder links (Redirection Guard)";
        let broken = "tray.json is not valid: expected value";
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: true, warnings: vec![guard.into(), broken.into()] }, NOW);
        assert_eq!(m.snapshot().note, Some(format!("{guard}\n{broken}")));
        m.apply(Input::Warning("cannot write tray.json".into()), NOW);
        m.apply(Input::Warning("cannot write tray.json".into()), NOW);
        assert_eq!(m.snapshot().note, Some(format!("{guard}\n{broken}\ncannot write tray.json")));
    }

    #[test]
    fn the_snapshot_keeps_the_names_types_ts_reads() {
        let mut m = running_worker();
        m.apply(queue(Some(job("R1", "running")), vec![], vec![], false), NOW);
        let v = serde_json::to_value(m.snapshot()).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "canPause", "canStart", "canStop", "confirmQuit", "finished", "headline", "icon", "log", "note", "offsetMs",
                "pauseError", "pauseLabel", "paused", "queueKnown", "queueNote", "queued", "running", "serverDownSinceMs",
                "serverMessage", "serverRefused", "startWorker", "stopLabel", "tooltip",
            ]
        );
        let mut job_keys: Vec<&str> = v["running"].as_object().unwrap().keys().map(String::as_str).collect();
        job_keys.sort_unstable();
        assert_eq!(
            job_keys,
            [
                "actionError", "createdAtMs", "error", "finishedAtMs", "id", "owner", "pending", "priority", "progress",
                "progressMessage", "resultUrl", "retryAtMs", "startedAtMs", "state", "type", "typeUnavailable", "what",
            ]
        );
        assert_eq!(v["icon"], "busy");
        assert_eq!(v["log"][0].as_object().unwrap().keys().cloned().collect::<Vec<_>>().len(), 3);
    }
}
