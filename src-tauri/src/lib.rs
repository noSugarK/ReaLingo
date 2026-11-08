mod audio;
#[cfg(any(target_os = "android", test))]
mod android_audio;
pub mod config;
pub mod decode;
mod history;
mod player;
pub mod realtime;
// PulseAudio monitoring forks pactl/parec on desktop Linux; Android uses AAudio.
#[cfg(all(target_os = "linux", not(target_os = "android")))]
pub mod pulse;
pub mod resample;
pub mod volc;
mod secret;
#[cfg(target_os = "macos")]
mod tap;
// Tray icons are a desktop concept. Mobile gets the same command surface backed by
// no-ops, so the frontend can keep calling sync_tray without a platform check.
#[cfg(not(target_os = "android"))]
mod tray;
#[cfg(target_os = "android")]
#[path = "tray_stub.rs"]
mod tray;
#[cfg(windows)]
mod wasapi;

use audio::DeviceInfo;
use config::{Protocol, Settings};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct AppState {
    running: Mutex<Option<Arc<AtomicBool>>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    level: Arc<AtomicU32>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Device { id: String },
    File { path: String },
}

#[tauri::command]
fn list_devices() -> Vec<DeviceInfo> {
    audio::list_devices()
}

/// What the host platform can and cannot do, so the UI can say why a list is empty.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub os: &'static str,
    pub loopback: bool,
    /// False on a Linux box with no Secret Service provider: the key then stays in
    /// settings.json, and the settings page says so.
    pub keyring: bool,
}

#[tauri::command]
fn platform() -> Platform {
    Platform {
        os: std::env::consts::OS,
        loopback: audio::loopback_supported(),
        keyring: secret::available(),
    }
}

#[tauri::command]
fn get_api_key(protocol: Protocol) -> String {
    secret::get(protocol).unwrap_or_default()
}

#[tauri::command]
fn set_api_key(protocol: Protocol, key: String) -> Result<(), String> {
    secret::set(protocol, &key)
}

#[tauri::command]
fn default_device(loopback: bool) -> Option<String> {
    audio::default_device_id(loopback)
}

#[tauri::command]
fn input_level(state: State<AppState>) -> f32 {
    audio::read_level(&state.level)
}

#[tauri::command]
async fn probe_audio(state: State<'_, AppState>, id: String) -> Result<usize, String> {
    if state.running.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|s| !s.load(Ordering::Relaxed)) {
        return Err("stop the current session before testing the microphone".into());
    }
    audio::probe(id).await.map_err(|e| e.to_string())
}

/// Shown read-only in Settings so it is obvious which host the app will dial.
#[tauri::command]
fn endpoint_url(settings: Settings) -> String {
    settings.ws_url()
}

#[tauri::command]
async fn start_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: Settings,
    source: Source,
) -> Result<(), String> {
    halt(&state);

    // The credential store wins over whatever the webview sent, so on a machine that has
    // one the key never has to travel through the frontend at all.
    if let Some(key) = secret::get(settings.protocol) {
        *settings.key_mut() = key;
    }

    let stop = Arc::new(AtomicBool::new(false));
    *state.running.lock().unwrap() = Some(stop.clone());
    let (capture_app, capture_settings, capture_stop, level) = (app.clone(), settings.clone(), stop.clone(), state.level.clone());
    // Opening an Android/desktop device may block in its driver. Keep the IPC/UI
    // thread free, and retain the stop flag before that work starts.
    let startup = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let (app, settings, stop) = (capture_app, capture_settings, capture_stop);
        // Before capture: on macOS the process has to be a Core Audio client already for the
        // capture to be able to exclude it.
        let player = if settings.speak {
            Some(player::Player::start().map_err(|e| e.to_string())?)
        } else {
            None
        };

        // ~6 s of audio in flight; enough to ride out a slow handshake, small enough that a
        // wedged uplink shows up as dropped audio rather than unbounded memory.
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);

        match source {
            Source::Device { id } => {
                // Only needed when we make sound ourselves; otherwise the plain loopback path.
                audio::start(&id, settings.sample_rate(), tx, level, stop.clone(), settings.speak)
                    .map_err(|e| e.to_string())?;
            }
            Source::File { path } => {
                let path = PathBuf::from(path);
                if !path.is_file() {
                    return Err(format!("file not found: {}", path.display()));
                }
                let (app2, stop2, rate) = (app.clone(), stop.clone(), settings.sample_rate());
                tauri::async_runtime::spawn_blocking(move || {
                    let result = decode::stream_file(&path, rate, tx, stop2, |sent, total| {
                        let text = match total {
                            Some(t) => format!("{sent:.1}/{t:.1}"),
                            None => format!("{sent:.1}/?"),
                        };
                        realtime::note(&app2, "progress", text);
                    });
                    match result {
                        Ok(()) => realtime::note(&app2, "progress", "done"),
                        Err(e) => realtime::note(&app2, "error", e.to_string()),
                    }
                    // `tx` drops here, which is the end of input: the session finishes and
                    // waits for the last sentence on its own.
                });
            }
        }

        Ok((rx, player))
    });
    let result = tokio::select! {
        _ = realtime::stopped(&stop) => {
            if state.running.lock().unwrap().as_ref().is_some_and(|active| Arc::ptr_eq(active, &stop)) {
                realtime::note(&app, "status", "closed");
            }
            return Ok(());
        }
        result = startup => result.map_err(|error| error.to_string()).and_then(|result| result),
    };
    let (rx, player) = match result {
        Ok(capture) => capture,
        Err(error) => { stop.store(true, Ordering::Relaxed); return Err(error); }
    };
    if stop.load(Ordering::Relaxed) { realtime::note(&app, "status", "closed"); return Ok(()); }
    *state.task.lock().unwrap() = Some(tauri::async_runtime::spawn(realtime::run(app, settings, rx, stop, player)));
    Ok(())
}

/// Writes a transcript export. The path comes from the user's own save dialog, so there is
/// no scope to police here beyond what the OS already enforces.
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_stream(state: State<AppState>) {
    request_stop(&state);
}

fn request_stop(state: &State<AppState>) {
    if let Some(stop) = state.running.lock().unwrap().as_ref() {
        stop.store(true, Ordering::Relaxed);
    }
    state.level.store(0f32.to_bits(), Ordering::Relaxed);
}

fn halt(state: &State<AppState>) {
    request_stop(state);
    state.running.lock().unwrap().take();
    if let Some(task) = state.task.lock().unwrap().take() { task.abort(); }
}

/* ---------- phone shell ---------- */
// The permission/status/device-name/picker surface lives in the Kotlin bridge
// (src-tauri/android/MainActivity.kt, window.ReaLingoAndroid), not here: Tauri's
// AppHandle has no stable Activity accessor for the JNI round, and the bridge is how
// LittleLobby ships the same features. src/mobile/perms.ts calls the bridge directly.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer produces nothing on software GL (VMs) and on some
    // proprietary drivers: the window is created and focused but never painted, which with
    // `transparent: true` looks like the app failed to start. Losing the DMA-BUF path costs
    // a buffer copy; losing the whole UI costs the app. Respect an explicit override.
    // This workaround is specific to desktop Linux's WebKitGTK renderer.
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            // The overlay is declared in tauri.conf.json but starts hidden; the main window
            // shows it on demand. Z-order belongs to the window manager, so the call is
            // desktop-only (tauri gates it with cfg(desktop)); the mobile overlay (phase 2)
            // would use a system overlay window instead.
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("subtitle") {
                let _ = w.set_always_on_top(true);
            }
            // tauri.android.conf.json declares only main. Closing an extra mobile window
            // here is too late: the platform has already created its Activity/WebView.
            tray::init(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window must end the app. The subtitle overlay is a second
            // window with skipTaskbar set, so without this the process lingers with no way
            // to reach it: the app looks closed but the overlay is still on screen.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            platform,
            get_api_key,
            set_api_key,
            default_device,
            input_level,
            probe_audio,
            endpoint_url,
            start_stream,
            stop_stream,
            write_text,
            history::history_open,
            history::history_append,
            history::history_list,
            history::history_read,
            history::history_delete,
            history::history_clear,
            history::history_dir,
            tray::sync_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
