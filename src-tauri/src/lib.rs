mod audio;
pub mod config;
pub mod decode;
mod realtime;
pub mod resample;

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
    settings: Settings,
    source: Source,
) -> Result<(), String> {
    halt(&state);

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            default_device,
            input_level,
            endpoint_url,
            start_stream,
            stop_stream,
            write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
