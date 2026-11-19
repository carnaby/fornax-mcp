// The Fornax tray app (spec 06 § 4): an icon next to the clock that starts the worker and shows and orders its queue.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use fornax_tray_lib::config::Paths;
use fornax_tray_lib::controller::{Controller, Timing};
use fornax_tray_lib::protocol::is_web_url;
use fornax_tray_lib::relaunch::{self, Start};
use fornax_tray_lib::state::{Input, MoveTo, Snapshot};
use fornax_tray_lib::tray::{show_window, TrayUi, WINDOW};
use fornax_tray_lib::window::{self as place, Store};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

/// What the start at sign-in passes: the tray then starts without its window.
const BACKGROUND: &str = "--background";

#[tauri::command]
fn snapshot(ctl: State<'_, Controller>) -> Snapshot {
    ctl.snapshot()
}

#[tauri::command]
fn start_worker(ctl: State<'_, Controller>) {
    ctl.send(Input::StartWorker);
}

#[tauri::command]
fn stop_worker(ctl: State<'_, Controller>) {
    ctl.send(Input::StopWorker);
}

#[tauri::command]
fn set_paused(paused: bool, ctl: State<'_, Controller>) {
    ctl.send(Input::SetPaused(paused));
}

#[tauri::command]
fn move_job(id: String, to: String, other: Option<String>, ctl: State<'_, Controller>) -> Result<(), String> {
    let to = match (to.as_str(), other) {
        ("top", _) => MoveTo::Top,
        ("bottom", _) => MoveTo::Bottom,
        ("before", Some(other)) => MoveTo::Before(other),
        ("after", Some(other)) => MoveTo::After(other),
        _ => return Err(format!("unknown move: {to}")),
    };
    ctl.send(Input::Move { id, to });
    Ok(())
}

#[tauri::command]
fn cancel_job(id: String, ctl: State<'_, Controller>) {
    ctl.send(Input::Cancel { id });
}

/// Spec 07 § 5.1: a waiting job's new priority.
#[tauri::command]
fn set_priority(id: String, priority: String, ctl: State<'_, Controller>) -> Result<(), String> {
    if !matches!(priority.as_str(), "high" | "normal" | "idle") {
        return Err(format!("unknown priority: {priority}"));
    }
    ctl.send(Input::SetPriority { id, priority });
    Ok(())
}

/// Spec 07 § 5.3: the running job back to the queue (idle: Pause).
#[tauri::command]
fn requeue_job(id: String, idle: bool, ctl: State<'_, Controller>) {
    ctl.send(Input::Requeue { id, idle });
}

/// Spec 07 § 5.2: Start all.
#[tauri::command]
fn start_idle(ctl: State<'_, Controller>) {
    ctl.send(Input::StartIdle);
}

/// A job's result page in the browser (only http and https links open). A failure shows next to the job for 10 s,
/// like a failed action, and in the log.
#[tauri::command]
fn open_result(id: String, app: AppHandle, ctl: State<'_, Controller>) -> Result<(), String> {
    let s = ctl.snapshot();
    let url = s.running.iter().chain(&s.queued).chain(&s.finished).find(|j| j.id == id).map(|j| j.result_url.clone());
    let opened = match url {
        None => Err("the job is no longer listed".to_string()),
        Some(url) if !is_web_url(&url) => Err(format!("not a web address: {url}")),
        Some(url) => app.opener().open_url(url, None::<&str>).map_err(|e| format!("cannot open the result page: {e}")),
    };
    if let Err(message) = &opened {
        ctl.send(Input::ActionDone { key: id, result: Err(message.clone()) });
    }
    opened
}

#[tauri::command]
fn confirm_quit(yes: bool, ctl: State<'_, Controller>) {
    ctl.send(Input::ConfirmQuit(yes));
}

/// Spec 06d 4.3: the update the window offers, and its cancel.
#[tauri::command]
fn update(ctl: State<'_, Controller>) {
    ctl.send(Input::Update);
}

#[tauri::command]
fn cancel_update(ctl: State<'_, Controller>) {
    ctl.send(Input::CancelUpdate);
}

/// 0.12.0: whether the History / Worker log card is open, as the window last left it.
#[tauri::command]
fn history_open(store: State<'_, Arc<Store>>) -> bool {
    store.get().history_open
}

/// 0.12.0: the card opened or closed; `height`: what the closed window shows, as the window measured it (logical px).
#[tauri::command]
fn set_history(open: bool, height: Option<f64>, app: AppHandle, store: State<'_, Arc<Store>>) {
    let window = app.get_webview_window(WINDOW).filter(|w| !w.is_minimized().unwrap_or(false));
    // First the size the window has now: on Linux its last Resized may come after this call, and the old width would
    // pull a window the user is dragging back.
    if let Some((width, height)) = window.as_ref().and_then(logical_size) {
        store.update(|p| p.resized(width, height));
    }
    store.update(|p| p.set_history(open, height));
    // A minimized window is fitted when it gets the focus again.
    if let Some(window) = window {
        place::apply(&window, &store.get(), false);
    }
}

/// The window's inner size in logical pixels.
fn logical_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let size = window.inner_size().ok()?.to_logical::<f64>(window.scale_factor().ok()?);
    Some((size.width, size.height))
}

fn main() {
    let paths = Paths::from_env();
    // First, before the single-instance plugin registers: a tray started by the installer starts itself again without
    // the installer's Redirection Guard (see relaunch.rs).
    let guarded = match relaunch::check(&paths.data) {
        Start::Relaunched => std::process::exit(0),
        Start::Guarded => true,
        Start::Normal => false,
    };
    tauri::Builder::default()
        // First: a second start of the tray only opens the window of the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![BACKGROUND])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![snapshot, start_worker, stop_worker, set_paused, move_job, cancel_job, set_priority, requeue_job, start_idle, open_result, confirm_quit, update, cancel_update, history_open, set_history])
        .setup(move |app| {
            let handle = app.handle().clone();
            // A click on a notification opens the window (Windows reports it while the toast is on screen). Set up before
            // the controller starts: a notification shown before any handler existed reports nothing.
            let shown = handle.clone();
            app.notification().on_action(move |action| {
                if action.action_id() == "tap" {
                    show_window(&shown);
                }
            })?;
            // The remembered size and place, before the window is first shown.
            let store = Store::open(paths.data.join("tray-window.json"));
            if let Some(window) = app.get_webview_window(WINDOW) {
                place::apply(&window, &store.get(), true);
            }
            app.manage(store);
            let ui = Arc::new(TrayUi::build(&handle)?);
            let warning = guarded.then(|| relaunch::WARNING.to_string());
            let controller = Controller::start(paths, ui, Timing::default(), warning);
            app.manage(controller);
            if !std::env::args().any(|a| a == BACKGROUND) {
                show_window(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let store = window.try_state::<Arc<Store>>();
            // A minimized window reports 0 × 0 and, on Windows, a place far off screen: neither is remembered.
            let still = || !window.is_minimized().unwrap_or(false);
            match event {
                // Closing the window only hides it; the tray keeps running.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(store) = store {
                        store.flush();
                    }
                    if let Some(ctl) = window.try_state::<Controller>() {
                        ctl.send(Input::WindowShown(false));
                    }
                }
                WindowEvent::Moved(at) if still() => {
                    if let Some(store) = store {
                        store.update(|p| p.moved(at.x, at.y));
                    }
                }
                WindowEvent::Resized(size) if still() => {
                    if let (Some(store), Ok(scale)) = (store, window.scale_factor()) {
                        let size = size.to_logical::<f64>(scale);
                        store.update(|p| p.resized(size.width, size.height));
                    }
                }
                // The closed window may have missed a new height while it was minimized.
                WindowEvent::Focused(true) if still() => {
                    if let (Some(store), Some(window)) = (store, window.app_handle().get_webview_window(window.label())) {
                        let prefs = store.get();
                        if !prefs.history_open {
                            place::apply(&window, &prefs, false);
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Fornax tray")
        .run(|app, event| match event {
            // Only Quit ends the tray (it exits with a code); nothing else may, such as the last window closing.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // The window's last moves, before the saver thread wrote them.
            RunEvent::Exit => {
                if let Some(store) = app.try_state::<Arc<Store>>() {
                    store.flush();
                }
            }
            _ => {}
        });
}
