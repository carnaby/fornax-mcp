//! Spec 06 4.5: whether a worker runs on this PC outside the tray: `<data>/worker.lock` holds the pid of a live
//! process and was touched lately (a running worker touches it every 60 s; the worker's own rules are in
//! apps/worker/src/instance.ts).

use std::path::Path;
use std::time::{Duration, SystemTime};

/// A lock not touched for longer belongs to no running worker.
pub const FRESH: Duration = Duration::from_secs(180);

/// Whether `lock` names a live process and was touched within [`FRESH`] of `now`.
pub fn held(lock: &Path, now: SystemTime) -> bool {
    let Ok(modified) = std::fs::metadata(lock).and_then(|m| m.modified()) else { return false };
    let fresh = match now.duration_since(modified) {
        Ok(age) => age <= FRESH,
        // Touched "in the future" (the clock moved back): fresh.
        Err(_) => true,
    };
    if !fresh {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(lock) else { return false };
    match text.trim().parse::<u32>() {
        Ok(pid) if pid != 0 => alive(pid),
        _ => false,
    }
}

/// Whether a process with this pid runs (a process of another, elevated user counts as not running).
#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: OpenProcess returns a handle or null; a handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
pub fn alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime};

    use super::*;

    fn temp() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("fornax tray lock é {}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_fresh_lock_of_a_live_process_is_held() {
        let file = temp().join("worker.lock");
        fs::write(&file, format!("{}\n", std::process::id())).unwrap();
        assert!(held(&file, SystemTime::now()));
    }

    #[test]
    fn a_missing_broken_or_stale_lock_is_not_held() {
        let file = temp().join("worker.lock");
        assert!(!held(&file, SystemTime::now()), "missing");
        fs::write(&file, "").unwrap();
        assert!(!held(&file, SystemTime::now()), "empty: still being written");
        fs::write(&file, "abc").unwrap();
        assert!(!held(&file, SystemTime::now()), "no pid");
        fs::write(&file, std::process::id().to_string()).unwrap();
        assert!(!held(&file, SystemTime::now() + FRESH + Duration::from_secs(1)), "not touched for more than 3 minutes");
    }

    #[test]
    fn a_lock_of_an_ended_process_is_not_held() {
        let mut child = Command::new("node").args(["-e", "0"]).spawn().expect("node runs");
        let pid = child.id();
        child.wait().unwrap();
        let file = temp().join("worker.lock");
        fs::write(&file, pid.to_string()).unwrap();
        assert!(!held(&file, SystemTime::now()));
        assert!(alive(std::process::id()));
    }
}
