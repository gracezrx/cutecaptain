//! cutecaptain's native core: the menu bar icon, the global shortcuts,
//! the frosted panel that drops down from the icon, the floating talk button,
//! voice (Apple's speech recognition and voices, through the captain-voice
//! helper), screen snapshots, notifications that open the right thread, and
//! the private settings file (the session and the built-in server's database).
//!
//! Everything else (chats, messages, decisions) lives in the web view and
//! talks to the Captain server directly (REST and one WebSocket). That server
//! can be a hosted one, or the one built into this app (see "built-in server").

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const TRAY_ID: &str = "captain";

/// Which view the panel should open on. Matches `PanelTarget` in src/lib/native.ts.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelTarget {
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    post_id: Option<String>,
}

impl PanelTarget {
    fn mode(mode: &str) -> Self {
        Self { mode: mode.into(), ..Default::default() }
    }
}

#[derive(Default)]
struct AppState {
    /// Where the menu bar icon is, in physical pixels: x, y, width, height.
    tray_rect: Mutex<Option<(f64, f64, f64, f64)>>,
    /// True while a snapshot is being taken, so the panel doesn't hide itself.
    capturing: Mutex<bool>,
}

// ------------------------------------------------------------ panel

fn panel(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("panel")
}

/// Put the panel just under the menu bar icon, or at the top right of the
/// screen if we don't know where the icon is yet.
fn position_panel(app: &AppHandle, window: &WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(2.0);
    let width = window.outer_size().map(|s| s.width as f64).unwrap_or(400.0 * scale);
    let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    let gap = 6.0 * scale;

    let rect = *app.state::<AppState>().tray_rect.lock().unwrap();
    let (mut x, y) = match rect {
        Some((tx, ty, tw, th)) => (tx + tw / 2.0 - width / 2.0, ty + th + gap),
        None => match &monitor {
            Some(m) => (
                m.position().x as f64 + m.size().width as f64 - width - 12.0 * scale,
                m.position().y as f64 + 30.0 * scale,
            ),
            None => (0.0, 30.0 * scale),
        },
    };
    if let Some(m) = &monitor {
        let left = m.position().x as f64 + 8.0 * scale;
        let right = m.position().x as f64 + m.size().width as f64 - width - 8.0 * scale;
        x = x.clamp(left, right.max(left));
    }
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn open_panel(app: &AppHandle, target: PanelTarget) {
    let Some(window) = panel(app) else { return };
    position_panel(app, &window);
    let _ = app.emit_to("panel", "panel-target", target);
    let _ = window.show();
    let _ = window.set_focus();
}

/// The shortcut and the icon toggle the panel: a second press closes it.
fn toggle_panel(app: &AppHandle, target: PanelTarget) {
    if let Some(window) = panel(app) {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }
    open_panel(app, target);
}

#[tauri::command]
fn show_panel(app: AppHandle, target: PanelTarget) {
    open_panel(&app, target);
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    if let Some(window) = panel(&app) {
        let _ = window.hide();
    }
}

// ------------------------------------------------------------ dashboard

fn show_dashboard(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(window) = panel(app) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn open_dashboard(app: AppHandle) {
    show_dashboard(&app);
}

// ------------------------------------------------------------ Chrome extension
//
// The app carries the Chrome extension (resources/extension). Chrome loads an
// unpacked extension from a folder it can keep reading, so this copies it to
// the app's data folder and shows it in Finder.

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Open a web link in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    // Web and email links, and the Privacy & Security pages of System Settings.
    let settings = lower.starts_with("x-apple.systempreferences:com.apple.preference.security");
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") || settings) {
        return Err("Only web and email links open from cutecaptain.".into());
    }
    #[cfg(target_os = "macos")]
    Command::new("/usr/bin/open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn chrome_extension_reveal(app: AppHandle) -> Result<String, String> {
    let from = app.path().resource_dir().map_err(|e| e.to_string())?.join("extension");
    if !from.join("manifest.json").exists() {
        return Err("This copy of cutecaptain doesn't include the Chrome extension. Download cutecaptain-Chrome-extension.zip from the release page instead.".into());
    }
    let to = app.path().app_data_dir().map_err(|e| e.to_string())?.join("Chrome extension");
    let _ = std::fs::remove_dir_all(&to);
    copy_dir(&from, &to).map_err(|e| format!("Couldn't copy the extension: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(&to).spawn();
    }
    Ok(to.to_string_lossy().into_owned())
}

// ------------------------------------------------------------ badge

/// The number of things waiting for you, shown next to the menu bar icon.
#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if count > 0 { Some(count.to_string()) } else { None };
        let _ = tray.set_title(title);
        let _ = tray.set_tooltip(Some(if count > 0 {
            format!("cutecaptain · {count} waiting")
        } else {
            "cutecaptain".to_string()
        }));
    }
}

// ------------------------------------------------------------ notifications

/// Show a banner; clicking it opens the panel on that thread.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, target: PanelTarget) {
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(move || {
            use mac_notification_sys::{Notification, NotificationResponse};
            let _ = mac_notification_sys::set_application(&app.config().identifier);
            let response = Notification::new()
                .title(&title)
                .message(&body)
                .wait_for_click(true)
                .send();
            if let Ok(NotificationResponse::Click) = response {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || open_panel(&handle, target));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = target;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

// ------------------------------------------------------------ screen capture

/// Take a snapshot of the main display (or, with `region`, let the person
/// drag a region). Returns PNG bytes, or nothing if they cancelled.
#[tauri::command]
async fn capture_screen(app: AppHandle, region: bool) -> Result<tauri::ipc::Response, String> {
    let state = app.state::<AppState>();
    *state.capturing.lock().unwrap() = true;
    let window = panel(&app);
    if let Some(w) = &window {
        let _ = w.hide();
    }
    // Let the panel fade out of the frame before capturing.
    std::thread::sleep(Duration::from_millis(220));
    let result = capture_png(region);
    if let Some(w) = &window {
        let _ = w.show();
        let _ = w.set_focus();
    }
    *state.capturing.lock().unwrap() = false;
    result.map(tauri::ipc::Response::new)
}

#[cfg(target_os = "macos")]
fn capture_png(region: bool) -> Result<Vec<u8>, String> {
    use std::process::Command;
    let path = std::env::temp_dir().join(format!(
        "captain-snapshot-{}.png",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    ));
    // -x: no sound. -m: main display only. -i: drag a region (Esc cancels).
    let mut args: Vec<&str> = vec!["-x", "-t", "png"];
    args.push(if region { "-i" } else { "-m" });
    let status = Command::new("/usr/sbin/screencapture")
        .args(&args)
        .arg(&path)
        .status()
        .map_err(|e| format!("Couldn't start the screen capture: {e}"))?;
    if !status.success() || !path.exists() {
        // Cancelled, or Screen Recording permission is off.
        return Ok(Vec::new());
    }
    // Keep uploads light: cap the long edge at 2400 px.
    let _ = Command::new("/usr/bin/sips").args(["-Z", "2400"]).arg(&path).output();
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(bytes)
}

#[cfg(not(target_os = "macos"))]
fn capture_png(_region: bool) -> Result<Vec<u8>, String> {
    Err("Screen snapshots are only available on macOS for now.".into())
}

// ------------------------------------------------------------ secrets
//
// The session and the built-in server's settings, in a file in the app's
// config folder that only you can read (0600). They used to be in the
// Keychain, but these builds are signed ad hoc, which gives the app a new
// identity with every update: macOS then hides its Keychain items from it (or
// asks for your password again and again). With a Developer ID, the Keychain
// would work across updates.

fn secrets_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("secrets.json"))
}

fn secrets_read(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    secrets_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn secrets_write(app: &AppHandle, all: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = secrets_path(app).ok_or("No place to keep settings.")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(all).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn secret_value(app: &AppHandle, key: &str) -> Option<String> {
    secrets_read(app).get(key).and_then(|v| v.as_str()).map(str::to_string).filter(|v| !v.is_empty())
}

// One change at a time: each one reads the file, changes a key and writes it back.
static SECRETS_LOCK: Mutex<()> = Mutex::new(());

fn secret_store(app: &AppHandle, key: &str, value: Option<&str>) -> Result<(), String> {
    let _held = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = secrets_read(app);
    match value {
        Some(v) => {
            all.insert(key.to_string(), serde_json::Value::String(v.to_string()));
        }
        None => {
            all.remove(key);
        }
    }
    secrets_write(app, &all)
}

#[tauri::command]
fn secret_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    Ok(secret_value(&app, &key))
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    secret_store(&app, &key, Some(&value))
}

#[tauri::command]
fn secret_delete(app: AppHandle, key: String) -> Result<(), String> {
    secret_store(&app, &key, None)
}

// ------------------------------------------------------------ built-in server
//
// The app carries the Captain server's code (Resources/server) and runs it
// with the Mac's Node.js, so the person never opens a terminal. Its database
// address and secret live in the private settings file (see "secrets"). It
// listens on 127.0.0.1 only.

const LOCAL_PORT: u16 = 8787;
const KEY_DATABASE_URL: &str = "local-server.database-url";
const KEY_APP_SECRET: &str = "local-server.app-secret";

#[derive(Default)]
struct LocalServer {
    child: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
    starting: Mutex<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServerStatus {
    configured: bool,
    running: bool,
    starting: bool,
    url: String,
    error: Option<String>,
    log: Option<String>,
}

fn local_url() -> String {
    format!("http://127.0.0.1:{LOCAL_PORT}")
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Run a command for at most `limit`, returning its output if it finished.
fn output_within(mut cmd: Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

fn node_major(node: &Path) -> Option<u32> {
    let mut cmd = Command::new(node);
    cmd.arg("-v");
    let v = output_within(cmd, Duration::from_secs(5))?;
    v.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Find Node.js 22 or newer. Apps opened from the Finder don't get the
/// terminal's PATH, so look in the usual places and ask the login shell.
fn find_node() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from(format!("{home}/.volta/bin/node")),
        PathBuf::from(format!("{home}/.local/bin/node")),
    ];
    for dir in [format!("{home}/.nvm/versions/node"), format!("{home}/Library/Application Support/fnm/node-versions"), format!("{home}/.local/share/fnm/node-versions")] {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                candidates.push(e.path().join("bin/node"));
                candidates.push(e.path().join("installation/bin/node"));
            }
        }
    }
    for flags in ["-lc", "-ilc"] {
        let mut cmd = Command::new("/bin/zsh");
        cmd.args([flags, "command -v node"]);
        if let Some(out) = output_within(cmd, Duration::from_secs(6)) {
            if let Some(line) = out.lines().rev().map(str::trim).find(|l| l.starts_with('/')) {
                candidates.push(PathBuf::from(line));
            }
        }
    }
    let mut best: Option<(u32, PathBuf)> = None;
    for c in candidates.into_iter().filter(|c| c.exists()) {
        if let Some(major) = node_major(&c) {
            if major >= 22 && best.as_ref().map_or(true, |(m, _)| major > *m) {
                best = Some((major, c));
            }
        }
    }
    best.map(|(_, p)| p).ok_or_else(|| "Captain needs Node.js 22 or newer on this Mac to run its own server. Install it from nodejs.org, then try again.".to_string())
}

fn port_in_use() -> bool {
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], LOCAL_PORT).into(), Duration::from_millis(300)).is_ok()
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|d| d.join("server.log"))
}

fn log_tail(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(log_path(app)?).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(12);
    Some(lines[start..].join("\n")).filter(|s| !s.is_empty())
}

/// True when our server process is alive (and forgets it once it has exited).
fn child_alive(state: &LocalServer) -> bool {
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(_) => {
            *guard = None;
            false
        }
        None => false,
    }
}

fn start_local(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LocalServer>();
    if child_alive(&state) {
        return Ok(());
    }
    if port_in_use() {
        // A server from an earlier run (or Start Captain) is already answering there.
        return Ok(());
    }
    let database_url = secret_value(app, KEY_DATABASE_URL).ok_or("Add your database address first.")?;
    let app_secret = match secret_value(app, KEY_APP_SECRET) {
        Some(v) => v,
        None => {
            let v = random_hex(32)?;
            secret_store(app, KEY_APP_SECRET, Some(&v))?;
            v
        }
    };
    let node = find_node()?;
    let server_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("server");
    if !server_dir.join("dist/src/main.js").exists() {
        return Err("This copy of Captain doesn't include its server. Download the full app again.".into());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log_file = log_path(app).ok_or("No place for the log.")?;
    std::fs::create_dir_all(data_dir.join("files")).map_err(|e| e.to_string())?;
    if let Some(dir) = log_file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let log = std::fs::File::create(&log_file).map_err(|e| e.to_string())?;
    let child = Command::new(node)
        .arg("dist/src/main.js")
        .current_dir(&server_dir)
        .env("NODE_ENV", "production")
        .env("CAPTAIN_IGNORE_ENV_FILE", "1")
        .env("DATABASE_URL", database_url)
        .env("APP_SECRET", app_secret)
        .env("HOST", "127.0.0.1")
        .env("PORT", LOCAL_PORT.to_string())
        .env("PUBLIC_URL", local_url())
        .env("FILES_DIR", data_dir.join("files"))
        .env("WEB_DIST", server_dir.join("web"))
        .env("LOG_LEVEL", "info")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Couldn't start the server: {e}"))?;
    *state.child.lock().unwrap() = Some(child);
    *state.error.lock().unwrap() = None;
    Ok(())
}

fn stop_local(app: &AppHandle) {
    let state = app.state::<LocalServer>();
    let taken = state.child.lock().unwrap().take();
    if let Some(mut child) = taken {
        // Ask nicely first, so jobs and connections close cleanly.
        let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Start in the background (finding Node can take a few seconds).
fn start_local_in_background(app: &AppHandle) {
    let handle = app.clone();
    *app.state::<LocalServer>().starting.lock().unwrap() = true;
    std::thread::spawn(move || {
        let result = start_local(&handle);
        let state = handle.state::<LocalServer>();
        *state.error.lock().unwrap() = result.err();
        *state.starting.lock().unwrap() = false;
    });
}

#[tauri::command]
fn local_server_status(app: AppHandle) -> LocalServerStatus {
    let state = app.state::<LocalServer>();
    let alive = child_alive(&state);
    let running = alive || port_in_use();
    let starting = *state.starting.lock().unwrap();
    let mut error = state.error.lock().unwrap().clone();
    // The process ended on its own: say why.
    let log = if !running && !starting { log_tail(&app) } else { None };
    if error.is_none() && !running && !starting && log.is_some() {
        error = Some("The server stopped.".into());
    }
    LocalServerStatus { configured: secret_value(&app, KEY_DATABASE_URL).is_some(), running, starting, url: local_url(), error, log }
}

/// Save the database address (and, from a pasted .env, its APP_SECRET) and start.
#[tauri::command]
fn local_server_setup(app: AppHandle, database_url: String, app_secret: Option<String>) -> Result<(), String> {
    let url = database_url.trim();
    if !(url.starts_with("postgres://") || url.starts_with("postgresql://")) {
        return Err("That doesn't look like a database address. It starts with postgresql://".into());
    }
    if url.contains("[YOUR-PASSWORD]") {
        return Err("Put your database password in place of [YOUR-PASSWORD] first.".into());
    }
    secret_store(&app, KEY_DATABASE_URL, Some(url))?;
    if let Some(secret) = app_secret.map(|s| s.trim().to_string()).filter(|s| s.len() >= 32) {
        secret_store(&app, KEY_APP_SECRET, Some(&secret))?;
    }
    stop_local(&app);
    start_local_in_background(&app);
    Ok(())
}

// ------------------------------------------------------------ settings from a server you already ran
//
// If you ran the Captain server yourself before (its .env in a cutecaptain or
// captain-desktop folder), the app can use the same Supabase database and APP_SECRET (so model
// keys saved there still work) with one click. Only the project's name goes to
// the page; the address and secret stay here.

fn env_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(home) = app.path().home_dir() else {
        return vec![];
    };
    // The repo was called captain-desktop until Nov 3, 2026; clones made before
    // then keep that folder name.
    let folders = ["", "Documents/", "Developer/", "Projects/", "code/", "Documents/GitHub/", "GitHub/"];
    ["cutecaptain", "captain-desktop"]
        .iter()
        .flat_map(|name| folders.iter().map(move |folder| format!("{folder}{name}")))
        .map(|dir| home.join(dir).join("server").join(".env"))
        .collect()
}

/// DATABASE_URL and APP_SECRET from a .env's text.
fn parse_env(text: &str) -> (Option<String>, Option<String>) {
    let value = |name: &str| {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.starts_with('#'))
            .find_map(|l| l.strip_prefix(name)?.trim_start().strip_prefix('=').map(str::trim))
            .map(|v| v.trim_matches('"').trim_matches('\'').to_string())
            .filter(|v| !v.is_empty())
    };
    (value("DATABASE_URL"), value("APP_SECRET"))
}

/// The Supabase project in a database address, for showing which one.
fn project_label(url: &str) -> String {
    let user = url.split("://").nth(1).and_then(|r| r.split(':').next()).unwrap_or("");
    if let Some(project) = user.strip_prefix("postgres.") {
        return project.to_string();
    }
    let host = url.rsplit('@').next().and_then(|h| h.split([':', '/']).next()).unwrap_or("");
    host.strip_prefix("db.").and_then(|h| h.strip_suffix(".supabase.co")).unwrap_or(host).to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundSettings {
    path: String,  // where it is, for showing ("~/Documents/cutecaptain/server/.env")
    project: String,
    keeps_keys: bool, // has an APP_SECRET, so model keys saved by that server still work
}

#[tauri::command]
fn local_server_found(app: AppHandle) -> Vec<FoundSettings> {
    let home = app.path().home_dir().ok();
    env_candidates(&app)
        .into_iter()
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let (url, secret) = parse_env(&text);
            let url = url.filter(|u| (u.starts_with("postgres://") || u.starts_with("postgresql://")) && !u.contains("[YOUR-PASSWORD]"))?;
            let shown = match &home {
                Some(h) => p.strip_prefix(h).map(|r| format!("~/{}", r.display())).unwrap_or_else(|_| p.display().to_string()),
                None => p.display().to_string(),
            };
            Some(FoundSettings { path: shown, project: project_label(&url), keeps_keys: secret.map(|s| s.len() >= 32).unwrap_or(false) })
        })
        .collect()
}

/// Use the database (and APP_SECRET) from one of the places local_server_found looked.
#[tauri::command]
fn local_server_use_found(app: AppHandle, path: String) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let wanted = path.strip_prefix("~/").map(|r| home.join(r)).unwrap_or_else(|| PathBuf::from(&path));
    let file = env_candidates(&app).into_iter().find(|p| *p == wanted).ok_or("Captain only reads the server settings it found.")?;
    let text = std::fs::read_to_string(&file).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let (url, secret) = parse_env(&text);
    let url = url.ok_or("That file has no DATABASE_URL.")?;
    local_server_setup(app, url, secret)
}

#[tauri::command]
fn local_server_start(app: AppHandle) {
    start_local_in_background(&app);
}

#[tauri::command]
fn local_server_restart(app: AppHandle) {
    stop_local(&app);
    start_local_in_background(&app);
}

#[tauri::command]
fn local_server_stop(app: AppHandle) {
    stop_local(&app);
}

/// Forget the database address (the secret stays, so saved keys still work).
#[tauri::command]
fn local_server_forget(app: AppHandle) -> Result<(), String> {
    stop_local(&app);
    secret_store(&app, KEY_DATABASE_URL, None)
}

// ------------------------------------------------------------ settings

/// What the person set on this Mac, kept in the app's config folder.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    panel_shortcut: String,
    talk_shortcut: String,
    /// Whether the person picked these keys themselves. Keys they didn't pick
    /// follow the app's defaults, which can change between versions. Missing
    /// in settings saved before this existed (see `load_settings`).
    panel_custom: Option<bool>,
    talk_custom: Option<bool>,
    orb_visible: bool,
    orb_position: Option<(i32, i32)>,
}

const PANEL_SHORTCUT: &str = "Control+Shift+C";
const TALK_SHORTCUT: &str = "Control+Shift+Space";
/// The panel's default before Oct 29 (⌘⇧Space is Lock In's).
const OLD_PANEL_SHORTCUT: &str = "Command+Shift+Space";
/// The panel's default when the talk shortcut already uses ⌃⇧C.
const PANEL_FALLBACK: &str = "Control+Alt+C";

/// Whether two shortcut texts mean the same keys ("Control+Shift+C" and
/// "Control+Shift+KeyC" do).
fn same_keys(a: &str, b: &str) -> bool {
    match (Shortcut::from_str(a), Shortcut::from_str(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.eq_ignore_ascii_case(b),
    }
}

impl Default for Settings {
    fn default() -> Self {
        // macOS 15 refuses global shortcuts made only of ⌥ (or ⌥⇧) and a key,
        // so these use ⌃. (⌘⇧Space is taken by other menu bar apps.)
        Self {
            panel_shortcut: PANEL_SHORTCUT.into(),
            talk_shortcut: TALK_SHORTCUT.into(),
            // Missing from older settings files; worked out in settle_shortcuts.
            panel_custom: None,
            talk_custom: None,
            orb_visible: true,
            orb_position: None,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let settings: Settings = settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    settle_shortcuts(settings)
}

fn settle_shortcuts(mut settings: Settings) -> Settings {
    // Settings from before the flags existed: keys that differ from the old
    // defaults were picked by the person, and stay.
    let panel_custom = settings
        .panel_custom
        .unwrap_or_else(|| !same_keys(&settings.panel_shortcut, OLD_PANEL_SHORTCUT) && !same_keys(&settings.panel_shortcut, PANEL_SHORTCUT));
    let talk_custom = settings.talk_custom.unwrap_or_else(|| !same_keys(&settings.talk_shortcut, TALK_SHORTCUT));
    settings.panel_custom = Some(panel_custom);
    settings.talk_custom = Some(talk_custom);
    // Keys nobody picked follow the current defaults.
    if !talk_custom {
        settings.talk_shortcut = TALK_SHORTCUT.into();
    }
    if !panel_custom {
        settings.panel_shortcut = if same_keys(&settings.talk_shortcut, PANEL_SHORTCUT) { PANEL_FALLBACK.into() } else { PANEL_SHORTCUT.into() };
    }
    settings
}

fn save_settings(app: &AppHandle) {
    let settings = app.state::<Mutex<Settings>>().lock().unwrap().clone();
    if let Some(path) = settings_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&settings) {
            let _ = std::fs::write(path, text);
        }
    }
}

// ------------------------------------------------------------ shortcuts
//
// Two global shortcuts: one opens the panel to write; the other talks to
// Captain (hold to talk, tap to start and tap again to send). Both can be
// changed in Settings; if macOS refuses one, Settings says so.

#[derive(Default)]
struct Keys {
    panel: Mutex<Option<Shortcut>>,
    talk: Mutex<Option<Shortcut>>,
    /// Esc, held only while the floating Captain listens or speaks.
    escape: Mutex<Option<Shortcut>>,
    status: Mutex<std::collections::HashMap<String, ShortcutStatus>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutStatus {
    keys: String,
    ok: bool,
    error: Option<String>,
}

fn key_slot<'a>(keys: &'a Keys, kind: &str) -> &'a Mutex<Option<Shortcut>> {
    if kind == "talk" {
        &keys.talk
    } else {
        &keys.panel
    }
}

/// Register `text` for `kind` ("panel" or "talk"). The old shortcut stays
/// until the new one is registered, so a refused one changes nothing.
fn apply_shortcut(app: &AppHandle, kind: &str, text: &str) -> ShortcutStatus {
    let keys = app.state::<Keys>();
    let status = match Shortcut::from_str(text) {
        Err(_) => ShortcutStatus { keys: text.into(), ok: false, error: Some("That isn't a shortcut Captain understands.".into()) },
        Ok(shortcut) => {
            let current = *key_slot(&keys, kind).lock().unwrap();
            let other = *key_slot(&keys, if kind == "talk" { "panel" } else { "talk" }).lock().unwrap();
            if current == Some(shortcut) {
                ShortcutStatus { keys: text.into(), ok: true, error: None }
            } else if other == Some(shortcut) {
                ShortcutStatus { keys: text.into(), ok: false, error: Some("The other Captain shortcut already uses those keys.".into()) }
            } else {
                match app.global_shortcut().register(shortcut) {
                    Ok(()) => {
                        if let Some(old) = current {
                            let _ = app.global_shortcut().unregister(old);
                        }
                        *key_slot(&keys, kind).lock().unwrap() = Some(shortcut);
                        ShortcutStatus { keys: text.into(), ok: true, error: None }
                    }
                    Err(_) => ShortcutStatus {
                        keys: text.into(),
                        ok: false,
                        error: Some("macOS didn't allow it. Another app may use these keys, or they use only ⌥ (macOS 15 needs ⌘ or ⌃ too).".into()),
                    },
                }
            }
        }
    };
    keys.status.lock().unwrap().insert(kind.into(), status.clone());
    status
}

#[derive(Serialize)]
struct ShortcutsInfo {
    panel: ShortcutStatus,
    talk: ShortcutStatus,
}

#[tauri::command]
fn shortcuts_get(app: AppHandle) -> ShortcutsInfo {
    let keys = app.state::<Keys>();
    let status = keys.status.lock().unwrap();
    let settings = app.state::<Mutex<Settings>>().lock().unwrap().clone();
    let get = |kind: &str, fallback: &str| status.get(kind).cloned().unwrap_or(ShortcutStatus { keys: fallback.into(), ok: false, error: None });
    ShortcutsInfo { panel: get("panel", &settings.panel_shortcut), talk: get("talk", &settings.talk_shortcut) }
}

#[tauri::command]
fn shortcut_set(app: AppHandle, kind: String, keys: String) -> ShortcutStatus {
    let kind = if kind == "talk" { "talk" } else { "panel" };
    let status = apply_shortcut(&app, kind, &keys);
    if status.ok {
        {
            let mut settings = app.state::<Mutex<Settings>>().inner().lock().unwrap();
            if kind == "talk" {
                settings.talk_custom = Some(!same_keys(&keys, TALK_SHORTCUT));
                settings.talk_shortcut = keys;
            } else {
                settings.panel_custom = Some(!same_keys(&keys, PANEL_SHORTCUT));
                settings.panel_shortcut = keys;
            }
        }
        save_settings(&app);
    }
    status
}

/// While the floating Captain listens or speaks, Esc (in any app) cancels.
#[tauri::command]
fn orb_escape(app: AppHandle, active: bool) {
    let keys = app.state::<Keys>();
    let mut slot = keys.escape.lock().unwrap();
    if active {
        if slot.is_none() {
            if let Ok(shortcut) = Shortcut::from_str("Escape") {
                if app.global_shortcut().register(shortcut).is_ok() {
                    *slot = Some(shortcut);
                }
            }
        }
    } else if let Some(shortcut) = slot.take() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

/// The talk shortcut went down or up: the floating button handles it (hold
/// to talk, or tap to start and tap again to send).
fn talk_key(app: &AppHandle, pressed: bool) {
    if let Some(orb) = app.get_webview_window("orb") {
        if pressed {
            let _ = orb.show();
        }
        let _ = orb.emit("talk-key", pressed);
    }
}

// ------------------------------------------------------------ voice
//
// The captain-voice helper (voice/main.swift) sits next to the app's
// executable. Listening streams its lines to the windows as "voice" events,
// tagged with who asked; speaking sends "speech" events.

#[derive(Default)]
struct Voice {
    listening: Mutex<Option<(Child, Option<ChildStdin>, String)>>,
    speaking: Mutex<Option<Child>>,
}

fn voice_helper() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let helper = exe.parent().ok_or("No app folder.")?.join("captain-voice");
    match std::fs::metadata(&helper) {
        Ok(m) if m.len() > 0 => Ok(helper),
        _ => Err("Voice isn't available in this copy of Captain.".into()),
    }
}

#[tauri::command]
fn voice_start(app: AppHandle, lang: String, owner: String) -> Result<(), String> {
    speak_stop(app.clone());
    let voice = app.state::<Voice>();
    let mut slot = voice.listening.lock().unwrap();
    if let Some((child, _, _)) = slot.as_mut() {
        if let Ok(None) = child.try_wait() {
            return Err("Captain is already listening.".into());
        }
    }
    let lang = if lang == "zh-CN" { "zh-CN" } else { "en-US" };
    let mut child = Command::new(voice_helper()?)
        .args(["listen", lang])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start voice: {e}"))?;
    let stdout = child.stdout.take().ok_or("No output from voice.")?;
    let stdin = child.stdin.take();
    let pid = child.id();
    *slot = Some((child, stdin, owner.clone()));
    drop(slot);

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line) {
                value["owner"] = serde_json::Value::String(owner.clone());
                let _ = handle.emit("voice", value);
            }
        }
        let voice = handle.state::<Voice>();
        let mut slot = voice.listening.lock().unwrap();
        if slot.as_ref().map(|(c, _, _)| c.id()) == Some(pid) {
            if let Some((mut child, _, _)) = slot.take() {
                let _ = child.wait();
            }
        }
        let _ = handle.emit("voice", serde_json::json!({"type": "end", "owner": owner}));
    });
    Ok(())
}

/// Finish listening: the helper sends what it heard, then ends.
#[tauri::command]
fn voice_stop(app: AppHandle) {
    let voice = app.state::<Voice>();
    let mut slot = voice.listening.lock().unwrap();
    if let Some((_, stdin, _)) = slot.as_mut() {
        if let Some(mut input) = stdin.take() {
            let _ = input.write_all(b"stop\n");
        }
    }
}

#[tauri::command]
fn voice_cancel(app: AppHandle) {
    let voice = app.state::<Voice>();
    let taken = voice.listening.lock().unwrap().take();
    if let Some((mut child, _, _)) = taken {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
fn speak(app: AppHandle, text: String, lang: String) -> Result<(), String> {
    speak_stop(app.clone());
    let lang = if lang == "zh-CN" { "zh-CN" } else { "en-US" };
    let mut child = Command::new(voice_helper()?)
        .args(["speak", lang])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start speaking: {e}"))?;
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(text.as_bytes());
    }
    let pid = child.id();
    *app.state::<Voice>().speaking.lock().unwrap() = Some(child);
    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(150));
            let voice = handle.state::<Voice>();
            let mut slot = voice.speaking.lock().unwrap();
            match slot.as_mut() {
                Some(child) if child.id() == pid => {
                    if let Ok(Some(_)) = child.try_wait() {
                        *slot = None;
                        break;
                    }
                }
                _ => break, // stopped, or replaced by newer speech
            }
        }
        let _ = handle.emit("speech", serde_json::json!({"type": "done"}));
    });
    Ok(())
}

#[tauri::command]
fn speak_stop(app: AppHandle) {
    let taken = app.state::<Voice>().speaking.lock().unwrap().take();
    if let Some(mut child) = taken {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ------------------------------------------------------------ voice typing
//
// "Type into <app>" on the talk card: the helper finds the app in front of
// Captain, and later pastes what was said there (with Accessibility permission).

#[derive(Serialize)]
struct FrontAppInfo {
    name: String,
    pid: i32,
}

// Only the floating Captain's own window can type into other apps.
fn from_orb(window: &WebviewWindow) -> bool {
    window.label() == "orb"
}

#[tauri::command]
async fn front_app(window: WebviewWindow) -> Option<FrontAppInfo> {
    if !from_orb(&window) {
        return None;
    }
    let out = Command::new(voice_helper().ok()?).arg("frontapp").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let value: serde_json::Value = serde_json::from_str(text.lines().last()?.trim()).ok()?;
    if value["type"] != "app" {
        return None;
    }
    Some(FrontAppInfo { name: value["name"].as_str()?.to_string(), pid: value["pid"].as_i64()? as i32 })
}

#[tauri::command]
async fn type_text(window: WebviewWindow, pid: i32, text: String) -> Result<(), String> {
    if !from_orb(&window) {
        return Err("Only the floating Captain can type into other apps.".into());
    }
    if pid <= 0 {
        return Err("There's no app to type into.".into());
    }
    let mut child = Command::new(voice_helper()?)
        .args(["paste", &pid.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't type it: {e}"))?;
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(text.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value["type"] == "error" {
                return Err(value["message"].as_str().unwrap_or("Couldn't type it.").to_string());
            }
        }
    }
    if out.status.success() {
        Ok(())
    } else {
        Err("Couldn't type it.".into())
    }
}

// ------------------------------------------------------------ floating talk button

fn orb(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("orb")
}

/// Bottom right of the main screen, unless it was moved before.
fn place_orb(app: &AppHandle, window: &WebviewWindow) {
    let saved = app.state::<Mutex<Settings>>().lock().unwrap().orb_position;
    if let Some((x, y)) = saved {
        let _ = window.set_position(PhysicalPosition::new(x, y));
        return;
    }
    if let Ok(Some(m)) = window.primary_monitor() {
        let scale = m.scale_factor();
        let size = window.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((76.0 * scale, 76.0 * scale));
        let x = m.position().x as f64 + m.size().width as f64 - size.0 - 28.0 * scale;
        let y = m.position().y as f64 + m.size().height as f64 - size.1 - 110.0 * scale;
        let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

fn set_orb_visible(app: &AppHandle, visible: bool) {
    if let Some(window) = orb(app) {
        let _ = if visible { window.show() } else { window.hide() };
    }
    app.state::<Mutex<Settings>>().lock().unwrap().orb_visible = visible;
    save_settings(app);
}

#[tauri::command]
fn orb_set_visible(app: AppHandle, visible: bool) {
    set_orb_visible(&app, visible);
}

#[tauri::command]
fn orb_get_visible(app: AppHandle) -> bool {
    app.state::<Mutex<Settings>>().lock().unwrap().orb_visible
}

/// The button's right-click menu.
#[tauri::command]
fn orb_menu(app: AppHandle, window: WebviewWindow, muted: bool, lang: String) -> Result<(), String> {
    let item = |id: &str, label: &str| MenuItem::with_id(&app, id, label, true, None::<&str>).map_err(|e| e.to_string());
    let menu = Menu::with_items(
        &app,
        &[
            &item("orb-write", "Write to a chat…")?,
            &item("orb-open", "Open Captain")?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &item("orb-lang", if lang == "zh-CN" { "Listen in English" } else { "Listen in Chinese (中文)" })?,
            &item("orb-mute", if muted { "Speak answers out loud" } else { "Don't speak answers" })?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &item("orb-hide", "Hide this button")?,
        ],
    )
    .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Remember where the Captain was left (after it's dragged). The window grows
/// with its cards, so the page says where it sits at its smallest.
#[tauri::command]
fn orb_moved(app: AppHandle, window: WebviewWindow, x: Option<i32>, y: Option<i32>) {
    let position = match (x, y) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => window.outer_position().ok().map(|p| (p.x, p.y)),
    };
    if let Some(p) = position {
        app.state::<Mutex<Settings>>().lock().unwrap().orb_position = Some(p);
        save_settings(&app);
    }
}

fn on_app_menu(app: &AppHandle, id: &str) {
    match id {
        "orb-write" => open_panel(app, PanelTarget::mode("compose")),
        "orb-open" => show_dashboard(app),
        "orb-hide" => set_orb_visible(app, false),
        "orb-lang" | "orb-mute" => {
            if let Some(window) = orb(app) {
                let _ = window.emit("orb-menu", id);
            }
        }
        _ => {}
    }
}

// ------------------------------------------------------------ app

// ------------------------------------------------------------ the rename

// The app was called Captain, with the identifier ai.captainspace.desktop, until
// Nov 3, 2026. macOS keeps an app's files in folders named after its identifier
// (the session and the built-in server's settings in Application Support, the
// server's log in Logs, the web view's storage in WebKit), so on the first start
// after the rename, move the old folders to the new names. A folder is only
// moved when the new one doesn't exist yet, so this runs once and never
// overwrites anything.
const OLD_IDENTIFIER: &str = "ai.captainspace.desktop";

fn adopt_old_folders(app: &AppHandle) {
    let resolver = app.path();
    let mut dirs: Vec<PathBuf> = [
        resolver.app_config_dir(),
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Ok(home) = resolver.home_dir() {
        dirs.push(home.join("Library/WebKit").join(&app.config().identifier));
    }
    for dir in dirs {
        let Some(parent) = dir.parent() else { continue };
        let old = parent.join(OLD_IDENTIFIER);
        if dir == old || dir.exists() || !old.is_dir() {
            continue;
        }
        let _ = std::fs::rename(&old, &dir);
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(LocalServer::default())
        .manage(Keys::default())
        .manage(Voice::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, pressed, event| {
                    let keys = app.state::<Keys>();
                    let is_panel = *keys.panel.lock().unwrap() == Some(*pressed);
                    let is_talk = *keys.talk.lock().unwrap() == Some(*pressed);
                    let is_escape = *keys.escape.lock().unwrap() == Some(*pressed);
                    if is_escape {
                        if event.state() == ShortcutState::Pressed {
                            if let Some(window) = orb(app) {
                                let _ = window.emit("orb-escape", ());
                            }
                        }
                    } else if is_panel && event.state() == ShortcutState::Pressed {
                        toggle_panel(app, PanelTarget::mode("compose"));
                    } else if is_talk {
                        talk_key(app, event.state() == ShortcutState::Pressed);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            show_panel,
            hide_panel,
            open_dashboard,
            set_badge,
            notify,
            capture_screen,
            secret_get,
            secret_set,
            secret_delete,
            local_server_status,
            local_server_setup,
            local_server_start,
            local_server_restart,
            local_server_stop,
            local_server_forget,
            local_server_found,
            local_server_use_found,
            shortcuts_get,
            shortcut_set,
            chrome_extension_reveal,
            open_url,
            voice_start,
            voice_stop,
            voice_cancel,
            speak,
            speak_stop,
            orb_menu,
            orb_moved,
            orb_escape,
            front_app,
            type_text,
            orb_set_visible,
            orb_get_visible,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Before anything reads its settings: bring them over from the old name.
            adopt_old_folders(&handle);

            // Start the built-in server if it's been set up.
            if secret_value(&handle, KEY_DATABASE_URL).is_some() {
                start_local_in_background(&handle);
            }

            // Settings, and the two shortcuts (panel; talk).
            let settings = load_settings(&handle);
            app.manage(Mutex::new(settings.clone()));
            apply_shortcut(&handle, "panel", &settings.panel_shortcut);
            apply_shortcut(&handle, "talk", &settings.talk_shortcut);

            // The floating talk button.
            if let Some(window) = orb(&handle) {
                // Never leave Esc taken if the button's page goes away.
                let app_for_orb = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Destroyed = event {
                        orb_escape(app_for_orb.clone(), false);
                    }
                });
                place_orb(&handle, &window);
                let _ = window.set_visible_on_all_workspaces(true);
                if settings.orb_visible {
                    let _ = window.show();
                }
            }
            app.on_menu_event(|app, event| on_app_menu(app, event.id.as_ref()));

            // The menu bar icon: click for the inbox, right-click for a menu.
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "write", "New message", true, None::<&str>)?,
                    &MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?,
                    &MenuItem::with_id(app, "open", "Open cutecaptain", true, None::<&str>)?,
                    &MenuItem::with_id(app, "setup", "Get started…", true, None::<&str>)?,
                    &MenuItem::with_id(app, "orb-show", "Show the little Captain", true, None::<&str>)?,
                    &MenuItem::with_id(app, "restart-server", "Restart Captain on this Mac", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Quit cutecaptain", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?)
                .icon_as_template(true)
                .tooltip("cutecaptain")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "write" => open_panel(app, PanelTarget::mode("compose")),
                    "inbox" => open_panel(app, PanelTarget::mode("inbox")),
                    "open" => show_dashboard(app),
                    "setup" => {
                        show_dashboard(app);
                        let _ = app.emit_to("main", "open-setup", ());
                    }
                    "orb-show" => set_orb_visible(app, true),
                    "restart-server" => {
                        stop_local(app);
                        start_local_in_background(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { rect, button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        let scale = panel(app).and_then(|w| w.scale_factor().ok()).unwrap_or(2.0);
                        let pos = rect.position.to_physical::<f64>(scale);
                        let size = rect.size.to_physical::<f64>(scale);
                        *app.state::<AppState>().tray_rect.lock().unwrap() = Some((pos.x, pos.y, size.width, size.height));
                        toggle_panel(app, PanelTarget::mode("inbox"));
                    }
                })
                .build(app)?;

            // The panel: frosted glass, hides when you click elsewhere.
            if let Some(window) = panel(&handle) {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Popover, Some(NSVisualEffectState::Active), Some(20.0));
                }
                let _ = window.set_visible_on_all_workspaces(true);
                let app_for_blur = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let capturing = *app_for_blur.state::<AppState>().capturing.lock().unwrap();
                        if !capturing {
                            if let Some(w) = panel(&app_for_blur) {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            // Closing the dashboard keeps Captain in the menu bar, and the
            // dashboard keeps the one live connection running while hidden.
            if let Some(main) = handle.get_webview_window("main") {
                let app_for_close = handle.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_for_close.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        #[cfg(target_os = "macos")]
                        let _ = app_for_close.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Captain")
        .run(|app, event| {
            // Clicking the Dock icon brings the dashboard back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_dashboard(app);
            }
            // Quitting Captain stops its built-in server and its voice.
            if let tauri::RunEvent::Exit = event {
                stop_local(app);
                voice_cancel(app.clone());
                speak_stop(app.clone());
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from(json: &str) -> Settings {
        settle_shortcuts(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn old_default_panel_key_moves_to_the_new_one() {
        let s = from(r#"{"panelShortcut":"Command+Shift+Space","talkShortcut":"Control+Shift+Space","orbVisible":true}"#);
        assert_eq!(s.panel_shortcut, PANEL_SHORTCUT);
        assert_eq!(s.talk_shortcut, TALK_SHORTCUT);
        assert_eq!(s.panel_custom, Some(false));
    }

    #[test]
    fn keys_someone_picked_stay_after_an_upgrade() {
        let s = from(r#"{"panelShortcut":"Control+Alt+KeyP","talkShortcut":"Control+Alt+KeyT"}"#);
        assert_eq!(s.panel_shortcut, "Control+Alt+KeyP");
        assert_eq!(s.talk_shortcut, "Control+Alt+KeyT");
        assert_eq!((s.panel_custom, s.talk_custom), (Some(true), Some(true)));
    }

    #[test]
    fn the_panel_default_steps_aside_when_talk_uses_its_keys() {
        let s = from(r#"{"panelShortcut":"Command+Shift+Space","talkShortcut":"Control+Shift+KeyC"}"#);
        assert_eq!(s.talk_shortcut, "Control+Shift+KeyC");
        assert_eq!(s.panel_shortcut, PANEL_FALLBACK);
    }

    #[test]
    fn reads_a_server_env() {
        let text = "# Captain\nDATABASE_URL=\"postgresql://postgres.abcxyz:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres\"\nAPP_SECRET = 0123456789abcdef0123456789abcdef\nPORT=8787\n";
        let (url, secret) = parse_env(text);
        assert_eq!(url.as_deref(), Some("postgresql://postgres.abcxyz:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres"));
        assert_eq!(secret.as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(project_label(url.as_deref().unwrap()), "abcxyz");
        assert_eq!(project_label("postgresql://postgres:pw@db.qwerty.supabase.co:5432/postgres"), "qwerty");
        assert_eq!(parse_env("# DATABASE_URL=nope\n").0, None);
    }

    #[test]
    fn a_fresh_install_uses_the_defaults() {
        let s = from("{}");
        assert_eq!((s.panel_shortcut.as_str(), s.talk_shortcut.as_str()), (PANEL_SHORTCUT, TALK_SHORTCUT));
    }
}
