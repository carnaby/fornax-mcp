//! Where the tray finds things (spec 06 4.6): the worker's own folders, by the rules of apps/worker/src/paths.ts, and
//! the tray's settings in `<config>/tray.json`.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};

/// The worker's folders on this PC: `config` holds worker.yaml, the tokens and tray.json; `data` holds the installed
/// program (`app/fornax.mjs`) and `worker.lock`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
}

impl Paths {
    /// From the environment, like the worker.
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let windows = cfg!(windows);
        let home = PathBuf::from(env(if windows { "USERPROFILE" } else { "HOME" }).unwrap_or_default());
        Paths::resolve(&env, windows, &home)
    }

    /// apps/worker/src/paths.ts resolvePaths: FORNAX_CONFIG_DIR / FORNAX_DATA_DIR win; Windows %APPDATA%\fornax and
    /// %LOCALAPPDATA%\fornax, elsewhere $XDG_CONFIG_HOME/fornax and $XDG_DATA_HOME/fornax (~/.config, ~/.local/share);
    /// a relative APPDATA or XDG value is ignored.
    pub fn resolve(env: &dyn Fn(&str) -> Option<String>, windows: bool, home: &Path) -> Self {
        let given = |k: &str| env(k).map(PathBuf::from).map(|p| std::path::absolute(&p).unwrap_or(p));
        let abs = |k: &str| env(k).map(PathBuf::from).filter(|p| p.is_absolute());
        let config = given("FORNAX_CONFIG_DIR").unwrap_or_else(|| {
            if windows {
                abs("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")).join("fornax")
            } else {
                abs("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")).join("fornax")
            }
        });
        let data = given("FORNAX_DATA_DIR").unwrap_or_else(|| {
            if windows {
                abs("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")).join("fornax")
            } else {
                abs("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share")).join("fornax")
            }
        });
        Paths { config, data }
    }

    /// The installed fornax (spec 06 4.1).
    pub fn cli(&self) -> PathBuf {
        self.data.join("app").join("fornax.mjs")
    }

    /// The worker's lock: the pid of the one worker on this PC.
    pub fn lock(&self) -> PathBuf {
        self.data.join("worker.lock")
    }

    pub fn tray_json(&self) -> PathBuf {
        self.config.join("tray.json")
    }
}

/// What the tray runs and how it starts (spec 06 4.6), and the file the settings come from (named in messages).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayConfig {
    pub node: PathBuf,
    pub cli: PathBuf,
    pub start_worker: bool,
    pub file: PathBuf,
}

/// tray.json as written; an unknown key is refused, so a typo does not pass unnoticed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    node: Option<String>,
    start_worker: Option<bool>,
}

/// PowerShell 5.1 writes UTF-8 with a byte-order mark.
fn strip_bom(text: &str) -> &str {
    match char::from_u32(0xFEFF) {
        Some(bom) => text.strip_prefix(bom).unwrap_or(text),
        None => text,
    }
}

/// Node from PATH, the installed fornax, the worker started with the tray.
pub fn defaults(paths: &Paths) -> TrayConfig {
    TrayConfig { node: PathBuf::from("node"), cli: paths.cli(), start_worker: true, file: paths.tray_json() }
}

/// The settings in tray.json; no file means the defaults, a broken one a sentence (spec 06 § 5).
pub fn load(paths: &Paths) -> Result<TrayConfig, String> {
    let file = paths.tray_json();
    let parsed = match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str::<File>(strip_bom(&text)).map_err(|e| format!("{} is not valid: {e}", file.display()))?,
        Err(e) if e.kind() == ErrorKind::NotFound => File { node: None, start_worker: None },
        // PowerShell 5.1 writes UTF-16 with `>` and Out-File.
        Err(e) if e.kind() == ErrorKind::InvalidData => return Err(format!("cannot read {}: {e}; save it as UTF-8", file.display())),
        Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
    };
    let node = parsed.node.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(PathBuf::from);
    Ok(TrayConfig { node: node.unwrap_or_else(|| PathBuf::from("node")), cli: paths.cli(), start_worker: parsed.start_worker.unwrap_or(true), file })
}

/// The menu's "Start worker with the tray": writes `start_worker`, keeps every other key; a broken file is left
/// as it is.
pub fn save_start_worker(paths: &Paths, on: bool) -> Result<(), String> {
    let file = paths.tray_json();
    let mut doc = match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<Value>(strip_bom(&text)) {
            Ok(Value::Object(map)) => map,
            _ => return Err(format!("{} is not valid: fix it, then change the setting again", file.display())),
        },
        Err(e) if e.kind() == ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
    };
    doc.insert("start_worker".to_string(), Value::Bool(on));
    let text = serde_json::to_string_pretty(&Value::Object(doc)).map_err(|e| e.to_string())? + "\n";
    std::fs::create_dir_all(&paths.config).map_err(|e| format!("cannot create {}: {e}", paths.config.display()))?;
    std::fs::write(&file, text).map_err(|e| format!("cannot write {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::test_dir::TempDir;

    /// A fresh folder whose name has a space and a diacritic.
    fn temp() -> TempDir {
        TempDir::new("fornax tray config é")
    }

    fn paths(dir: &Path) -> Paths {
        Paths { config: dir.join("config"), data: dir.join("data") }
    }

    fn write(p: &Paths, bytes: &[u8]) {
        fs::create_dir_all(&p.config).unwrap();
        fs::write(p.tray_json(), bytes).unwrap();
    }

    fn bom() -> char {
        char::from_u32(0xFEFF).unwrap()
    }

    #[test]
    fn finds_the_folders_like_the_worker() {
        let base = std::env::temp_dir();
        let a = base.join("A");
        let l = base.join("L");
        let x = base.join("X");
        let pairs = [("APPDATA", a.clone()), ("LOCALAPPDATA", l.clone()), ("XDG_CONFIG_HOME", a.clone()), ("XDG_DATA_HOME", l.clone())];
        let env = |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string_lossy().into_owned());
        let home = base.join("H");
        let windows = cfg!(windows);
        let p = Paths::resolve(&env, windows, &home);
        assert_eq!(p, Paths { config: a.join("fornax"), data: l.join("fornax") });
        let none = |_: &str| None;
        let p = Paths::resolve(&none, windows, &home);
        if windows {
            assert_eq!(p, Paths { config: home.join("AppData").join("Roaming").join("fornax"), data: home.join("AppData").join("Local").join("fornax") });
        } else {
            assert_eq!(p, Paths { config: home.join(".config").join("fornax"), data: home.join(".local").join("share").join("fornax") });
        }
        let over = |k: &str| match k {
            "FORNAX_CONFIG_DIR" | "FORNAX_DATA_DIR" => Some(x.to_string_lossy().into_owned()),
            _ => None,
        };
        let p = Paths::resolve(&over, windows, &home);
        assert_eq!(p, Paths { config: x.clone(), data: x.clone() });
        assert_eq!(p.cli(), x.join("app").join("fornax.mjs"));
        assert_eq!(p.lock(), x.join("worker.lock"));
        assert_eq!(p.tray_json(), x.join("tray.json"));
    }

    #[test]
    fn a_relative_xdg_or_appdata_folder_is_ignored() {
        let home = std::env::temp_dir().join("H");
        let rel = |k: &str| match k {
            "APPDATA" | "XDG_CONFIG_HOME" => Some("relative".to_string()),
            _ => None,
        };
        let p = Paths::resolve(&rel, cfg!(windows), &home);
        assert!(p.config.starts_with(&home), "{:?}", p.config);
    }

    #[test]
    fn without_tray_json_runs_node_from_path_and_starts_the_worker() {
        let dir = temp();
        let p = paths(&dir);
        assert_eq!(load(&p), Ok(TrayConfig { node: PathBuf::from("node"), cli: p.cli(), start_worker: true, file: p.tray_json() }));
        assert_eq!(defaults(&p), load(&p).unwrap());
    }

    #[test]
    fn reads_node_and_start_worker_even_with_a_bom() {
        let dir = temp();
        let p = paths(&dir);
        let node = dir.join("Program Files").join("nodejs").join("node.exe");
        let json = serde_json::json!({ "node": &node, "start_worker": false }).to_string();
        // PowerShell 5.1 writes UTF-8 with a byte-order mark.
        write(&p, format!("{}{json}", bom()).as_bytes());
        let cfg = load(&p).unwrap();
        assert_eq!((cfg.node, cfg.start_worker), (node, false));
    }

    #[test]
    fn a_blank_node_means_node_from_path() {
        let dir = temp();
        let p = paths(&dir);
        write(&p, br#"{ "node": " " }"#);
        assert_eq!(load(&p).unwrap().node, PathBuf::from("node"));
    }

    #[test]
    fn refuses_broken_json_and_unknown_keys() {
        let dir = temp();
        let p = paths(&dir);
        write(&p, b"{ node: ");
        assert!(load(&p).unwrap_err().contains("tray.json is not valid"));
        write(&p, br#"{ "startWorker": false }"#);
        assert!(load(&p).unwrap_err().contains("unknown field `startWorker`"));
    }

    #[test]
    fn says_to_save_a_utf16_tray_json_as_utf8() {
        let dir = temp();
        let p = paths(&dir);
        // What PowerShell 5.1 `>` and Out-File write: UTF-16 LE with a byte-order mark.
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain(r#"{ "node": "node" }"#.encode_utf16().flat_map(u16::to_le_bytes)).collect();
        write(&p, &utf16);
        let message = load(&p).unwrap_err();
        assert!(message.contains("cannot read") && message.contains("tray.json") && message.contains("save it as UTF-8"), "{message}");
    }

    #[test]
    fn saving_the_setting_keeps_the_other_keys() {
        let dir = temp();
        let p = paths(&dir);
        save_start_worker(&p, false).unwrap();
        assert!(!load(&p).unwrap().start_worker);
        let node = dir.join("node.exe");
        write(&p, format!("{}{}", bom(), serde_json::json!({ "node": &node, "start_worker": false })).as_bytes());
        save_start_worker(&p, true).unwrap();
        let cfg = load(&p).unwrap();
        assert_eq!((cfg.node, cfg.start_worker), (node, true));
        let text = fs::read_to_string(p.tray_json()).unwrap();
        assert!(text.ends_with("}\n") && !text.contains(bom()), "{text}");
    }

    #[test]
    fn a_broken_tray_json_is_not_overwritten() {
        let dir = temp();
        let p = paths(&dir);
        write(&p, b"{ broken");
        let message = save_start_worker(&p, true).unwrap_err();
        assert!(message.contains("tray.json is not valid: fix it, then change the setting again"), "{message}");
        assert_eq!(fs::read(p.tray_json()).unwrap(), b"{ broken");
    }
}
