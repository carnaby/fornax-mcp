//! What the CLI prints for the tray (spec 06 § 3): the events of `fornax worker --events` and the lines of
//! `fornax queue --json --watch`, plus the small parsers the model needs (server times, versions, links).

use std::collections::BTreeMap;

use serde::Deserialize;

/// One line of `fornax worker --events` (spec 06 3.2).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum WorkerEvent {
    /// The worker (the supervisor's child) started; after `fornax update` with the new version.
    Started { version: String, pid: u32 },
    /// A line the worker would print for a person.
    Log { line: String },
    /// The supervisor restarts the worker for a new version.
    Restarting,
    /// The supervisor's last line. i64: a Windows crash code (e.g. 3221225477) does not fit an i32.
    Stopped { code: i64 },
    /// The worker's job types and their state, whenever they change (spec 06c 2.2).
    Types { types: Vec<TypeInfo> },
    /// An event a newer CLI may add.
    #[serde(other)]
    Other,
}

pub fn parse_event(line: &str) -> Option<WorkerEvent> {
    serde_json::from_str(line).ok()
}

/// One job type as the worker reports it (spec 06c 2.2). `state` stays a string: a newer CLI may add a state, and the
/// model drops only that row.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TypeInfo {
    pub name: String,
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Why the worker takes no job now (more fields on the wire are ignored). The figures come with `gpu_busy`, `error`
/// with `gpu_unreadable` from server 0.6.0 on.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Waiting {
    pub reason: String,
    pub message: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub used_mib: Option<u64>,
    #[serde(default)]
    pub total_mib: Option<u64>,
    #[serde(default)]
    pub limit_mib: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct WorkerInfo {
    pub online: bool,
    pub last_seen: Option<String>,
    pub version: Option<String>,
    pub waiting: Option<Waiting>,
}

/// One job as the operator sees it (spec 06 2.3).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Job {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub owner: Option<String>,
    pub state: String,
    pub label: Option<String>,
    pub group: Option<String>,
    pub priority: String,
    pub inputs: BTreeMap<String, Option<String>>,
    pub attempts: u32,
    pub type_unavailable: bool,
    pub run_after: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub progress: Option<f64>,
    pub progress_message: Option<String>,
    pub error: Option<String>,
    pub result_url: String,
}

/// The whole queue (spec 06 2.3, `GET /api/worker/jobs`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Queue {
    pub server_time: String,
    pub change: String,
    /// The server's version (spec 06d 2.3); None from a server older than 0.7.0.
    #[serde(default)]
    pub server_version: Option<String>,
    pub paused: bool,
    pub worker: WorkerInfo,
    pub running: Option<Job>,
    pub queued: Vec<Job>,
    pub finished: Vec<Job>,
}

/// One line of `fornax queue --json --watch` (spec 06 3.1).
#[derive(Clone, Debug, PartialEq)]
pub enum WatchLine {
    Queue(Box<Queue>),
    /// The queue could not be read (`network`, `auth` or `server`); the reader tries again by itself.
    Failed { error: String, message: String },
}

#[derive(Deserialize)]
struct Head {
    ok: bool,
}

#[derive(Deserialize)]
struct Failure {
    error: String,
    message: String,
}

pub fn parse_watch_line(line: &str) -> Option<WatchLine> {
    let head: Head = serde_json::from_str(line).ok()?;
    if head.ok {
        serde_json::from_str::<Queue>(line).ok().map(|q| WatchLine::Queue(Box::new(q)))
    } else {
        serde_json::from_str::<Failure>(line).ok().map(|f| WatchLine::Failed { error: f.error, message: f.message })
    }
}

/// Milliseconds since 1970 of a UTC time as the server writes it (`2026-11-15T14:02:11.000Z`, 0 to 3 digits of
/// milliseconds); None for anything else.
pub fn iso_ms(text: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        if part.bytes().all(|b| b.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    let fixed = [(4, "-"), (7, "-"), (10, "T"), (13, ":"), (16, ":")];
    if !text.ends_with('Z') || fixed.iter().any(|(i, c)| text.get(*i..*i + 1) != Some(*c)) {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = match text.get(19..text.len() - 1)? {
        "" => 0,
        frac => {
            let digits = frac.strip_prefix('.')?;
            if digits.is_empty() || digits.len() > 3 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            format!("{digits:0<3}").parse::<i64>().ok()?
        }
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The oldest fornax the tray works with (it needs `--events` and `fornax queue`, spec 06 4.7).
pub const MIN_CLI: (u32, u32, u32) = (0, 5, 0);

/// "0.5.0" as numbers (a "-…" or "+…" suffix ignored); None when it is no version.
pub fn version_of(text: &str) -> Option<(u32, u32, u32)> {
    let core = text.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u32>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

/// Only web pages open in the browser (a result link comes from the server).
pub fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_event_of_fornax_worker_events() {
        assert_eq!(parse_event(r#"{"event":"started","version":"0.5.0","pid":1234}"#), Some(WorkerEvent::Started { version: "0.5.0".into(), pid: 1234 }));
        assert_eq!(parse_event(r#"{"event":"log","line":"offering: echo"}"#), Some(WorkerEvent::Log { line: "offering: echo".into() }));
        assert_eq!(parse_event(r#"{"event":"restarting"}"#), Some(WorkerEvent::Restarting));
        assert_eq!(parse_event(r#"{"event":"stopped","code":130}"#), Some(WorkerEvent::Stopped { code: 130 }));
        // A Windows crash code (0xC0000005) is larger than an i32.
        assert_eq!(parse_event(r#"{"event":"stopped","code":3221225477}"#), Some(WorkerEvent::Stopped { code: 3_221_225_477 }));
        assert_eq!(
            parse_event(r#"{"event":"types","types":[{"name":"lease","state":"offered"},{"name":"upscale","state":"waiting","reason":"waiting for the card"}]}"#),
            Some(WorkerEvent::Types {
                types: vec![
                    TypeInfo { name: "lease".into(), state: "offered".into(), reason: None },
                    TypeInfo { name: "upscale".into(), state: "waiting".into(), reason: Some("waiting for the card".into()) },
                ]
            })
        );
        assert_eq!(parse_event(r#"{"event":"something-new","x":1}"#), Some(WorkerEvent::Other));
        assert_eq!(parse_event("not json"), None);
        assert_eq!(parse_event(r#"{"event":"started"}"#), None, "a started event without its fields");
    }

    #[test]
    fn reads_the_fields_of_the_workers_reason_to_wait() {
        let busy: Waiting = serde_json::from_str(r#"{"reason":"gpu_busy","message":"m","used_mib":9000,"total_mib":16311,"limit_mib":768}"#).unwrap();
        assert_eq!((busy.used_mib, busy.total_mib, busy.limit_mib, busy.error), (Some(9000), Some(16311), Some(768), None));
        let unreadable: Waiting = serde_json::from_str(r#"{"reason":"gpu_unreadable","message":"m","error":"nvidia-smi: exit code 4","limit_mib":768}"#).unwrap();
        assert_eq!(unreadable.error.as_deref(), Some("nvidia-smi: exit code 4"));
        // A server older than 0.6.0 sends no error.
        let old: Waiting = serde_json::from_str(r#"{"reason":"gpu_unreadable","message":"m","limit_mib":768}"#).unwrap();
        assert_eq!(old.error, None);
    }

    #[test]
    fn reads_a_queue_line_and_an_error_line_of_fornax_queue_watch() {
        let line = r#"{"ok":true,"server_time":"2026-11-15T14:00:00.000Z","change":"0123456789abcdef","paused":false,"worker":{"online":true,"last_seen":"2026-11-15T13:59:58.000Z","version":"0.5.0","waiting":{"reason":"gpu_busy","message":"waiting: 9000 MiB of 16000 MiB of the card in use by other programs, limit 768 MiB","used_mib":9000,"total_mib":16000,"limit_mib":768}},"running":null,"queued":[{"id":"Q1","type":"lease","owner":"bob","state":"queued","label":"chrome","group":null,"priority":"normal","inputs":{"video":null},"attempts":0,"type_unavailable":false,"run_after":null,"created_at":"2026-11-15T13:56:00.000Z","started_at":null,"finished_at":null,"progress":null,"progress_message":null,"error":null,"result_url":"https://fornax.example.com/r/x"}],"finished":[]}"#;
        let Some(WatchLine::Queue(q)) = parse_watch_line(line) else { panic!("not a queue line") };
        assert_eq!(q.server_time, "2026-11-15T14:00:00.000Z");
        assert!(q.worker.online && !q.paused && q.running.is_none());
        assert_eq!(q.worker.waiting.as_ref().map(|w| w.reason.as_str()), Some("gpu_busy"));
        let j = &q.queued[0];
        assert_eq!((j.kind.as_str(), j.owner.as_deref(), j.label.as_deref()), ("lease", Some("bob"), Some("chrome")));
        assert_eq!(j.inputs.get("video"), Some(&None));
        assert_eq!(
            parse_watch_line(r#"{"ok":false,"error":"network","message":"cannot reach the server: ECONNREFUSED"}"#),
            Some(WatchLine::Failed { error: "network".into(), message: "cannot reach the server: ECONNREFUSED".into() })
        );
        assert_eq!(parse_watch_line("queue active · worker online"), None);
        assert_eq!(parse_watch_line(r#"{"ok":true}"#), None, "a queue line without the queue");
    }

    #[test]
    fn reads_the_servers_times() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
        assert_eq!(iso_ms("2024-02-29T12:00:00.250Z"), Some(1_709_208_000_250));
        assert_eq!(iso_ms("2026-11-15T14:00:00.000Z"), Some(1_794_751_200_000));
        assert_eq!(iso_ms("2026-11-15T14:00:00.5Z"), Some(1_794_751_200_500));
        for bad in ["", "2026-11-15", "2026-11-15T14:00:00", "2026-13-15T14:00:00Z", "2026-11-15T14:00:00.1234Z", "2026/11/15T14:00:00Z"] {
            assert_eq!(iso_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn reads_versions() {
        assert_eq!(version_of("0.5.0\n"), Some((0, 5, 0)));
        assert_eq!(version_of("1.12.3-rc.1"), Some((1, 12, 3)));
        assert!(version_of("0.5.0").unwrap() >= MIN_CLI);
        assert!(version_of("0.4.1").unwrap() < MIN_CLI);
        assert_eq!(version_of("usage: fornax …"), None);
        assert_eq!(version_of("0.5"), None);
        assert_eq!(version_of("0.5.0.1"), None);
    }

    #[test]
    fn only_web_links_open() {
        assert!(is_web_url("https://fornax.example.com/r/abc"));
        assert!(is_web_url("http://127.0.0.1:3000/r/abc"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
    }
}
