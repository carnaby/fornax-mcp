//! A tray update's files (spec 06d 4.3): the marker the old tray leaves for the new one, the helper's log, and the
//! detached `fornax tray install` that replaces the tray while it is gone.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::config::TrayConfig;
use crate::state::UpdateDone;

/// The marker the old tray writes before it starts the helper, in `<data>`.
pub const MARKER: &str = "tray-update.json";
/// The helper's lines (written by `fornax tray install`), in `<data>`.
pub const LOG: &str = "tray-update.log";

#[derive(Serialize, Deserialize)]
struct Marker {
    target: String,
    resume_queue: bool,
}

pub fn write_marker(data: &Path, target: &str, resume_queue: bool) -> io::Result<()> {
    fs::create_dir_all(data)?;
    let text = serde_json::to_string(&Marker { target: target.to_string(), resume_queue }).map_err(io::Error::other)?;
    fs::write(data.join(MARKER), text)
}

pub fn remove_marker(data: &Path) {
    let _ = fs::remove_file(data.join(MARKER));
}

/// The marker of the update before this tray, with the helper's last line; removed, so it is read once.
pub fn take_done(data: &Path) -> Option<UpdateDone> {
    let text = fs::read_to_string(data.join(MARKER)).ok()?;
    remove_marker(data);
    let marker: Marker = serde_json::from_str(&text).ok()?;
    let last_line = fs::read_to_string(data.join(LOG))
        .ok()
        .and_then(|log| log.lines().map(str::trim).filter(|l| !l.is_empty()).last().map(String::from));
    Some(UpdateDone { target: marker.target, resume_queue: marker.resume_queue, last_line })
}

/// `fornax tray install --wait-pid <pid> --relaunch <exe>`, detached: no window, its own process group, no pipes (it
/// outlives the tray).
pub fn spawn_installer(cfg: &TrayConfig, pid: u32, exe: &Path) -> io::Result<()> {
    let mut c = Command::new(&cfg.node);
    c.arg(&cfg.cli)
        .args(["tray", "install", "--wait-pid", &pid.to_string(), "--relaunch"])
        .arg(exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        c.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c.spawn().map(drop)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::state::UpdateDone;

    fn dir() -> crate::test_dir::TempDir {
        crate::test_dir::TempDir::new("fornax tray update é")
    }

    #[test]
    fn the_marker_is_read_once_with_the_helpers_last_line() {
        let d = dir();
        assert_eq!(take_done(&d), None);
        write_marker(&d, "0.7.1", true).unwrap();
        fs::write(d.join(LOG), "installing fornax tray 0.7.1\nthe installation was cancelled\n\n").unwrap();
        assert_eq!(take_done(&d), Some(UpdateDone { target: "0.7.1".into(), resume_queue: true, last_line: Some("the installation was cancelled".into()) }));
        assert_eq!(take_done(&d), None, "the marker is removed");
        // A broken marker is removed and ignored.
        fs::write(d.join(MARKER), "not json").unwrap();
        assert_eq!(take_done(&d), None);
        assert!(!d.join(MARKER).exists());
    }
}
