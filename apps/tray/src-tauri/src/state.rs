//! The tray's model (spec 06 § 4): inputs change it in order and may ask for effects; the snapshot is what the window
//! and the tray icon show. Pure: no threads, clocks or processes (controller.rs has them), so every rule is a test.

use std::collections::{BTreeSet, VecDeque};

use serde::Serialize;

use crate::protocol::{iso_ms, version_of, Job, Queue, Waiting, WatchLine, WorkerEvent, MIN_CLI};

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
/// fornax from this version answers pause and resume with the queue (`--json`).
pub const PAUSE_JSON_CLI: (u32, u32, u32) = (0, 7, 2);
/// How much later than the tray's idea of the server time an update's own pause may be (the time of a queue line comes
/// a little before the line is read): a pause later than that is someone else's.
pub const OWED_MARGIN_MS: i64 = 5_000;
/// After an owed resume failed, the next one goes after this long (the last value repeats).
pub const OWED_RETRY_MS: [i64; 4] = [5_000, 15_000, 30_000, 60_000];
/// Spec 06 § 5: what the window says when the server refuses the worker token (401/403).
pub const TOKEN_REFUSED: &str = "The server refused the worker token: pair again (fornax worker pair)";
/// What the menu shows when no update is offered (spec 06d 4.2).
pub const NO_UPDATE: &str = "No update";

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
    /// The tray started, with its setting, the warnings to show (Redirection Guard, tray.json), its own version, whether
    /// it runs as an AppImage, and what a tray update before it left (spec 06d 4.3).
    Launched { start_worker: bool, warnings: Vec<String>, version: String, appimage: bool, update_done: Option<UpdateDone> },
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
    /// Spec 06d 4.3: the update button, and its cancel.
    Update,
    CancelUpdate,
    /// A line of `fornax update` under the tray.
    UpdateText(String),
    /// `fornax update` ended: Ok, or its last line.
    UpdateRan(Result<(), String>),
    /// The installer helper started (the marker is written), or why not.
    TrayInstallStarted(Result<(), String>),
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
    /// The answer to a [`Effect::RunAction`]; main.rs also sends a failed one for a result page that did not open. Ok
    /// holds the server time of the queue the action answered with (pause and resume with fornax 0.7.2 or newer).
    ActionDone { key: String, result: Result<Option<String>, String> },
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
    /// `fornax update`, its lines as [`Input::UpdateText`], answered by one [`Input::UpdateRan`].
    RunUpdate,
    /// Write `<data>/tray-update.json` and start `fornax tray install --wait-pid <pid> --relaunch <exe>` detached;
    /// answered by one [`Input::TrayInstallStarted`]. `resume_before`: the next tray resumes the queue the update paused,
    /// unless it was paused again after this server time (ms).
    StartTrayInstall { target: String, resume_before: Option<i64> },
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
    /// The worker runs and waits for the card (spec 06c 4.1).
    Card,
    Error,
}

/// What a tray update left for the next tray (spec 06d 4.3): read and removed at its start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateDone {
    pub target: String,
    pub resume_queue: bool,
    /// The server time (ms) after which a pause is not the update's; None from a tray before 0.7.2 (any pause).
    pub resume_before: Option<i64>,
    /// The installer helper's last line (`tray-update.log`).
    pub last_line: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateKind {
    /// fornax and the tray.
    Both,
    /// Only fornax: the tray is current (or an AppImage).
    CliOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdatePhase {
    /// The queue is being paused, or a job still runs.
    Waiting,
    Cli,
    Installing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Update {
    target: String,
    kind: UpdateKind,
    phase: UpdatePhase,
    /// The update paused the queue (it was not paused before): it resumes it.
    paused_by_us: bool,
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

/// One job type for the window (spec 06c 4.3): `state` is `offered`, `waiting` or `unavailable`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeView {
    pub name: String,
    pub state: String,
    pub reason: Option<String>,
}

/// The states of a type this tray knows; a row with another one (a newer CLI) is dropped.
const TYPE_STATES: [&str; 3] = ["offered", "waiting", "unavailable"];

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
    /// The worker's types (spec 06c 4.3); empty with `types_note` when there is no list.
    pub types: Vec<TypeView>,
    pub types_note: Option<String>,
    /// Spec 06d 4.1: "tray 0.7.0 · fornax 0.7.0 · server 0.7.1".
    pub versions: String,
    /// "Update to 0.7.1" / "Update fornax to 0.7.1" when one is offered.
    pub update_label: Option<String>,
    pub can_update: bool,
    pub can_cancel_update: bool,
    /// An update runs, in any phase (the tray menu shows the headline then).
    pub updating: bool,
    /// Why the last update failed, or the AppImage's note.
    pub update_note: Option<String>,
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
    /// The last types event of the tray's worker; None before it and after the worker stopped.
    types: Option<Vec<TypeView>>,
    /// The worker printed its offering line (`offering: …`): a CLI that sends no types event is older.
    offering_seen: bool,
    /// The tray's own version.
    version: String,
    appimage: bool,
    /// What `fornax --version` printed, once fornax is ready.
    cli_version: Option<String>,
    update: Option<Update>,
    /// Why the update to a version failed: (that version, the sentence). Shown while that version is offered.
    update_note: Option<(String, String)>,
    /// A resume of a queue an update paused that has not gone through yet (the tray before this one paused it, a pause
    /// still runs, the server is down, the resume failed): sent as soon as it can be, until one answers.
    resume_owed: bool,
    /// The owed resume undoes only a pause from no later than this server time (ms): a pause made after the update
    /// ended is someone else's. None: any pause (a marker of a tray before 0.7.2).
    resume_before: Option<i64>,
    /// The owed resume waits for the update's own pause action, still on its way, to answer.
    owed_after_pause: bool,
    /// Owed resumes that failed in a row, and when the next one may go (ms, local).
    owed_failures: usize,
    owed_retry_at: i64,
    /// The server time (ms) of the pause or resume answer a queue line must not be older than to clear `pause_unseen`.
    answer_time: Option<i64>,
    /// Quit came during an update that had paused the queue: quit once the resume answered.
    quit_after_resume: bool,
    /// What the pause action on its way asks for (true: paused).
    pause_target: Option<bool>,
    /// A pause or resume that changes what the last queue line says has answered: the line is older than it (paused,
    /// or a job claimed right after a resume), so no update starts or advances from it until the next line. An action
    /// that changes nothing brings no line (`--watch` prints changes only), so it does not set this.
    pause_unseen: bool,
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
            types: None,
            offering_seen: false,
            version: String::new(),
            appimage: false,
            cli_version: None,
            update: None,
            update_note: None,
            resume_owed: false,
            resume_before: None,
            owed_after_pause: false,
            owed_failures: 0,
            owed_retry_at: 0,
            answer_time: None,
            quit_after_resume: false,
            pause_target: None,
            pause_unseen: false,
        }
    }

    pub fn apply(&mut self, input: Input, now: i64) -> Vec<Effect> {
        match input {
            Input::Launched { start_worker, warnings, version, appimage, update_done } => {
                self.start_worker = start_worker;
                self.auto_start = start_worker;
                for text in warnings {
                    self.warn(now, text);
                }
                self.version = version;
                self.appimage = appimage;
                if let Some(done) = update_done {
                    if done.target == self.version {
                        self.push_log(now, format!("updated to {}", done.target), false);
                    } else {
                        let why = done.last_line.map_or_else(String::new, |line| format!(": {line}"));
                        self.push_log(now, format!("the tray update to {} did not install{why}", done.target), true);
                    }
                    self.resume_owed = done.resume_queue;
                    self.resume_before = done.resume_before;
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
            // During an update the update owns the pause (the button is off; a click on the way is dropped).
            Input::SetPaused(_) if self.update.is_some() => Vec::new(),
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
            Input::Quit => self.quit(now),
            Input::ConfirmQuit(yes) => self.confirm_quit(yes),
            Input::Update => self.start_update(now),
            Input::CancelUpdate => self.cancel_update(now),
            Input::UpdateText(line) => {
                self.push_log(now, line, false);
                Vec::new()
            }
            Input::UpdateRan(result) => self.update_ran(result, now),
            Input::TrayInstallStarted(result) => self.install_started(result, now),
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
                let failed = result.as_ref().err().cloned();
                let answered_at = result.as_ref().ok().and_then(|t| t.as_deref()).and_then(iso_ms);
                if let Err(message) = result {
                    self.push_log(now, message.clone(), true);
                    self.action_errors.retain(|(k, _, _)| *k != key);
                    self.action_errors.push((key.clone(), message, now + ACTION_ERROR_MS));
                }
                if key != PAUSE {
                    return Vec::new();
                }
                let target = self.pause_target.take();
                // Set from this answer, not added to: a resume that undid a pause no line showed leaves the line right.
                if failed.is_none() {
                    self.pause_unseen = target.is_some_and(|t| self.queue.as_ref().is_some_and(|q| q.paused != t));
                    self.answer_time = answered_at.filter(|_| self.pause_unseen);
                    // A resume that went through pays what was owed.
                    if target == Some(false) {
                        self.clear_owed();
                    }
                }
                // A failed resume of what is owed goes out again after a pause that grows (sent again now, it would
                // fail the same way; a queue line may not come for long).
                if failed.is_some() && target == Some(false) && self.resume_owed {
                    let wait = OWED_RETRY_MS[self.owed_failures.min(OWED_RETRY_MS.len() - 1)];
                    self.owed_failures += 1;
                    self.owed_retry_at = now + wait;
                }
                // A resume owed while the update's own pause ran goes out once that pause answered; the pause may have
                // reached the server only now, so the bound is taken again.
                if std::mem::take(&mut self.owed_after_pause) && self.resume_owed && target == Some(true) {
                    self.resume_before = Some(self.owed_bound(now));
                    let effects = self.action(PAUSE.to_string(), vec!["queue".into(), "resume".into()]);
                    if !effects.is_empty() {
                        return effects;
                    }
                }
                if self.quit_after_resume {
                    self.quit_after_resume = false;
                    return self.quit(now);
                }
                // During the wait the only pause action is the update's own (Pause/Resume are off, and Update is off
                // while one runs): without it, fornax update could run with jobs starting.
                if let (Some(message), Some(u)) = (failed, &self.update) {
                    if u.phase == UpdatePhase::Waiting {
                        let (target, ours) = (u.target.clone(), u.paused_by_us);
                        self.update = None;
                        self.update_note = Some((target, format!("The update could not pause the queue: {message}")));
                        // The pause may have gone through anyway (an answer lost on the way, a timeout): resume, which
                        // a queue that is not paused ignores; with the server down it is owed to a paused queue.
                        return self.resume_if_ours(ours, now);
                    }
                }
                self.advance_update()
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
        let text_seen = result.as_ref().ok().map(|t| t.trim().to_string());
        self.cli = match result {
            Ok(text) => match version_of(&text) {
                Some(v) if v >= MIN_CLI => Cli::Ready,
                Some(_) => Cli::Problem(format!("fornax {} is too old for the tray: run fornax update", text.trim())),
                None => Cli::Problem(format!("fornax --version printed {:?}, not a version: run fornax update", clip_chars(text.trim(), 40))),
            },
            Err(message) => Cli::Problem(message),
        };
        self.cli_version = if self.cli == Cli::Ready { text_seen } else { None };
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
        self.types = None;
        self.offering_seen = false;
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
    fn action(&mut self, key: String, mut args: Vec<String>) -> Vec<Effect> {
        if !self.can_act() || !self.pending.insert(key.clone()) {
            return Vec::new();
        }
        self.action_errors.retain(|(k, _, _)| *k != key);
        if key == PAUSE {
            self.pause_target = args.get(1).map(|a| a == "pause");
            // The answer's queue tells which queue lines are older than the action.
            if self.cli_version.as_deref().and_then(version_of).is_some_and(|v| v >= PAUSE_JSON_CLI) {
                args.push("--json".into());
            }
        }
        vec![Effect::RunAction { key, args }]
    }

    fn quit(&mut self, now: i64) -> Vec<Effect> {
        if self.quitting {
            return Vec::new();
        }
        // Spec 06d 4.3: Quit cancels an update; a queue it paused is resumed first, then the quit goes on.
        if let Some(u) = self.update.as_ref().filter(|u| u.phase != UpdatePhase::Installing) {
            let ours = u.paused_by_us;
            self.update = None;
            if ours {
                let effects = self.resume_if_ours(true, now);
                if !effects.is_empty() {
                    self.quit_after_resume = true;
                    return effects;
                }
                // The pause still runs: resume once it answered, then quit.
                if self.pending.contains(PAUSE) {
                    self.quit_after_resume = true;
                    return Vec::new();
                }
            }
        }
        if self.update.is_some() {
            // Installing: the tray is quitting already.
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
        self.quit_now()
    }

    /// Stop the worker (if the tray runs one) and exit.
    fn quit_now(&mut self) -> Vec<Effect> {
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

    /// Spec 06d 4.2: what update is offered, and to which version.
    fn offer(&self) -> Option<(UpdateKind, String)> {
        if self.cli != Cli::Ready || self.update.is_some() || self.quitting {
            return None;
        }
        let server = self.queue.as_ref()?.server_version.clone()?;
        let s = version_of(&server)?;
        let tray_old = version_of(&self.version).is_some_and(|t| s > t);
        let cli_old = self.cli_version.as_deref().and_then(version_of).is_some_and(|c| s > c);
        if tray_old && !self.appimage {
            Some((UpdateKind::Both, server))
        } else if cli_old {
            Some((UpdateKind::CliOnly, server))
        } else {
            None
        }
    }

    /// The note of a failed update while its version is still the one offered.
    fn shown_update_note(&self) -> Option<String> {
        let (target, text) = self.update_note.as_ref()?;
        self.offer().is_some_and(|(_, offered)| &offered == target).then(|| text.clone())
    }

    fn appimage_note(&self) -> Option<String> {
        let server = self.queue.as_ref()?.server_version.as_ref()?;
        let newer = version_of(server).zip(version_of(&self.version)).is_some_and(|(s, t)| s > t);
        (self.appimage && newer).then(|| format!("fornax {server} is available: update the AppImage from the GitHub release"))
    }

    /// The server time now as far as the tray knows it, plus a margin: the update's own pause is never later than this.
    fn owed_bound(&self, now: i64) -> i64 {
        now + self.offset_ms + OWED_MARGIN_MS
    }

    /// Resume a queue the update paused. It is owed until a resume answers: when it cannot run now (a pause still runs,
    /// the server is down) or fails, it goes out later, for a pause no later than now.
    fn resume_if_ours(&mut self, ours: bool, now: i64) -> Vec<Effect> {
        if !ours {
            return Vec::new();
        }
        self.clear_owed();
        self.resume_owed = true;
        self.resume_before = Some(self.owed_bound(now));
        // The update's own pause still runs: its answer sends the resume.
        self.owed_after_pause = self.pending.contains(PAUSE) && self.pause_target == Some(true);
        self.action(PAUSE.to_string(), vec!["queue".into(), "resume".into()])
    }

    fn clear_owed(&mut self) {
        self.resume_owed = false;
        self.resume_before = None;
        self.owed_after_pause = false;
        self.owed_failures = 0;
        self.owed_retry_at = 0;
    }

    /// Send an owed resume when it can go: the server answers, no pause action runs, no update owns the queue, its
    /// retry time came, and the last line shows the update's pause.
    fn send_owed(&mut self, now: i64) -> Vec<Effect> {
        let due = self.resume_owed && self.update.is_none() && self.can_act() && !self.pending.contains(PAUSE) && now >= self.owed_retry_at;
        if !due || !self.queue.as_ref().is_some_and(|q| q.paused && self.owed_pause(q)) {
            return Vec::new();
        }
        self.action(PAUSE.to_string(), vec!["queue".into(), "resume".into()])
    }

    /// Whether the paused queue of a line is still the pause an owed resume is for.
    fn owed_pause(&self, q: &Queue) -> bool {
        match (self.resume_before, q.paused_at.as_deref().and_then(iso_ms)) {
            (Some(bound), Some(at)) => at <= bound,
            // A server before 0.7.2 or a marker of a tray before 0.7.2: any pause.
            _ => true,
        }
    }

    /// Update is off while a pause action runs and until a queue line shows its answer: the update reads from the line
    /// whether it pauses the queue itself (and so resumes it afterwards).
    fn can_update(&self) -> bool {
        self.offer().is_some() && self.can_act() && !self.pending.contains(PAUSE) && !self.pause_unseen
    }

    fn start_update(&mut self, now: i64) -> Vec<Effect> {
        let Some((kind, target)) = self.offer().filter(|_| self.can_update()) else {
            return Vec::new();
        };
        let paused = self.queue.as_ref().is_some_and(|q| q.paused);
        // A pause whose resume is owed is an update's own: this update takes it over and resumes it afterwards.
        let adopted = self.resume_owed && self.queue.as_ref().is_some_and(|q| q.paused && self.owed_pause(q));
        self.clear_owed();
        self.update_note = None;
        self.update = Some(Update { target: target.clone(), kind, phase: UpdatePhase::Waiting, paused_by_us: !paused || adopted });
        self.push_log(now, format!("updating to {target}"), false);
        let mut effects = if paused { Vec::new() } else { self.action(PAUSE.to_string(), vec!["queue".into(), "pause".into()]) };
        effects.extend(self.advance_update());
        effects
    }

    /// Spec 06d 4.3 step 2: once the queue is paused and nothing runs, fornax update.
    fn advance_update(&mut self) -> Vec<Effect> {
        let ready = match (&self.update, &self.queue) {
            (Some(u), Some(q)) => {
                u.phase == UpdatePhase::Waiting && q.paused && q.running.is_none() && !self.pending.contains(PAUSE) && !self.pause_unseen
            }
            _ => false,
        };
        if !ready {
            return Vec::new();
        }
        if let Some(u) = &mut self.update {
            u.phase = UpdatePhase::Cli;
        }
        vec![Effect::RunUpdate]
    }

    fn cancel_update(&mut self, now: i64) -> Vec<Effect> {
        match self.update.take() {
            Some(u) if u.phase == UpdatePhase::Waiting => {
                self.push_log(now, "update cancelled".to_string(), false);
                self.resume_if_ours(u.paused_by_us, now)
            }
            other => {
                self.update = other;
                Vec::new()
            }
        }
    }

    fn update_ran(&mut self, result: Result<(), String>, now: i64) -> Vec<Effect> {
        let Some(u) = self.update.clone().filter(|u| u.phase == UpdatePhase::Cli) else {
            return Vec::new();
        };
        match (result, u.kind) {
            (Err(message), _) => {
                self.update = None;
                self.update_note = Some((u.target.clone(), format!("The update failed: {message}")));
                self.push_log(now, format!("the update failed: {message}"), true);
                self.resume_if_ours(u.paused_by_us, now)
            }
            (Ok(()), UpdateKind::CliOnly) => {
                self.update = None;
                let mut effects = self.resume_if_ours(u.paused_by_us, now);
                self.cli_checking = true;
                effects.push(Effect::CheckCli);
                effects
            }
            (Ok(()), UpdateKind::Both) => {
                if let Some(u) = &mut self.update {
                    u.phase = UpdatePhase::Installing;
                }
                vec![Effect::StartTrayInstall { target: u.target, resume_before: u.paused_by_us.then(|| self.owed_bound(now)) }]
            }
        }
    }

    fn install_started(&mut self, result: Result<(), String>, now: i64) -> Vec<Effect> {
        let Some(u) = self.update.clone().filter(|u| u.phase == UpdatePhase::Installing) else {
            return Vec::new();
        };
        match result {
            Ok(()) => {
                self.push_log(now, format!("installing the tray {}; it starts again by itself", u.target), false);
                self.quit_now()
            }
            Err(message) => {
                self.update = None;
                self.update_note = Some((u.target.clone(), format!("The tray update could not start: {message}")));
                self.push_log(now, format!("the tray update could not start: {message}"), true);
                self.resume_if_ours(u.paused_by_us, now)
            }
        }
    }

    /// Spec 06d 4.1.
    fn versions(&self) -> String {
        let mut parts = vec![format!("tray {}", self.version)];
        if let Some(cli) = &self.cli_version {
            parts.push(format!("fornax {cli}"));
        }
        if let Some(server) = self.queue.as_ref().and_then(|q| q.server_version.as_ref()) {
            parts.push(format!("server {server}"));
        }
        parts.join(" · ")
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
                if line.starts_with("offering") {
                    self.offering_seen = true;
                }
                self.last_line = Some(line.clone());
                self.push_log(now, line, false);
            }
            WorkerEvent::Restarting => {
                if matches!(self.own, Own::Starting | Own::Running) {
                    self.own = Own::Restarting;
                }
                self.push_log(now, "the worker restarts for a new version".to_string(), false);
            }
            WorkerEvent::Stopped { code } => {
                self.types = None;
                self.push_log(now, format!("the worker stopped (code {code})"), code != 0);
            }
            WorkerEvent::Types { types } => {
                self.types = Some(
                    types
                        .into_iter()
                        .filter(|t| TYPE_STATES.contains(&t.state.as_str()))
                        .map(|t| TypeView { name: t.name, state: t.state, reason: t.reason })
                        .collect(),
                );
            }
            WorkerEvent::Other => {}
        }
    }

    fn worker_exited(&mut self, code: Option<i32>, now: i64) {
        let asked = matches!(self.own, Own::Stopping | Own::StoppingNow);
        self.own = Own::Stopped;
        self.stop_deadline = None;
        self.types = None;
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
        let mut effects = self.notifications(&queue);
        // A line built before the last pause or resume answered (read after it) does not show that action yet.
        let older = self.answer_time.zip(iso_ms(&queue.server_time)).is_some_and(|(answer, line)| line < answer);
        self.queue = Some(queue);
        if !older {
            self.pause_unseen = false;
            self.answer_time = None;
        }
        // The note of a failed update goes once its version is no longer the one offered.
        if self.update_note.is_some() && self.shown_update_note().is_none() {
            self.update_note = None;
        }
        // Spec 06d 4.3: a resume owed for a queue an update paused (also by the tray before this one). A line that shows
        // the queue running, or paused after the update ended, pays it (that pause is not undone); only a line older
        // than the update's pause, read while that pause is still on its way, says nothing yet.
        let pause_on_its_way = self.pending.contains(PAUSE) && self.pause_target == Some(true);
        if self.resume_owed && !older && !pause_on_its_way {
            if let Some((paused, ours)) = self.queue.as_ref().map(|q| (q.paused, self.owed_pause(q))) {
                if !paused || !ours {
                    self.clear_owed();
                }
                if paused && !ours {
                    self.push_log(now, "the queue was paused again after the update: it stays paused".to_string(), false);
                }
            }
        }
        effects.extend(self.send_owed(now));
        effects.extend(self.advance_update());
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
        // A failed owed resume goes out again once its pause is over, also when no queue line comes.
        effects.extend(self.send_owed(now));
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

    /// Spec 06c 4.1: the worker runs (the tray's own, or one outside the tray), nothing runs, and the server passes on
    /// the worker's reason to take no job.
    fn card_wait(&self) -> Option<&Waiting> {
        let runs = self.own == Own::Running || (self.own == Own::Stopped && self.external);
        let q = self.queue.as_ref().filter(|q| runs && q.running.is_none())?;
        q.worker.waiting.as_ref()
    }

    /// Spec 06c 4.2: the headline and tooltip while the worker waits for the card, from the reason's fields.
    fn card_text(w: &Waiting) -> String {
        match (w.reason.as_str(), w.used_mib, w.total_mib, w.limit_mib) {
            ("gpu_busy", Some(used), Some(total), Some(limit)) => {
                format!("Waiting for the card: {used} of {total} MiB in use by other programs, limit {limit} MiB")
            }
            ("gpu_unreadable", ..) => match &w.error {
                Some(error) => format!("Waiting for the card: it cannot be read ({error})"),
                None => "Waiting for the card: it cannot be read".to_string(),
            },
            _ => "Waiting for the card".to_string(),
        }
    }

    /// Spec 06c 4.3: why the Types section has no list.
    fn types_note(&self) -> Option<String> {
        if self.types.is_some() {
            return None;
        }
        Some(
            match self.own {
                Own::Stopped if self.external => "The worker runs outside the tray; its types show only when the tray runs it.",
                Own::Stopped => "The worker is stopped.",
                _ if self.offering_seen => "This fornax does not report its types; update it.",
                _ => "Checking the types…",
            }
            .to_string(),
        )
    }

    fn headline(&self) -> String {
        if self.quitting {
            return "Stopping the worker and quitting…".to_string();
        }
        if let Some(u) = &self.update {
            let running = self.queue.as_ref().is_some_and(|q| q.running.is_some());
            return match (u.phase, u.kind) {
                (UpdatePhase::Installing, _) => format!("Installing the tray {}…", u.target),
                (UpdatePhase::Waiting, UpdateKind::Both) if running => format!("Updating to {} after the running job…", u.target),
                (UpdatePhase::Waiting, UpdateKind::CliOnly) if running => format!("Updating fornax to {} after the running job…", u.target),
                // Nothing runs, so only the pause is still on its way (its answer, or the queue line that shows it).
                (UpdatePhase::Waiting, UpdateKind::Both) => format!("Pausing the queue to update to {}…", u.target),
                (UpdatePhase::Waiting, UpdateKind::CliOnly) => format!("Pausing the queue to update fornax to {}…", u.target),
                (UpdatePhase::Cli, _) => format!("Updating fornax to {}…", u.target),
            };
        }
        if self.cli == Cli::Ready {
            if let Some(w) = self.card_wait() {
                return Self::card_text(w);
            }
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

    /// Spec 06 4.3 and 06c 4.1, first match wins.
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
        if self.card_wait().is_some() {
            return Icon::Card;
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
            can_pause: self.can_act() && !self.pending.contains(PAUSE) && self.update.is_none(),
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
            types: self.types.clone().unwrap_or_default(),
            types_note: self.types_note(),
            versions: self.versions(),
            update_label: self.offer().map(|(kind, v)| match kind {
                UpdateKind::Both => format!("Update to {v}"),
                UpdateKind::CliOnly => format!("Update fornax to {v}"),
            }),
            can_update: self.can_update(),
            can_cancel_update: self.update.as_ref().is_some_and(|u| u.phase == UpdatePhase::Waiting),
            updating: self.update.is_some(),
            update_note: self.shown_update_note().or_else(|| self.appimage_note()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::protocol::{TypeInfo, Waiting, WorkerInfo};

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
            server_version: None,
            paused,
            paused_at: None,
            worker: WorkerInfo { online: false, last_seen: None, version: None, waiting: None },
            running,
            queued,
            finished,
        })))
    }

    /// A queue line in which the worker is online and reports why it takes no job.
    fn waiting_queue(waiting: Waiting, running: Option<Job>, paused: bool) -> Input {
        Input::Watch(WatchLine::Queue(Box::new(Queue {
            server_time: "2026-11-15T14:00:00.000Z".into(),
            change: "0123456789abcdef".into(),
            server_version: None,
            paused,
            paused_at: None,
            worker: WorkerInfo { online: true, last_seen: None, version: None, waiting: Some(waiting) },
            running,
            queued: vec![],
            finished: vec![],
        })))
    }

    fn unreadable(error: Option<&str>) -> Waiting {
        Waiting {
            reason: "gpu_unreadable".into(), message: "waiting: the worker cannot read the card".into(), error: error.map(Into::into),
            used_mib: None, total_mib: None, limit_mib: Some(768),
        }
    }

    fn busy_card() -> Waiting {
        Waiting {
            reason: "gpu_busy".into(), message: "waiting: in use".into(), error: None,
            used_mib: Some(9000), total_mib: Some(16311), limit_mib: Some(768),
        }
    }

    fn type_info(name: &str, state: &str, reason: Option<&str>) -> TypeInfo {
        TypeInfo { name: name.into(), state: state.into(), reason: reason.map(Into::into) }
    }

    /// A queue line from a server of `server` (None: older than 0.7.0).
    fn versioned(server: Option<&str>, running: Option<Job>, paused: bool) -> Input {
        Input::Watch(WatchLine::Queue(Box::new(Queue {
            server_time: "2026-11-15T14:00:00.000Z".into(),
            change: "0123456789abcdef".into(),
            server_version: server.map(Into::into),
            paused,
            paused_at: None,
            worker: WorkerInfo { online: true, last_seen: None, version: None, waiting: None },
            running,
            queued: vec![],
            finished: vec![],
        })))
    }

    /// A tray 0.7.0 with fornax 0.7.0 and its worker running.
    fn current() -> Model {
        let mut m = Model::new();
        m.apply(launched(true), NOW);
        m.apply(checked("0.7.0", false), NOW);
        m.apply(Input::WorkerEvent(WorkerEvent::Started { version: "0.7.0".into(), pid: 7 }), NOW);
        m
    }

    fn pause_args(paused: bool) -> Effect {
        Effect::RunAction { key: PAUSE.into(), args: vec!["queue".into(), if paused { "pause" } else { "resume" }.into()] }
    }

    /// A pause or resume with fornax 0.7.2 or newer: the answer's queue as JSON.
    fn pause_json(paused: bool) -> Effect {
        Effect::RunAction { key: PAUSE.into(), args: vec!["queue".into(), if paused { "pause" } else { "resume" }.into(), "--json".into()] }
    }

    fn launched(start_worker: bool) -> Input {
        Input::Launched { start_worker, warnings: Vec::new(), version: "0.7.0".into(), appimage: false, update_done: None }
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
    fn the_card_wait_shows_in_the_icon_headline_and_tooltip() {
        let mut m = running_worker();
        m.apply(waiting_queue(unreadable(Some("nvidia-smi: exit code 4")), None, false), NOW);
        let s = m.snapshot();
        assert_eq!(s.icon, Icon::Card);
        assert_eq!(s.headline, "Waiting for the card: it cannot be read (nvidia-smi: exit code 4)");
        assert_eq!(s.tooltip, "Fornax: Waiting for the card: it cannot be read (nvidia-smi: exit code 4)");
        // A server older than 0.6.0 sends no error: no empty parenthesis.
        m.apply(waiting_queue(unreadable(None), None, false), NOW);
        assert_eq!(m.snapshot().headline, "Waiting for the card: it cannot be read");
        m.apply(waiting_queue(busy_card(), None, false), NOW);
        assert_eq!(m.snapshot().headline, "Waiting for the card: 9000 of 16311 MiB in use by other programs, limit 768 MiB");
        // A reason this tray does not know.
        let mut other = busy_card();
        other.reason = "gpu_something".into();
        m.apply(waiting_queue(other, None, false), NOW);
        assert_eq!(m.snapshot().headline, "Waiting for the card");
        // The card comes before a pause; the pause button still says what it does.
        m.apply(waiting_queue(unreadable(Some("nvidia-smi: exit code 4")), None, true), NOW);
        let s = m.snapshot();
        assert_eq!((s.icon, s.pause_label.as_str()), (Icon::Card, "Resume queue"));
        // A running job comes before the card.
        m.apply(waiting_queue(unreadable(Some("nvidia-smi: exit code 4")), Some(job("R1", "running")), false), NOW);
        assert_eq!(m.snapshot().icon, Icon::Busy);
        // A long error still fits a Windows tooltip.
        let long = "x".repeat(300);
        m.apply(waiting_queue(unreadable(Some(&long)), None, false), NOW);
        assert!(m.snapshot().tooltip.encode_utf16().count() <= TOOLTIP_UNITS);
    }

    #[test]
    fn the_card_wait_needs_a_running_worker() {
        // The tray's own worker stopped: the server's last reason is no card state.
        let mut m = ready(false);
        m.apply(waiting_queue(unreadable(Some("nvidia-smi: exit code 4")), None, false), NOW);
        let s = m.snapshot();
        assert_eq!((s.icon, s.headline.as_str()), (Icon::Stopped, "Worker stopped · queue active"));
        // A worker outside the tray that waits for the card.
        let mut m = Model::new();
        m.apply(launched(false), NOW);
        m.apply(checked("0.6.0", true), NOW);
        m.apply(waiting_queue(unreadable(Some("nvidia-smi: exit code 4")), None, false), NOW);
        assert_eq!(m.snapshot().icon, Icon::Card);
        // While the tray's worker starts, the worker's phrase wins.
        let mut m = ready(true);
        m.apply(waiting_queue(unreadable(Some("nvidia-smi: exit code 4")), None, false), NOW);
        let s = m.snapshot();
        assert_eq!((s.icon, s.headline.as_str()), (Icon::Idle, "Starting the worker… · queue active"));
    }

    #[test]
    fn the_types_section_follows_the_worker() {
        let mut m = ready(false);
        let s = m.snapshot();
        assert_eq!((s.types.len(), s.types_note.as_deref()), (0, Some("The worker is stopped.")));
        m.apply(Input::StartWorker, NOW);
        assert_eq!(m.snapshot().types_note.as_deref(), Some("Checking the types…"));
        m.apply(Input::WorkerEvent(WorkerEvent::Started { version: "0.6.0".into(), pid: 7 }), NOW);
        let types = vec![
            type_info("lease", "offered", None),
            type_info("newer", "sleeping", Some("a state of a newer CLI")),
            type_info("transcribe", "unavailable", Some("check failed (exit code 3)")),
            type_info("upscale", "waiting", Some("waiting for the card")),
        ];
        m.apply(Input::WorkerEvent(WorkerEvent::Types { types }), NOW);
        let s = m.snapshot();
        assert_eq!(s.types_note, None);
        assert_eq!(
            s.types,
            vec![
                TypeView { name: "lease".into(), state: "offered".into(), reason: None },
                TypeView { name: "transcribe".into(), state: "unavailable".into(), reason: Some("check failed (exit code 3)".into()) },
                TypeView { name: "upscale".into(), state: "waiting".into(), reason: Some("waiting for the card".into()) },
            ]
        );
        // A restart keeps the list until the new worker reports its own.
        m.apply(Input::WorkerEvent(WorkerEvent::Restarting), NOW);
        assert_eq!(m.snapshot().types.len(), 3);
        // The worker stopped: the list is gone.
        m.apply(Input::WorkerEvent(WorkerEvent::Stopped { code: 0 }), NOW);
        m.apply(Input::WorkerExited { code: Some(0) }, NOW);
        let s = m.snapshot();
        assert_eq!((s.types.len(), s.types_note.as_deref()), (0, Some("The worker is stopped.")));
        // An older CLI offers types but never reports them.
        m.apply(Input::StartWorker, NOW);
        m.apply(Input::WorkerEvent(WorkerEvent::Log { line: "offering: echo".into() }), NOW);
        assert_eq!(m.snapshot().types_note.as_deref(), Some("This fornax does not report its types; update it."));
        // An empty list is a list: the window says there are no packs.
        m.apply(Input::WorkerEvent(WorkerEvent::Types { types: vec![] }), NOW);
        assert_eq!(m.snapshot().types_note, None);
        // A worker outside the tray.
        let mut m = Model::new();
        m.apply(launched(false), NOW);
        m.apply(checked("0.6.0", true), NOW);
        assert_eq!(m.snapshot().types_note.as_deref(), Some("The worker runs outside the tray; its types show only when the tray runs it."));
    }

    #[test]
    fn the_versions_line_and_the_offer_follow_the_versions() {
        let mut m = current();
        m.apply(versioned(None, None, false), NOW);
        let s = m.snapshot();
        assert_eq!((s.versions.as_str(), s.update_label.clone(), s.can_update), ("tray 0.7.0 · fornax 0.7.0", None, false));
        m.apply(versioned(Some("0.7.0"), None, false), NOW);
        assert_eq!((m.snapshot().versions, m.snapshot().update_label), ("tray 0.7.0 · fornax 0.7.0 · server 0.7.0".to_string(), None));
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        let s = m.snapshot();
        assert_eq!((s.update_label.as_deref(), s.can_update), (Some("Update to 0.7.1"), true));
        // The tray is current, the CLI is not.
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: false, warnings: vec![], version: "0.7.1".into(), appimage: false, update_done: None }, NOW);
        m.apply(checked("0.7.0", false), NOW);
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        assert_eq!(m.snapshot().update_label.as_deref(), Some("Update fornax to 0.7.1"));
        // An AppImage tray: no tray update, a note; the CLI update is still offered.
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: false, warnings: vec![], version: "0.7.0".into(), appimage: true, update_done: None }, NOW);
        m.apply(checked("0.7.0", false), NOW);
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        let s = m.snapshot();
        assert_eq!(s.update_label.as_deref(), Some("Update fornax to 0.7.1"));
        assert_eq!(s.update_note.as_deref(), Some("fornax 0.7.1 is available: update the AppImage from the GitHub release"));
    }

    #[test]
    fn an_update_pauses_waits_for_the_running_job_updates_fornax_and_starts_the_installer() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![pause_args(true)]);
        let s = m.snapshot();
        assert_eq!((s.headline.as_str(), s.can_cancel_update, s.can_update), ("Updating to 0.7.1 after the running job…", true, false));
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        // Paused, the job still runs: nothing yet.
        assert_eq!(m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), true), NOW), vec![]);
        // The job is done: fornax update.
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
        assert_eq!(m.snapshot().headline, "Updating fornax to 0.7.1…");
        m.apply(Input::UpdateText("updated fornax 0.7.0 → 0.7.1".into()), NOW);
        assert_eq!(m.snapshot().log.last().map(|l| l.text.as_str()), Some("updated fornax 0.7.0 → 0.7.1"));
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW), vec![Effect::StartTrayInstall { target: "0.7.1".into(), resume_before: Some(SERVER + OWED_MARGIN_MS) }]);
        assert_eq!(m.snapshot().headline, "Installing the tray 0.7.1…");
        // The helper started: stop the worker and quit, without asking.
        assert_eq!(m.apply(Input::TrayInstallStarted(Ok(())), NOW), vec![Effect::SendStop, Effect::ExitAfterStop]);
        assert!(!m.snapshot().confirm_quit);
    }

    #[test]
    fn an_already_paused_queue_is_not_resumed_by_the_update() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, true), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![Effect::RunUpdate]);
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW), vec![Effect::StartTrayInstall { target: "0.7.1".into(), resume_before: None }]);
    }

    /// Review 0.7.1 Important: an Update clicked while the operator's own pause or resume is on its way, or before the
    /// queue line shows its answer.
    #[test]
    fn an_update_waits_for_a_queue_line_after_any_pause_or_resume() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::SetPaused(true), NOW);
        assert!(!m.snapshot().can_update);
        assert_eq!(m.apply(Input::Update, NOW), vec![]);
        // Resumed by hand: answered, but the line still says paused.
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, true), NOW);
        m.apply(Input::SetPaused(false), NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert!(!m.snapshot().can_update);
        assert_eq!(m.apply(Input::Update, NOW), vec![]);
        // The line shows the resume (and a job claimed meanwhile): the update pauses for itself and resumes afterwards.
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![pause_args(true)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), true), NOW), vec![]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW), vec![Effect::StartTrayInstall { target: "0.7.1".into(), resume_before: Some(SERVER + OWED_MARGIN_MS) }]);
    }

    /// Review 0.7.1: the update's pause answered while the last line says nothing runs; a job claimed just before the
    /// pause shows only in the next line, so fornax update waits for it.
    #[test]
    fn fornax_update_waits_for_the_line_after_the_pause() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), true), NOW), vec![]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
    }

    #[test]
    fn a_failed_fornax_update_or_helper_resumes_the_queue_and_says_why() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        m.apply(versioned(Some("0.7.1"), None, true), NOW);
        assert_eq!(m.apply(Input::UpdateRan(Err("cannot reach the server".into())), NOW), vec![pause_args(false)]);
        let s = m.snapshot();
        assert_eq!((s.update_note.as_deref(), s.can_cancel_update), (Some("The update failed: cannot reach the server"), false));
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        // Again once a line shows the resume, up to the helper, which cannot start.
        assert!(!m.snapshot().can_update);
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
        m.apply(Input::UpdateRan(Ok(())), NOW);
        // This time the update paused the queue (the line showed it active): it resumes it.
        assert_eq!(m.apply(Input::TrayInstallStarted(Err("node was not found".into())), NOW), vec![pause_args(false)]);
        assert_eq!(m.snapshot().update_note.as_deref(), Some("The tray update could not start: node was not found"));
        assert_eq!(m.snapshot().headline, "Worker running · queue paused");
    }

    #[test]
    fn a_pause_that_fails_cancels_the_update() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        // The pause may have gone through anyway (an answer lost on the way): resume, which a queue not paused ignores.
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("cannot reach the server".into()) }, NOW), vec![pause_args(false)]);
        let s = m.snapshot();
        assert_eq!((s.update_note.as_deref(), s.can_update), (Some("The update could not pause the queue: cannot reach the server"), false));
        // Update comes back once the resume answered; it changed nothing the line shows, so no line is waited for.
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![]);
        assert!(m.snapshot().can_update);
    }

    /// Review 06d minor: a pause that timed out but went through on the server was left paused.
    #[test]
    fn a_failed_pause_while_the_server_is_down_resumes_only_a_queue_that_turns_out_paused() {
        let timeout = || Input::ActionDone { key: PAUSE.into(), result: Err("fornax queue pause did not finish within 30 s".into()) };
        let down = || Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server".into() });
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(down(), NOW);
        assert_eq!(m.apply(timeout(), NOW), vec![]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![pause_args(false)]);
        // The pause did not go through: nothing to resume, and nothing owed afterwards.
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(down(), NOW);
        m.apply(timeout(), NOW);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, false), NOW), vec![]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![]);
    }

    /// Review 06d minor: the note of a failed update stayed until the next click.
    #[test]
    fn an_update_note_goes_with_its_offer() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("cannot reach the server".into()) }, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.snapshot().update_note.as_deref(), Some("The update could not pause the queue: cannot reach the server"));
        m.apply(versioned(Some("0.7.2"), None, false), NOW);
        let s = m.snapshot();
        assert_eq!((s.update_label.as_deref(), s.update_note), (Some("Update to 0.7.2"), None));
        // Gone for good: an offer of 0.7.1 again does not bring the old note back.
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        assert_eq!(m.snapshot().update_note, None);
    }

    /// Review 06d minor: a manual resume during the update's wait left "Updating…" until Cancel.
    #[test]
    fn pause_and_resume_are_off_during_an_update() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), true), NOW);
        assert!(!m.snapshot().can_pause);
        assert_eq!(m.apply(Input::SetPaused(false), NOW), vec![]);
        m.apply(Input::CancelUpdate, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert!(m.snapshot().can_pause);
    }

    /// Review 06d minors: the menu said "No update" in the later phases; the headline said "Updating" before the pause.
    #[test]
    fn every_phase_of_an_update_is_shown() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        assert!(!m.snapshot().updating);
        m.apply(Input::Update, NOW);
        let s = m.snapshot();
        assert_eq!((s.updating, s.headline.as_str()), (true, "Pausing the queue to update to 0.7.1…"));
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        // Answered, but no queue line has shown the pause yet.
        assert_eq!(m.snapshot().headline, "Pausing the queue to update to 0.7.1…");
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
        let s = m.snapshot();
        assert_eq!((s.updating, s.can_cancel_update, s.headline.as_str()), (true, false, "Updating fornax to 0.7.1…"));
        m.apply(Input::UpdateRan(Ok(())), NOW);
        let s = m.snapshot();
        assert_eq!((s.updating, s.headline.as_str()), (true, "Installing the tray 0.7.1…"));
    }

    #[test]
    fn cancel_and_quit_during_an_update_resume_the_queue() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.apply(Input::CancelUpdate, NOW), vec![pause_args(false)]);
        assert_eq!(m.snapshot().headline, "Worker running · queue active");
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        // Quit while waiting: resume first, then the usual question.
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.apply(Input::Quit, NOW), vec![pause_args(false)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![Effect::ShowWindow]);
        assert!(m.snapshot().confirm_quit);
        // The answer of a cancelled fornax update changes nothing.
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW), vec![]);
    }

    /// Review 06d Important 3: a resume that cannot run now is owed, not dropped.
    #[test]
    fn a_cancel_while_the_pause_runs_resumes_once_the_pause_answered() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![pause_args(true)]);
        assert_eq!(m.apply(Input::CancelUpdate, NOW), vec![]);
        // A queue line from before the pause does not drop the owed resume.
        assert_eq!(m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW), vec![]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![pause_args(false)]);
        assert!(!m.snapshot().can_update);
        // The resume brought the queue back to what the last line says: no line comes (the watch saw no change), and
        // Update is back without one.
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![]);
        assert!(m.snapshot().can_update);
    }

    #[test]
    fn a_quit_while_the_pause_runs_resumes_then_quits() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), Some(job("R1", "running")), false), NOW);
        m.apply(Input::Update, NOW);
        assert_eq!(m.apply(Input::Quit, NOW), vec![]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![pause_args(false)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW), vec![Effect::ShowWindow]);
    }

    #[test]
    fn a_failed_update_while_the_server_is_down_resumes_when_it_is_back() {
        let mut m = current();
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
        m.apply(Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server".into() }), NOW);
        assert_eq!(m.apply(Input::UpdateRan(Err("cannot reach the server".into())), NOW), vec![]);
        // The server is back: the queue the update paused is resumed.
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![pause_args(false)]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![]);
    }

    #[test]
    fn an_update_of_fornax_only_checks_fornax_again_and_resumes() {
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: false, warnings: vec![], version: "0.7.1".into(), appimage: false, update_done: None }, NOW);
        m.apply(checked("0.7.0", false), NOW);
        m.apply(versioned(Some("0.7.1"), None, false), NOW);
        m.apply(Input::Update, NOW);
        assert_eq!(m.snapshot().headline, "Pausing the queue to update fornax to 0.7.1…");
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![Effect::RunUpdate]);
        assert_eq!(m.snapshot().headline, "Updating fornax to 0.7.1…");
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW), vec![pause_args(false), Effect::CheckCli]);
        m.apply(checked("0.7.1", false), NOW);
        assert_eq!(m.snapshot().versions, "tray 0.7.1 · fornax 0.7.1 · server 0.7.1");
    }

    #[test]
    fn an_update_with_a_worker_outside_the_tray_exits_at_once() {
        let mut m = Model::new();
        m.apply(launched(false), NOW);
        m.apply(checked("0.7.0", true), NOW);
        m.apply(versioned(Some("0.7.1"), None, true), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![Effect::RunUpdate]);
        m.apply(Input::UpdateRan(Ok(())), NOW);
        assert_eq!(m.apply(Input::TrayInstallStarted(Ok(())), NOW), vec![Effect::Exit]);
    }

    #[test]
    fn the_next_tray_reads_the_marker() {
        let done = |target: &str, resume_queue: bool| UpdateDone { target: target.into(), resume_queue, resume_before: None, last_line: Some("the installation was cancelled".into()) };
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: false, warnings: vec![], version: "0.7.1".into(), appimage: false, update_done: Some(done("0.7.1", true)) }, NOW);
        assert_eq!(m.snapshot().log.last().map(|l| l.text.as_str()), Some("updated to 0.7.1"));
        m.apply(checked("0.7.1", false), NOW);
        // The queue the old tray paused is resumed once it is known.
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![pause_args(false)]);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![]);
        let mut m = Model::new();
        m.apply(Input::Launched { start_worker: false, warnings: vec![], version: "0.7.0".into(), appimage: false, update_done: Some(done("0.7.1", false)) }, NOW);
        let last = m.snapshot().log.last().map(|l| (l.text.clone(), l.error));
        assert_eq!(last, Some(("the tray update to 0.7.1 did not install: the installation was cancelled".to_string(), true)));
        m.apply(checked("0.7.0", false), NOW);
        assert_eq!(m.apply(versioned(Some("0.7.1"), None, true), NOW), vec![]);
    }

    /// A queue line of a 0.7.2 server built at `time`, paused since `paused_at` (None: the queue runs).
    fn line_at(time: &str, running: Option<Job>, paused_at: Option<&str>) -> Input {
        Input::Watch(WatchLine::Queue(Box::new(Queue {
            server_time: time.into(),
            change: "0123456789abcdef".into(),
            server_version: Some("0.7.2".into()),
            paused: paused_at.is_some(),
            paused_at: paused_at.map(Into::into),
            worker: WorkerInfo { online: true, last_seen: None, version: None, waiting: None },
            running,
            queued: vec![],
            finished: vec![],
        })))
    }

    fn server_down() -> Input {
        Input::Watch(WatchLine::Failed { error: "network".into(), message: "cannot reach the server".into() })
    }

    /// 0.7.1 deferred: an owed resume could undo a pause made outside the tray after the update ended.
    #[test]
    fn an_owed_resume_leaves_a_pause_made_after_the_update_ended() {
        let t0 = "2026-11-15T14:00:00.000Z";
        let failed_while_down = || {
            let mut m = current();
            m.apply(line_at(t0, None, None), NOW);
            m.apply(Input::Update, NOW);
            m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
            assert_eq!(m.apply(line_at(t0, None, Some("2026-11-15T13:59:59.000Z")), NOW), vec![Effect::RunUpdate]);
            m.apply(server_down(), NOW);
            assert_eq!(m.apply(Input::UpdateRan(Err("cannot reach the server".into())), NOW), vec![]);
            m
        };
        // Back with the update's own pause: resumed.
        let mut m = failed_while_down();
        assert_eq!(m.apply(line_at("2026-11-15T14:01:30.000Z", None, Some("2026-11-15T13:59:59.000Z")), NOW + 90_000), vec![pause_args(false)]);
        // Back with a pause made after the update ended (resumed and paused again by hand): it stays, nothing is owed.
        let mut m = failed_while_down();
        assert_eq!(m.apply(line_at("2026-11-15T14:01:30.000Z", None, Some("2026-11-15T14:01:00.000Z")), NOW + 90_000), vec![]);
        assert_eq!(m.snapshot().log.last().map(|l| l.text.as_str()), Some("the queue was paused again after the update: it stays paused"));
        assert_eq!(m.apply(line_at("2026-11-15T14:01:40.000Z", None, Some("2026-11-15T14:01:00.000Z")), NOW + 100_000), vec![]);
    }

    #[test]
    fn the_next_tray_resumes_only_the_pause_the_update_made() {
        let mut m = current();
        m.apply(line_at("2026-11-15T14:00:00.000Z", None, None), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        m.apply(line_at("2026-11-15T14:00:00.000Z", None, Some("2026-11-15T13:59:59.000Z")), NOW);
        let bound = SERVER + OWED_MARGIN_MS;
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW), vec![Effect::StartTrayInstall { target: "0.7.2".into(), resume_before: Some(bound) }]);
        let next = |paused_at: &str| {
            let done = UpdateDone { target: "0.7.2".into(), resume_queue: true, resume_before: Some(bound), last_line: None };
            let mut m = Model::new();
            m.apply(Input::Launched { start_worker: false, warnings: vec![], version: "0.7.2".into(), appimage: false, update_done: Some(done) }, NOW);
            m.apply(checked("0.7.2", false), NOW);
            m.apply(line_at("2026-11-15T14:02:00.000Z", None, Some(paused_at)), NOW + 120_000)
        };
        assert_eq!(next("2026-11-15T13:59:59.000Z"), vec![pause_json(false)]);
        assert_eq!(next("2026-11-15T14:01:00.000Z"), vec![]);
    }

    /// 0.7.1 deferred: no test of a failed resume after a failed update pause; it was dropped.
    #[test]
    fn a_failed_resume_after_a_failed_update_pause_stays_owed() {
        let mut m = current();
        m.apply(line_at("2026-11-15T14:00:00.000Z", None, None), NOW);
        m.apply(Input::Update, NOW);
        let timeout = Input::ActionDone { key: PAUSE.into(), result: Err("fornax queue pause did not finish within 30 s".into()) };
        assert_eq!(m.apply(timeout, NOW), vec![pause_args(false)]);
        // The resume fails too: not sent again at once (it would fail the same way), but at the next line.
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("cannot reach the server".into()) }, NOW), vec![]);
        // The pause had gone through.
        assert_eq!(m.apply(line_at("2026-11-15T14:00:40.000Z", None, Some("2026-11-15T14:00:01.000Z")), NOW + 40_000), vec![pause_args(false)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW + 40_000), vec![]);
        // Answered: nothing is owed any more.
        assert_eq!(m.apply(line_at("2026-11-15T14:00:50.000Z", None, Some("2026-11-15T14:00:01.000Z")), NOW + 50_000), vec![]);
    }

    /// 0.7.1 deferred: a queue line built before the cancel's resume, arriving after its answer, still said paused, and
    /// a quick Update trusted it.
    #[test]
    fn a_queue_line_older_than_a_resume_does_not_bring_update_back() {
        let mut m = Model::new();
        m.apply(launched(true), NOW);
        m.apply(checked("0.7.2", false), NOW);
        m.apply(line_at("2026-11-15T14:00:00.000Z", Some(job("R1", "running")), None), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![pause_json(true)]);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(Some("2026-11-15T14:00:01.000Z".into())) }, NOW);
        m.apply(line_at("2026-11-15T14:00:01.000Z", Some(job("R1", "running")), Some("2026-11-15T14:00:01.000Z")), NOW);
        assert_eq!(m.apply(Input::CancelUpdate, NOW), vec![pause_json(false)]);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(Some("2026-11-15T14:00:05.000Z".into())) }, NOW);
        // Built before the resume (a job's progress), read after its answer.
        m.apply(line_at("2026-11-15T14:00:04.000Z", Some(job("R1", "running")), Some("2026-11-15T14:00:01.000Z")), NOW);
        assert!(!m.snapshot().can_update);
        assert_eq!(m.apply(Input::Update, NOW), vec![]);
        m.apply(line_at("2026-11-15T14:00:05.000Z", Some(job("R1", "running")), None), NOW);
        assert!(m.snapshot().can_update);
    }

    /// The update failed; its resume went through (a line showed the queue active while the CLI still ran), but the
    /// CLI's answer was lost.
    fn owed_after_a_lost_resume_answer() -> Model {
        let mut m = current();
        m.apply(line_at("2026-11-15T14:00:00.000Z", None, None), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        assert_eq!(m.apply(line_at("2026-11-15T14:00:01.000Z", None, Some("2026-11-15T14:00:01.000Z")), NOW + 1000), vec![Effect::RunUpdate]);
        assert_eq!(m.apply(Input::UpdateRan(Err("boom".into())), NOW + 2000), vec![pause_args(false)]);
        assert_eq!(m.apply(line_at("2026-11-15T14:00:03.000Z", None, None), NOW + 3000), vec![]);
        let lost = Input::ActionDone { key: PAUSE.into(), result: Err("fornax queue resume did not finish within 30 s".into()) };
        assert_eq!(m.apply(lost, NOW + 32_000), vec![]);
        m
    }

    /// Review 0.7.2 I1: an owed resume left over after the queue was seen active undid the user's next pause, or the
    /// next update's own pause (which then waited forever).
    #[test]
    fn a_line_showing_the_queue_active_pays_an_owed_resume() {
        let mut m = owed_after_a_lost_resume_answer();
        assert_eq!(m.apply(Input::SetPaused(true), NOW + 40_000), vec![pause_args(true)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW + 41_000), vec![]);
        assert_eq!(m.apply(line_at("2026-11-15T14:00:42.000Z", None, Some("2026-11-15T14:00:41.000Z")), NOW + 42_000), vec![]);
        assert!(!m.snapshot().log.iter().any(|l| l.text.contains("paused again")), "nothing was owed any more");
        let mut m = owed_after_a_lost_resume_answer();
        assert_eq!(m.apply(Input::Update, NOW + 40_000), vec![pause_args(true)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW + 41_000), vec![]);
        assert_eq!(m.apply(line_at("2026-11-15T14:00:42.000Z", None, Some("2026-11-15T14:00:41.000Z")), NOW + 42_000), vec![Effect::RunUpdate]);
    }

    /// Review 0.7.2 I2: Update clicked while a resume was owed took the pause for someone else's, and the old owed
    /// resume let jobs start during fornax update.
    #[test]
    fn a_new_update_takes_over_a_pause_whose_resume_is_owed() {
        let mut m = current();
        m.apply(line_at("2026-11-15T14:00:00.000Z", None, None), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        m.apply(line_at("2026-11-15T14:00:01.000Z", None, Some("2026-11-15T14:00:01.000Z")), NOW + 1000);
        assert_eq!(m.apply(Input::UpdateRan(Err("boom".into())), NOW + 2000), vec![pause_args(false)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("internal error".into()) }, NOW + 3000), vec![]);
        assert_eq!(m.apply(Input::Update, NOW + 4000), vec![Effect::RunUpdate]);
        // During fornax update neither a line nor a tick sends the old resume.
        assert_eq!(m.apply(line_at("2026-11-15T14:00:20.000Z", Some(job("R1", "running")), Some("2026-11-15T14:00:01.000Z")), NOW + 20_000), vec![]);
        assert!(!m.apply(Input::Tick, NOW + 25_000).contains(&pause_args(false)));
        // The update owns the pause now: the next tray resumes it.
        let install = Effect::StartTrayInstall { target: "0.7.2".into(), resume_before: Some(SERVER + 30_000 + OWED_MARGIN_MS) };
        assert_eq!(m.apply(Input::UpdateRan(Ok(())), NOW + 30_000), vec![install]);
    }

    /// Review 0.7.2 M1/M2: a failed owed resume waited for a line that may not come, or went out again at every line.
    #[test]
    fn a_failed_owed_resume_is_tried_again_after_growing_pauses() {
        let resume = pause_args(false);
        let mut m = current();
        m.apply(line_at("2026-11-15T14:00:00.000Z", Some(job("R1", "running")), None), NOW);
        m.apply(Input::Update, NOW);
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW);
        m.apply(line_at("2026-11-15T14:00:01.000Z", Some(job("R1", "running")), Some("2026-11-15T14:00:01.000Z")), NOW + 1000);
        assert_eq!(m.apply(Input::CancelUpdate, NOW + 2000), vec![resume.clone()]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("refused".into()) }, NOW + 3000), vec![]);
        // A progress line soon after: not yet.
        assert_eq!(m.apply(line_at("2026-11-15T14:00:04.000Z", Some(job("R1", "running")), Some("2026-11-15T14:00:01.000Z")), NOW + 4000), vec![]);
        assert!(!m.apply(Input::Tick, NOW + 7_999).contains(&resume));
        assert!(m.apply(Input::Tick, NOW + 8_000).contains(&resume));
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("refused".into()) }, NOW + 9_000);
        assert!(!m.apply(Input::Tick, NOW + 23_999).contains(&resume));
        assert!(m.apply(Input::Tick, NOW + 24_000).contains(&resume));
        m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW + 25_000);
        assert!(!m.apply(Input::Tick, NOW + 300_000).contains(&resume));
    }

    /// Review 0.7.2 M3: the bound was set at the Cancel, before the update's own pause reached the server.
    #[test]
    fn an_update_pause_that_lands_late_after_a_cancel_is_still_resumed() {
        let mut m = current();
        m.apply(line_at("2026-11-15T14:00:00.000Z", Some(job("R1", "running")), None), NOW);
        assert_eq!(m.apply(Input::Update, NOW), vec![pause_args(true)]);
        assert_eq!(m.apply(Input::CancelUpdate, NOW), vec![]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Ok(None) }, NOW + 9_000), vec![pause_args(false)]);
        assert_eq!(m.apply(Input::ActionDone { key: PAUSE.into(), result: Err("cannot reach the server".into()) }, NOW + 10_000), vec![]);
        let line = line_at("2026-11-15T14:00:20.000Z", Some(job("R1", "running")), Some("2026-11-15T14:00:08.000Z"));
        assert_eq!(m.apply(line, NOW + 20_000), vec![pause_args(false)]);
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
        m.apply(Input::ActionDone { key: "Q2".into(), result: Ok(None) }, NOW);
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
        m.apply(Input::Launched { start_worker: true, warnings: vec!["tray.json is not valid: expected value".into()], version: "0.7.0".into(), appimage: false, update_done: None }, NOW);
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
        m.apply(Input::Launched { start_worker: true, warnings: vec![guard.into(), broken.into()], version: "0.7.0".into(), appimage: false, update_done: None }, NOW);
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
                "canCancelUpdate", "canPause", "canStart", "canStop", "canUpdate", "confirmQuit", "finished", "headline", "icon",
                "log", "note", "offsetMs", "pauseError", "pauseLabel", "paused", "queueKnown", "queueNote", "queued", "running",
                "serverDownSinceMs", "serverMessage", "serverRefused", "startWorker", "stopLabel", "tooltip", "types",
                "typesNote", "updateLabel", "updateNote", "updating", "versions",
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
