//! The core of the Fornax tray (spec 06 § 4); `main.rs` wires it to Tauri.

pub mod config;
pub mod lock;
pub mod process;
pub mod protocol;
pub mod relaunch;
pub mod state;

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
