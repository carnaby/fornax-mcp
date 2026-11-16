//! The card the window shows (spec 06e § 3.1): one `nvidia-smi` query of the first card, run by the tray itself.

use std::ffi::OsString;
use std::io;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use crate::process::{CliProcess, Output, Sink};

/// The query: one CSV line per card, numbers without units.
pub const QUERY: [&str; 2] = ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"];
/// How long one reading may take.
pub const GPU_TIMEOUT: Duration = Duration::from_secs(5);
/// More MiB than any card has: a bigger number is no reading.
const MAX_MIB: u64 = 10_000_000;

/// The first card as `nvidia-smi` reports it; load and temperature may be unknown (`[N/A]`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuInfo {
    pub name: String,
    pub used_mib: u64,
    pub total_mib: u64,
    pub utilization: Option<u32>,
    pub temperature: Option<u32>,
}

/// Why there is no reading: no `nvidia-smi` at all, or it did not give one (the sentence says why).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GpuProblem {
    Missing,
    Failed(String),
}

/// The program to run with [`QUERY`] after `prefix`: `nvidia-smi` from PATH; tests put a fake in its place.
#[derive(Clone, Debug)]
pub struct GpuCommand {
    pub program: OsString,
    pub prefix: Vec<OsString>,
}

impl Default for GpuCommand {
    fn default() -> Self {
        GpuCommand { program: "nvidia-smi".into(), prefix: Vec::new() }
    }
}

/// The first line of the query's output that is a card (a warning line before it is skipped); None when none is.
pub fn parse(stdout: &str) -> Option<GpuInfo> {
    // The first line that is a card: some drivers print a warning line before the CSV.
    stdout.lines().map(str::trim).filter(|l| !l.is_empty()).find_map(parse_line)
}

fn parse_line(line: &str) -> Option<GpuInfo> {
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    let [name, used, total, utilization, temperature] = parts.as_slice() else {
        return None;
    };
    let mib = |s: &str| s.parse::<u64>().ok().filter(|v| *v <= MAX_MIB);
    // "[N/A]" or "[Not Supported]": the value is unknown, the reading still counts.
    let small = |s: &str| s.parse::<u32>().ok().filter(|v| *v <= 1000);
    let (used_mib, total_mib) = (mib(used)?, mib(total)?);
    if name.is_empty() || total_mib == 0 {
        return None;
    }
    Some(GpuInfo { name: (*name).to_string(), used_mib, total_mib, utilization: small(utilization), temperature: small(temperature) })
}

/// Run the query (no console window, at most `timeout`).
pub fn read(cmd: &GpuCommand, timeout: Duration) -> Result<GpuInfo, GpuProblem> {
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.prefix).args(QUERY).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    /// stdout lines, every line (stdout and stderr), exit code
    type Seen = (Vec<String>, Vec<String>, Option<i32>);
    let seen: Arc<Mutex<Seen>> = Arc::new(Mutex::new((Vec::new(), Vec::new(), None)));
    let sink: Sink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |out: Output| {
            let mut s = seen.lock().unwrap_or_else(PoisonError::into_inner);
            match out {
                Output::Stdout(line) => {
                    s.0.push(line.clone());
                    s.1.push(line);
                }
                Output::Stderr(line) => s.1.push(line),
                Output::Exited(code) => s.2 = code,
            }
        })
    };
    let process = match CliProcess::start(c, sink) {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(GpuProblem::Missing),
        Err(e) => return Err(GpuProblem::Failed(format!("nvidia-smi could not be started ({e})"))),
    };
    if !process.wait_exit(timeout) {
        process.kill_tree();
        process.wait_exit(Duration::from_secs(5));
        return Err(GpuProblem::Failed(format!("nvidia-smi did not answer within {} s", timeout.as_secs())));
    }
    let (stdout, all, code) = seen.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if code != Some(0) {
        let last = all.iter().map(|l| l.trim()).rev().find(|l| !l.is_empty()).map(String::from);
        let code = code.map_or_else(|| "?".to_string(), |c| c.to_string());
        return Err(GpuProblem::Failed(last.unwrap_or_else(|| format!("nvidia-smi ended with code {code}"))));
    }
    let text = stdout.join("\n");
    parse(&text).ok_or_else(|| {
        let first: String = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(80).collect();
        GpuProblem::Failed(format!("nvidia-smi printed {first:?}"))
    })
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    fn info(utilization: Option<u32>, temperature: Option<u32>) -> GpuInfo {
        GpuInfo { name: "NVIDIA GeForce RTX 5060 Ti".into(), used_mib: 6400, total_mib: 16311, utilization, temperature }
    }

    /// A fake nvidia-smi: Node runs `script`, the query's arguments follow `--`.
    fn node(script: &str) -> GpuCommand {
        GpuCommand { program: "node".into(), prefix: vec!["-e".into(), script.into(), "--".into()] }
    }

    #[test]
    fn the_first_card_of_the_query_is_read() {
        assert_eq!(parse("NVIDIA GeForce RTX 5060 Ti, 6400, 16311, 94, 71\n"), Some(info(Some(94), Some(71))));
        assert_eq!(parse("NVIDIA GeForce RTX 5060 Ti, 6400, 16311, [N/A], [N/A]"), Some(info(None, None)));
        assert_eq!(parse("NVIDIA GeForce RTX 5060 Ti, 6400, 16311, [Not Supported], 71"), Some(info(None, Some(71))));
        assert_eq!(
            parse("  NVIDIA GeForce RTX 5060 Ti ,6400,16311,94,71  \nNVIDIA RTX A2000, 1, 6138, 0, 40\n"),
            Some(info(Some(94), Some(71))),
            "spaces; the first of two cards"
        );
        assert_eq!(
            parse("WARNING: infoROM is corrupted at gpu 0000:01:00.0\nNVIDIA GeForce RTX 5060 Ti, 6400, 16311, 94, 71\n"),
            Some(info(Some(94), Some(71))),
            "a warning line before the card is skipped"
        );
        for bad in [
            "",
            "\n\n",
            "NVIDIA, x, 16311, 94, 71",
            "NVIDIA, 6400, 16311, 94",
            ", 6400, 16311, 94, 71",
            "NVIDIA, 6400, 0, 94, 71",
            "NVIDIA, 99999999999, 16311, 94, 71",
            "NVIDIA, -1, 16311, 94, 71",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_reading_runs_the_query_and_parses_the_first_card() {
        let script = "const want = '--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits'; console.log(process.argv.slice(1).join(' ') === want ? 'NVIDIA GeForce RTX 5060 Ti, 6400, 16311, 94, 71' : 'bad arguments')";
        assert_eq!(read(&node(script), Duration::from_secs(10)), Ok(info(Some(94), Some(71))));
    }

    #[test]
    fn a_failing_nvidia_smi_says_its_last_line_or_its_code() {
        let failed = |text: &str| Err(GpuProblem::Failed(text.to_string()));
        assert_eq!(read(&node("console.log('No devices were found'); process.exit(4)"), Duration::from_secs(10)), failed("No devices were found"));
        assert_eq!(read(&node("process.exit(9)"), Duration::from_secs(10)), failed("nvidia-smi ended with code 9"));
        assert_eq!(read(&node("console.log('hello')"), Duration::from_secs(10)), Err(GpuProblem::Failed(format!("nvidia-smi printed {:?}", "hello"))));
    }

    #[test]
    fn a_missing_nvidia_smi_and_one_that_hangs() {
        let missing = GpuCommand { program: "fornax-test-no-such-nvidia-smi".into(), prefix: Vec::new() };
        assert_eq!(read(&missing, Duration::from_secs(5)), Err(GpuProblem::Missing));
        let started = Instant::now();
        let hangs = read(&node("setTimeout(() => {}, 60000)"), Duration::from_secs(1));
        assert_eq!(hangs, Err(GpuProblem::Failed("nvidia-smi did not answer within 1 s".into())));
        assert!(started.elapsed() < Duration::from_secs(10), "the hung reading is ended");
    }
}
