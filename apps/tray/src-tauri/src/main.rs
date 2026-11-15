// The Fornax tray app; Task 6 of plan 06b wires the tray, the controller and the window commands.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default().run(tauri::generate_context!()).expect("error while running the Fornax tray");
}
