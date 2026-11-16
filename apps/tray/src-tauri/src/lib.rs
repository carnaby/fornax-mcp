//! The core of the Fornax tray (spec 06 § 4); `main.rs` wires it to Tauri.

pub mod config;
pub mod controller;
pub mod gpu;
pub mod lock;
pub mod process;
pub mod protocol;
pub mod relaunch;
pub mod state;
pub mod tray;
pub mod update;

/// A folder for one test, removed when it is dropped (also when the test fails), so the tests leave nothing in the
/// system's temp folder.
#[cfg(test)]
pub mod test_dir {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub struct TempDir(PathBuf);

    impl TempDir {
        /// A fresh, empty folder named `<prefix> <pid>-<n>`; the prefixes have a space and a diacritic on purpose.
        pub fn new(prefix: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!("{prefix} {}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for TempDir {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_folder_is_removed_when_dropped() {
        let dir = TempDir::new("fornax tray test-dir é");
        std::fs::write(dir.join("a"), "x").unwrap();
        let path = dir.to_path_buf();
        assert!(path.join("a").exists());
        drop(dir);
        assert!(!path.exists());
    }
}

#[cfg(test)]
mod conf_tests {
    /// Spec 06 4.2 (Review Focus 5): Tauri's own file drop would take the window's drag events on Windows, and the
    /// waiting jobs could not be dragged.
    #[test]
    fn html_drag_and_drop_reaches_the_window() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"][0]["dragDropEnabled"], serde_json::Value::Bool(false));
        assert_eq!(conf["app"]["windows"][0]["width"], 480);
        assert_eq!(conf["app"]["windows"][0]["height"], 680);
    }
}
