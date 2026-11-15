//! The tray's CLI processes (spec 06 4.7): `node <data>/app/fornax.mjs <args>` without a shell, with piped stdio.
//! Every stdout and stderr line goes to a sink, and the end of the process always comes last.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::TrayConfig;

/// Windows: a console program started by the tray gets no console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long the end of a process waits for its output after it exited (a grandchild may hold a pipe open).
const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// Spec 06 4.7: what the tray says when the installed fornax is missing.
pub const NOT_INSTALLED: &str = "fornax is not installed: see the README";

/// What a process sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Output {
    Stdout(String),
    Stderr(String),
    /// The exit code; None when there is none (Unix: ended by a signal). A process ended with `taskkill /F` on Windows
    /// exits with 1, so None does not mean "killed". Always the last output.
    Exited(Option<i32>),
}

/// Gets every output of a process, on its reader threads: it must not block for long (the process writes its output
/// synchronously and would wait for the tray).
pub type Sink = Arc<dyn Fn(Output) + Send + Sync>;

/// `node <fornax.mjs> <args>` without a shell (paths with spaces need no quoting), piped stdio, the tray's own
/// environment. Windows: no console window. Elsewhere its own process group, which [`CliProcess::kill_tree`] signals
/// along with the rest of the tree.
pub fn command(cfg: &TrayConfig, args: &[&str]) -> Command {
    let mut c = Command::new(&cfg.node);
    c.arg(&cfg.cli).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c
}

/// Why `command` did not start, with what to set.
pub fn spawn_error(cfg: &TrayConfig, e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        format!(r#"Node.js was not found ({}): install Node.js 22 or newer, or set "node" in {}"#, cfg.node.display(), cfg.file.display())
    } else {
        format!(r#"{} could not be started ({e}): check "node" in {}"#, cfg.node.display(), cfg.file.display())
    }
}

/// The installed fornax must exist before node runs it (node's own message would be a stack trace).
pub fn check_cli(cfg: &TrayConfig) -> Result<(), String> {
    if cfg.cli.is_file() {
        Ok(())
    } else {
        Err(NOT_INSTALLED.to_string())
    }
}

/// The lines of `reader` up to its end, as UTF-8 (broken bytes replaced), without line breaks; blank lines skipped.
fn each_line(reader: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                if !line.trim().is_empty() {
                    f(line.to_string());
                }
            }
        }
    }
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The parent pid in a `/proc/<pid>/stat` line: `pid (comm) state ppid …`. The name may contain spaces and
/// parentheses, so the fields are counted after the last `)`.
#[cfg(any(not(windows), test))]
fn parent_of(stat: &str) -> Option<u32> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Every pid below `root` in `(pid, ppid)` pairs: its children, their children and so on; not `root` itself.
#[cfg(any(not(windows), test))]
fn tree_below(root: u32, pairs: &[(u32, u32)]) -> Vec<u32> {
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        for &(pid, ppid) in pairs {
            if ppid == parent && !tree.contains(&pid) {
                tree.push(pid);
            }
        }
        i += 1;
    }
    tree.split_off(1)
}

/// The descendants of `root` running now, read from /proc (empty where there is none).
#[cfg(not(windows))]
fn descendants(root: u32) -> Vec<u32> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
    let pairs: Vec<(u32, u32)> = dir
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            Some((pid, parent_of(&stat)?))
        })
        .collect();
    tree_below(root, &pairs)
}

/// End `child` and everything it started at once. Windows: taskkill /T (a venv's python.exe starts the real
/// interpreter as its own child). Elsewhere SIGKILL to the process group `command` gave it and to every descendant
/// found in /proc: the real CLI starts the worker, and the worker its tools, in process groups of their own. The tree
/// is collected before anything is killed (a process whose parent died gets another parent and could not be found);
/// once `child` has exited its children already have another parent, so then only its group is signalled.
fn kill_child_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    let ended = {
        use std::os::windows::process::CommandExt;
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    #[cfg(not(windows))]
    let ended = {
        // Not reaped yet, so its pid is not reused while the tree is read.
        let exited = matches!(child.try_wait(), Ok(Some(_)));
        let mut targets = vec![format!("-{pid}")];
        if !exited {
            targets.extend(descendants(pid).iter().map(u32::to_string));
        }
        // kill signals every target even when one of them is gone already (it then exits non-zero).
        Command::new("kill")
            .args(["-KILL", "--"])
            .args(&targets)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if !ended {
        let _ = child.kill();
    }
}

/// The sink of one process: lines pass until the end was sent, later ones are dropped (but still read, so nothing that
/// holds a pipe blocks), and [`Output::Exited`] is sent once.
struct Gate {
    sink: Sink,
    closed: Mutex<bool>,
}

impl Gate {
    fn send(&self, out: Output) {
        let closed = guard(&self.closed);
        if !*closed {
            (self.sink)(out);
        }
    }

    fn close(&self, last: Option<Output>) {
        let mut closed = guard(&self.closed);
        if !*closed {
            *closed = true;
            if let Some(out) = last {
                (self.sink)(out);
            }
        }
    }
}

/// A running CLI process of the tray: its input, its end, and a way to end it by force.
pub struct CliProcess {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    ended: Mutex<bool>,
    ended_cv: Condvar,
}

impl CliProcess {
    /// Start `command` (from [`command`]); every line goes to `sink`, then [`Output::Exited`] once the process ended and
    /// both its streams were read to the end. On an error nothing reaches `sink` and no process is left running.
    pub fn start(mut command: Command, sink: Sink) -> io::Result<Arc<Self>> {
        let mut child = command.spawn()?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "the process's stdout and stderr must be piped"));
        };
        let stdin = child.stdin.take();
        let process = Arc::new(CliProcess { child: Mutex::new(child), stdin: Mutex::new(stdin), ended: Mutex::new(false), ended_cv: Condvar::new() });
        let gate = Arc::new(Gate { sink, closed: Mutex::new(false) });
        let fail = |e: io::Error| {
            gate.close(None);
            process.kill_tree();
            e
        };
        let out = {
            let gate = Arc::clone(&gate);
            thread::Builder::new().name("fornax stdout".into()).spawn(move || each_line(stdout, |line| gate.send(Output::Stdout(line)))).map_err(fail)?
        };
        let err = {
            let gate = Arc::clone(&gate);
            thread::Builder::new().name("fornax stderr".into()).spawn(move || each_line(stderr, |line| gate.send(Output::Stderr(line)))).map_err(fail)?
        };
        let watcher = Arc::clone(&process);
        let end = Arc::clone(&gate);
        thread::Builder::new()
            .name("fornax exit".into())
            .spawn(move || {
                let code = watcher.wait_for_exit();
                // A grandchild that inherited a pipe could keep it open: wait for the readers, but not forever.
                let deadline = Instant::now() + DRAIN_WAIT;
                while !(out.is_finished() && err.is_finished()) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(20));
                }
                end.close(Some(Output::Exited(code)));
                *guard(&watcher.ended) = true;
                watcher.ended_cv.notify_all();
            })
            .map_err(fail)?;
        Ok(process)
    }

    fn wait_for_exit(&self) -> Option<i32> {
        loop {
            match guard(&self.child).try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(_) => return None,
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Write "stop" (spec 06 3.2; a second one ends the worker at once). False when its input is closed.
    pub fn send_stop(&self) -> bool {
        let mut stdin = guard(&self.stdin);
        let Some(pipe) = stdin.as_mut() else { return false };
        if pipe.write_all(b"stop\n").and_then(|()| pipe.flush()).is_ok() {
            return true;
        }
        *stdin = None;
        false
    }

    /// Close the process's input: a short command reads none, the queue reader and the worker end on it.
    pub fn close_input(&self) {
        *guard(&self.stdin) = None;
    }

    /// Wait at most `timeout` for the end of the process and its output. True when it ended.
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut ended = guard(&self.ended);
        while !*ended {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            ended = self.ended_cv.wait_timeout(ended, left).unwrap_or_else(PoisonError::into_inner).0;
        }
        true
    }

    /// End the process and everything it started (the worker, Python, ffmpeg) at once.
    pub fn kill_tree(&self) {
        kill_child_tree(&mut guard(&self.child));
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Arc;
    use std::time::Duration;

    use super::{Output, Sink};
    use crate::config::{Paths, TrayConfig};

    /// The fake CLI installed as `<data>/app/fornax.mjs` in a fresh folder whose name has a space and a diacritic.
    pub struct Fake {
        pub paths: Paths,
        pub cfg: TrayConfig,
    }

    pub fn fake_cli(mode: &str) -> Fake {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("fornax tray é {}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        let paths = Paths { config: dir.join("config"), data: dir.join("data") };
        fs::create_dir_all(paths.cli().parent().unwrap()).unwrap();
        fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-fornax.mjs"), paths.cli()).unwrap();
        let fake = Fake { cfg: TrayConfig { node: PathBuf::from("node"), cli: paths.cli(), start_worker: true, file: paths.tray_json() }, paths };
        set_mode(&fake, mode);
        fake
    }

    pub fn set_mode(fake: &Fake, mode: &str) {
        fs::write(fake.paths.cli().with_file_name("mode"), mode).unwrap();
    }

    pub fn set_version(fake: &Fake, version: &str) {
        fs::write(fake.paths.cli().with_file_name("version"), version).unwrap();
    }

    /// How often the fake's queue reader started.
    pub fn watch_starts(fake: &Fake) -> usize {
        fs::read_to_string(fake.paths.cli().with_file_name("watch-starts")).map_or(0, |t| t.lines().count())
    }

    pub fn channel() -> (Sink, Receiver<Output>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(move |out: Output| {
                let _ = tx.send(out);
            }),
            rx,
        )
    }

    pub fn next(rx: &Receiver<Output>) -> Output {
        rx.recv_timeout(Duration::from_secs(15)).expect("output in time")
    }

    /// Whether a process runs. Off Windows a killed process stays in /proc as a zombie (state Z) until it is reaped.
    #[cfg(not(windows))]
    pub fn alive(pid: u32) -> bool {
        fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| stat.rfind(')').is_some_and(|i| !stat[i + 1..].trim_start().starts_with('Z')))
    }

    #[cfg(windows)]
    pub use crate::lock::alive;
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::mpsc::Receiver;
    use std::time::{Duration, Instant};

    use super::testing::{alive, channel, fake_cli, next};
    use super::*;

    fn until_exit(rx: &Receiver<Output>) -> Vec<Output> {
        let mut all = Vec::new();
        loop {
            let out = next(rx);
            let end = matches!(out, Output::Exited(_));
            all.push(out);
            if end {
                return all;
            }
        }
    }

    fn stdout_has(all: &[Output], part: &str) -> bool {
        all.iter().any(|o| matches!(o, Output::Stdout(l) if l.contains(part)))
    }

    #[test]
    fn runs_the_worker_and_stops_it_with_a_line() {
        let f = fake_cli("ok");
        let (sink, rx) = channel();
        let p = CliProcess::start(command(&f.cfg, &["worker", "--events"]), sink).unwrap();
        assert!(matches!(next(&rx), Output::Stdout(l) if l.contains(r#""event":"started""#)));
        assert!(p.send_stop());
        let all = until_exit(&rx);
        assert!(stdout_has(&all, r#""event":"stopped","code":0"#), "{all:?}");
        assert_eq!(all.last(), Some(&Output::Exited(Some(0))));
        assert!(p.wait_exit(Duration::from_secs(1)));
    }

    #[test]
    fn a_closed_input_is_a_stop() {
        let f = fake_cli("ok");
        let (sink, rx) = channel();
        let p = CliProcess::start(command(&f.cfg, &["worker", "--events"]), sink).unwrap();
        next(&rx);
        p.close_input();
        assert_eq!(until_exit(&rx).last(), Some(&Output::Exited(Some(0))));
    }

    #[test]
    fn ends_a_worker_by_force_when_it_ignores_stop() {
        let f = fake_cli("stubborn");
        let (sink, rx) = channel();
        let p = CliProcess::start(command(&f.cfg, &["worker", "--events"]), sink).unwrap();
        next(&rx);
        assert!(p.send_stop());
        let waited = Instant::now();
        assert!(!p.wait_exit(Duration::from_secs(1)));
        assert!(waited.elapsed() >= Duration::from_millis(900));
        p.kill_tree();
        assert!(p.wait_exit(Duration::from_secs(10)));
        assert!(matches!(until_exit(&rx).last(), Some(Output::Exited(_))));
    }

    #[test]
    fn reports_a_crash_with_its_stderr_before_the_end() {
        let f = fake_cli("crash");
        let (sink, rx) = channel();
        CliProcess::start(command(&f.cfg, &["worker", "--events"]), sink).unwrap();
        let all = until_exit(&rx);
        assert!(stdout_has(&all, "something broke"));
        assert!(all.contains(&Output::Stderr("Error: boom".into())));
        assert_eq!(all.last(), Some(&Output::Exited(Some(1))));
    }

    #[test]
    fn a_short_command_ends_by_itself() {
        let f = fake_cli("ok");
        let (sink, rx) = channel();
        let p = CliProcess::start(command(&f.cfg, &["queue", "pause"]), sink).unwrap();
        p.close_input();
        assert_eq!(until_exit(&rx), vec![Output::Stdout("done: pause".into()), Output::Exited(Some(0))]);
    }

    #[test]
    fn splits_lines_with_crlf_and_broken_utf8() {
        let mut bytes = b"one".to_vec();
        bytes.extend([13, 10]);
        bytes.extend(b"two\n\n  \nthr");
        bytes.push(0xFF);
        bytes.extend(b"ee");
        let mut lines = Vec::new();
        each_line(&bytes[..], |l| lines.push(l));
        let replacement = char::from_u32(0xFFFD).unwrap();
        assert_eq!(lines, ["one".to_string(), "two".to_string(), format!("thr{replacement}ee")]);
    }

    #[test]
    fn says_what_to_set_when_node_or_fornax_is_missing() {
        let mut f = fake_cli("ok");
        f.cfg.node = PathBuf::from("fornax-no-such-node");
        let e = command(&f.cfg, &["--version"]).spawn().expect_err("there is no such program");
        let message = spawn_error(&f.cfg, &e);
        assert!(message.starts_with("Node.js was not found (fornax-no-such-node)"), "{message}");
        assert!(message.contains(r#"set "node" in"#), "{message}");
        f.cfg.cli = f.cfg.cli.with_file_name("missing.mjs");
        assert_eq!(check_cli(&f.cfg), Err(NOT_INSTALLED.to_string()));
    }

    #[test]
    fn reads_the_parent_from_proc_stat_even_when_the_name_has_parentheses() {
        assert_eq!(parent_of("4242 (node) S 17 4242 4242 0 -1 4194560 812"), Some(17));
        assert_eq!(parent_of("4243 (a) (b c) R 4242 4242 4242 0 -1"), Some(4242));
        assert_eq!(parent_of("4244 (x"), None);
        assert_eq!(parent_of(""), None);
    }

    #[test]
    fn finds_every_descendant_but_not_the_root_or_strangers() {
        // (pid, ppid): 10 started 11 and 12, 12 started 13, 13 started 14; 20 and 21 belong to someone else.
        let pairs = [(1, 0), (10, 1), (11, 10), (12, 10), (13, 12), (14, 13), (20, 1), (21, 20)];
        let mut below = tree_below(10, &pairs);
        below.sort_unstable();
        assert_eq!(below, [11, 12, 13, 14]);
        assert!(tree_below(14, &pairs).is_empty());
    }

    /// Off Windows the real CLI starts `worker --child` and the worker its tools in their own process groups (detached),
    /// so the group of the tray's child alone would leave them running. On Windows taskkill /T finds the grandchild.
    #[test]
    fn kill_tree_ends_a_grandchild_in_its_own_process_group() {
        let f = fake_cli("stubborn grandchild");
        let (sink, rx) = channel();
        let p = CliProcess::start(command(&f.cfg, &["worker", "--events"]), sink).unwrap();
        let grandchild = loop {
            if let Output::Stdout(line) = next(&rx) {
                if let Some(pid) = line.split("grandchild ").nth(1) {
                    break pid.trim_end_matches(['"', '}']).parse::<u32>().expect("the grandchild's pid");
                }
            }
        };
        assert!(alive(grandchild));
        assert!(p.send_stop());
        assert!(!p.wait_exit(Duration::from_millis(500)));
        p.kill_tree();
        assert!(p.wait_exit(Duration::from_secs(10)));
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(grandchild) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(grandchild), "the grandchild {grandchild} still runs");
    }
}
