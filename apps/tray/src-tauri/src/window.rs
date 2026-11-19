//! The window's size, place and History card (0.12.0), remembered in `<data>/tray-window.json`. The width can always
//! change; the height only while the History / Worker log card is open. Closed, the window is as high as what it shows,
//! which the window measures and sends (`set_history`). The place is the window's top-left corner in physical pixels; a
//! place no monitor shows any more (a monitor was unplugged) is not used, and the window opens in the middle.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, PhysicalPosition, WebviewWindow};

/// The narrowest window: the width of 0.8.0's fixed window.
pub const MIN_WIDTH: f64 = 400.0;
/// The lowest window with the card open (spec 06e § 2.1): the card keeps at least 140 px.
pub const MIN_HEIGHT: f64 = 720.0;
const DEFAULT_HEIGHT: f64 = 820.0;
/// The lowest closed window: a wrong measurement never shrinks it to nothing.
const MIN_FIT: f64 = 200.0;
/// Tauri's largest size takes both sides; the width has no limit of its own.
const ANY_WIDTH: f64 = 100_000.0;
/// How long the window stays still before its size and place are written (a drag reports every pixel).
const SAVE_AFTER: Duration = Duration::from_millis(500);
/// A point of the title bar, from the window's top-left corner: the window is on screen when a monitor shows it.
const GRIP: (i32, i32) = (40, 16);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    /// Logical pixels.
    pub width: f64,
    /// Logical pixels, with the card open.
    pub height: f64,
    /// Logical pixels: the last height the closed window measured; the first guess before the window measures again.
    pub fit_height: Option<f64>,
    /// Physical pixels: the window's top-left corner; none before the window was first moved.
    pub position: Option<(i32, i32)>,
    pub history_open: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { width: MIN_WIDTH, height: DEFAULT_HEIGHT, fit_height: None, position: None, history_open: true }
    }
}

/// The sizes the window gets: its smallest and largest size and the size itself, in logical pixels.
#[derive(Debug, PartialEq)]
pub struct Layout {
    pub min: (f64, f64),
    pub max: Option<(f64, f64)>,
    pub size: (f64, f64),
}

/// A monitor's work area (without the taskbar), physical pixels.
#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Prefs {
    /// What a hand-edited or broken file holds, made usable: sizes below the smallest grow to it.
    fn sane(self) -> Self {
        let d = Prefs::default();
        let at_least = |v: f64, min: f64, fallback: f64| if v.is_finite() { v.max(min) } else { fallback };
        Prefs {
            width: at_least(self.width, MIN_WIDTH, d.width),
            height: at_least(self.height, MIN_HEIGHT, d.height),
            fit_height: self.fit_height.filter(|h| h.is_finite()).map(|h| h.max(MIN_FIT)),
            ..self
        }
    }

    /// `cap`: the highest window the screen shows (logical pixels, without the window's frame); the closed window is
    /// never higher, and its page then scrolls.
    pub fn layout(&self, cap: Option<f64>) -> Layout {
        if self.history_open {
            return Layout { min: (MIN_WIDTH, MIN_HEIGHT), max: None, size: (self.width, self.height) };
        }
        let fit = self.fit_height.unwrap_or(MIN_HEIGHT);
        let h = cap.filter(|c| c.is_finite() && *c > 0.0).map_or(fit, |c| fit.min(c));
        Layout { min: (MIN_WIDTH, h), max: Some((ANY_WIDTH, h)), size: (self.width, h) }
    }

    /// The size the window reports (logical pixels): the width always, the height only with the card open (closed, the
    /// height follows what the window shows). A minimized window's size (0 × 0) is not one. Whether anything changed.
    pub fn resized(&mut self, width: f64, height: f64) -> bool {
        if !(width >= 1.0 && height >= 1.0) {
            return false;
        }
        let before = self.clone();
        self.width = width.max(MIN_WIDTH);
        if self.history_open {
            self.height = height.max(MIN_HEIGHT);
        }
        *self != before
    }

    pub fn moved(&mut self, x: i32, y: i32) -> bool {
        let changed = self.position != Some((x, y));
        self.position = Some((x, y));
        changed
    }

    /// The card opened or closed; `fit`: the height of the closed window, as the window measured it.
    pub fn set_history(&mut self, open: bool, fit: Option<f64>) -> bool {
        let before = self.clone();
        self.history_open = open;
        if let Some(h) = fit.filter(|h| h.is_finite()) {
            self.fit_height = Some(h.max(MIN_FIT));
        }
        *self != before
    }

    /// The remembered place, if a monitor still shows the window's title bar there.
    pub fn place(&self, areas: &[Area]) -> Option<(i32, i32)> {
        let (x, y) = self.position?;
        let (gx, gy) = (i64::from(x) + i64::from(GRIP.0), i64::from(y) + i64::from(GRIP.1));
        let shows = |a: &Area| {
            let (ax, ay) = (i64::from(a.x), i64::from(a.y));
            gx >= ax && gx < ax + i64::from(a.width) && gy >= ay && gy < ay + i64::from(a.height)
        };
        areas.iter().any(shows).then_some((x, y))
    }
}

/// The remembered window, or the default one when the file is missing or cannot be read.
pub fn load(file: &Path) -> Prefs {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Prefs>(text.trim_start_matches('\u{feff}')).ok())
        .map_or_else(Prefs::default, Prefs::sane)
}

/// Writes the file whole or not at all: a temporary file renamed over it.
pub fn save(file: &Path, prefs: &Prefs) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(prefs).map_err(std::io::Error::other)? + "\n";
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, file)
}

/// The window's remembered state; changes are written once the window stays still for `SAVE_AFTER`.
pub struct Store {
    file: PathBuf,
    prefs: Mutex<Prefs>,
    changed: Mutex<Sender<()>>,
    /// One write at a time: the saver thread and a flush share the temporary file.
    writing: Mutex<()>,
}

impl Store {
    pub fn open(file: PathBuf) -> Arc<Store> {
        let (tx, rx) = channel::<()>();
        let store = Arc::new(Store { prefs: Mutex::new(load(&file)), file, changed: Mutex::new(tx), writing: Mutex::new(()) });
        let weak = Arc::downgrade(&store);
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                loop {
                    match rx.recv_timeout(SAVE_AFTER) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                match weak.upgrade() {
                    Some(store) => store.flush(),
                    None => return,
                }
            }
        });
        store
    }

    pub fn get(&self) -> Prefs {
        self.prefs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Changes the state; a change is written later.
    pub fn update(&self, change: impl FnOnce(&mut Prefs) -> bool) {
        let changed = change(&mut self.prefs.lock().unwrap_or_else(|e| e.into_inner()));
        if changed {
            let _ = self.changed.lock().unwrap_or_else(|e| e.into_inner()).send(());
        }
    }

    /// Writes the state now (the window was hidden, the tray ends). A failure is not shown: the window then opens as
    /// before.
    pub fn flush(&self) {
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let _ = save(&self.file, &self.get());
    }
}

/// The highest window the monitor it is on shows: its work area less the window's frame, in logical pixels.
fn screen_cap(window: &WebviewWindow) -> Option<f64> {
    let monitor = window.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let (outer, inner) = (window.outer_size().ok()?, window.inner_size().ok()?);
    let frame = f64::from(outer.height.saturating_sub(inner.height));
    Some((f64::from(monitor.work_area().size.height) - frame) / scale)
}

/// Gives the window the sizes of `prefs`; `place`: first its remembered place when a monitor still shows it, else the
/// middle of the screen (the window starts there).
pub fn apply(window: &WebviewWindow, prefs: &Prefs, place: bool) {
    let size = |(w, h): (f64, f64)| LogicalSize::new(w, h);
    let mut placed = false;
    if place {
        let areas: Vec<Area> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| {
                let a = m.work_area();
                Area { x: a.position.x, y: a.position.y, width: a.size.width, height: a.size.height }
            })
            .collect();
        if let Some((x, y)) = prefs.place(&areas) {
            placed = window.set_position(PhysicalPosition::new(x, y)).is_ok();
        }
    }
    let l = prefs.layout(screen_cap(window));
    let _ = window.set_max_size(l.max.map(size));
    let _ = window.set_min_size(Some(size(l.min)));
    let _ = window.set_size(size(l.size));
    // Centred again for the size it has now.
    if place && !placed {
        let _ = window.center();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TempDir;

    #[test]
    fn a_new_window_is_400_by_820_with_the_card_open() {
        let p = Prefs::default();
        assert_eq!(p.layout(None), Layout { min: (400.0, 720.0), max: None, size: (400.0, 820.0) });
        assert_eq!(p.place(&[Area { x: 0, y: 0, width: 1920, height: 1040 }]), None);
    }

    #[test]
    fn closed_the_window_is_as_high_as_it_measured_and_only_its_width_changes() {
        let mut p = Prefs { width: 520.0, height: 900.0, ..Prefs::default() };
        assert!(p.set_history(false, Some(480.0)));
        assert_eq!(p.layout(None), Layout { min: (400.0, 480.0), max: Some((ANY_WIDTH, 480.0)), size: (520.0, 480.0) });
        // A drag of the closed window's edge: the width is kept, the height of the open window stays.
        assert!(p.resized(610.0, 480.0));
        assert_eq!((p.width, p.height), (610.0, 900.0));
        // Opened again: the height it had open.
        assert!(p.set_history(true, None));
        assert_eq!(p.layout(None), Layout { min: (400.0, 720.0), max: None, size: (610.0, 900.0) });
        assert_eq!(p.fit_height, Some(480.0));
    }

    #[test]
    fn a_closed_window_is_never_higher_than_the_screen_shows() {
        let p = Prefs { history_open: false, fit_height: Some(900.0), width: 450.0, ..Prefs::default() };
        assert_eq!(p.layout(Some(650.0)), Layout { min: (400.0, 650.0), max: Some((ANY_WIDTH, 650.0)), size: (450.0, 650.0) });
        assert_eq!(p.layout(Some(1200.0)).size.1, 900.0);
        // A broken monitor reading changes nothing.
        assert_eq!(p.layout(Some(f64::NAN)).size.1, 900.0);
        assert_eq!(p.layout(Some(0.0)).size.1, 900.0);
        // The open window keeps its own height; it is at least 720 high as before.
        let open = Prefs { height: 1000.0, ..Prefs::default() };
        assert_eq!(open.layout(Some(650.0)).size, (400.0, 1000.0));
    }

    #[test]
    fn open_both_sides_are_kept_and_never_below_the_smallest() {
        let mut p = Prefs::default();
        assert!(p.resized(700.5, 1000.0));
        assert_eq!((p.width, p.height), (700.5, 1000.0));
        assert!(p.resized(399.6, 719.4));
        assert_eq!((p.width, p.height), (400.0, 720.0));
        assert!(!p.resized(400.0, 720.0));
    }

    #[test]
    fn a_minimized_window_size_is_not_kept() {
        let mut p = Prefs { width: 600.0, height: 900.0, ..Prefs::default() };
        assert!(!p.resized(0.0, 0.0));
        assert!(!p.resized(f64::NAN, 900.0));
        assert_eq!((p.width, p.height), (600.0, 900.0));
    }

    #[test]
    fn a_measured_height_is_never_below_the_lowest_closed_window() {
        let mut p = Prefs::default();
        p.set_history(false, Some(12.0));
        assert_eq!(p.layout(None).size.1, 200.0);
        // Not measured yet: the lowest open window.
        let q = Prefs { history_open: false, ..Prefs::default() };
        assert_eq!(q.layout(None).size.1, 720.0);
    }

    #[test]
    fn the_place_is_used_only_where_a_monitor_still_shows_the_title_bar() {
        let left = Area { x: -1920, y: 0, width: 1920, height: 1040 };
        let main = Area { x: 0, y: 0, width: 2560, height: 1400 };
        let mut p = Prefs::default();
        assert!(p.moved(-1500, 200));
        assert!(!p.moved(-1500, 200));
        assert_eq!(p.place(&[main, left]), Some((-1500, 200)));
        // The left monitor was unplugged.
        assert_eq!(p.place(&[main]), None);
        // Only the title bar's grip counts: the corner itself a few pixels off screen is fine, the grip off is not.
        p.moved(-30, -10);
        assert_eq!(p.place(&[main]), Some((-30, -10)));
        p.moved(-41, 0);
        assert_eq!(p.place(&[main]), None);
        p.moved(2519, 1383);
        assert_eq!(p.place(&[main]), Some((2519, 1383)));
        p.moved(2519, 1384);
        assert_eq!(p.place(&[main]), None);
    }

    #[test]
    fn saved_and_loaded_whole() {
        let dir = TempDir::new("fornax-window ž");
        let file = dir.join("tray-window.json");
        assert_eq!(load(&file), Prefs::default());
        let p = Prefs { width: 640.0, height: 1000.0, fit_height: Some(455.0), position: Some((-1500, 30)), history_open: false };
        save(&file, &p).unwrap();
        assert_eq!(load(&file), p);
        assert!(!dir.join("tray-window.json.tmp").exists());
    }

    #[test]
    fn a_broken_or_hand_edited_file_still_gives_a_usable_window() {
        let dir = TempDir::new("fornax-window ž");
        let file = dir.join("tray-window.json");
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(load(&file), Prefs::default());
        std::fs::write(&file, "\u{feff}{\"width\": 100, \"height\": 300, \"fitHeight\": 50, \"historyOpen\": false}").unwrap();
        let p = load(&file);
        assert_eq!((p.width, p.height, p.fit_height, p.history_open, p.position), (400.0, 720.0, Some(200.0), false, None));
    }

    #[test]
    fn the_store_writes_a_change_once_the_window_stays_still() {
        let dir = TempDir::new("fornax-window ž");
        let file = dir.join("tray-window.json");
        let store = Store::open(file.clone());
        store.update(|p| p.moved(10, 20));
        store.update(|p| p.resized(500.0, 800.0));
        // A slow machine only writes later, never sooner.
        std::thread::sleep(SAVE_AFTER / 2);
        assert!(!file.exists(), "written before the window stayed still");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !file.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(load(&file), Prefs { width: 500.0, height: 800.0, position: Some((10, 20)), ..Prefs::default() });
    }

    #[test]
    fn the_store_waits_for_the_last_change_not_the_first() {
        let dir = TempDir::new("fornax-window ž");
        let file = dir.join("tray-window.json");
        let store = Store::open(file.clone());
        store.update(|p| p.moved(10, 20));
        std::thread::sleep(SAVE_AFTER * 3 / 5);
        store.update(|p| p.moved(30, 40));
        std::thread::sleep(SAVE_AFTER * 3 / 5);
        assert!(!file.exists(), "written while the window still moved");
    }

    #[test]
    fn flush_writes_at_once_and_no_change_writes_nothing() {
        let dir = TempDir::new("fornax-window ž");
        let file = dir.join("tray-window.json");
        let store = Store::open(file.clone());
        store.update(|_| false);
        std::thread::sleep(SAVE_AFTER * 2);
        assert!(!file.exists());
        store.update(|p| p.set_history(false, Some(500.0)));
        store.flush();
        assert!(!load(&file).history_open);
    }
}
