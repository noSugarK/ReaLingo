mod audio;
pub mod config;
pub mod decode;
mod realtime;
pub mod pulse;
pub mod resample;
mod secret;
mod tray;

use audio::DeviceInfo;
use config::Settings;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct AppState {
    running: Mutex<Option<Arc<AtomicBool>>>,
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
fn get_api_key() -> String {
    secret::get().unwrap_or_default()
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    secret::set(&key)
}

#[tauri::command]
fn default_device(loopback: bool) -> Option<String> {
    audio::default_device_id(loopback)
}

#[tauri::command]
fn input_level(state: State<AppState>) -> f32 {
    audio::read_level(&state.level)
}

/// Shown read-only in Settings so it is obvious which host the app will dial.
#[tauri::command]
fn endpoint_url(settings: Settings) -> String {
    settings.ws_url()
}

#[tauri::command]
fn start_stream(
    app: AppHandle,
    state: State<AppState>,
    mut settings: Settings,
    source: Source,
) -> Result<(), String> {
    halt(&state);

    // The credential store wins over whatever the webview sent, so on a machine that has
    // one the key never has to travel through the frontend at all.
    if let Some(key) = secret::get() {
        settings.api_key = key;
    }

    let stop = Arc::new(AtomicBool::new(false));
    // ~6 s of audio in flight; enough to ride out a slow handshake, small enough that a
    // wedged uplink shows up as dropped audio rather than unbounded memory.
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);

    match source {
        Source::Device { id } => {
            audio::start(&id, tx, state.level.clone(), stop.clone()).map_err(|e| e.to_string())?;
        }
        Source::File { path } => {
            let path = PathBuf::from(path);
            if !path.is_file() {
                return Err(format!("file not found: {}", path.display()));
            }
            let (app2, stop2) = (app.clone(), stop.clone());
            tauri::async_runtime::spawn_blocking(move || {
                let result = decode::stream_file(&path, tx, stop2.clone(), |sent, total| {
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
                // Let the last chunks land, then wind the socket down.
                std::thread::sleep(std::time::Duration::from_secs(2));
                stop2.store(true, Ordering::Relaxed);
            });
        }
    }

    *state.running.lock().unwrap() = Some(stop.clone());
    tauri::async_runtime::spawn(realtime::run(app, settings, rx, stop));
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
    halt(&state);
}

fn halt(state: &State<AppState>) {
    if let Some(stop) = state.running.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
    state.level.store(0f32.to_bits(), Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer produces nothing on software GL (VMs) and on some
    // proprietary drivers: the window is created and focused but never painted, which with
    // `transparent: true` looks like the app failed to start. Losing the DMA-BUF path costs
    // a buffer copy; losing the whole UI costs the app. Respect an explicit override.
    #[cfg(target_os = "linux")]
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
            // shows it on demand.
            if let Some(w) = app.get_webview_window("subtitle") {
                let _ = w.set_always_on_top(true);
            }
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
            endpoint_url,
            start_stream,
            stop_stream,
            write_text,
            tray::sync_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
