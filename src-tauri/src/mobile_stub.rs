//! Desktop stand-ins for the Android permission surface: there is no runtime-permission
//! system to query (macOS prompts on first capture through TCC, Windows through the
//! Settings app), so every question answers "already fine" and every action is a no-op.
//! Same shape as `tray_stub.rs` — the signatures mirror `mobile.rs` exactly (including the
//! AppHandle the Android side needs for main-thread hops), so `lib.rs` registers the
//! commands once and the phone shell never needs a platform check.

#![cfg(not(target_os = "android"))]

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct MicStatus {
    pub granted: bool,
    pub rationale: bool,
}

pub fn request(_app: &AppHandle, _name: String) -> Result<(), String> {
    Ok(())
}

pub fn mic_status(_app: &AppHandle) -> Result<MicStatus, String> {
    Ok(MicStatus { granted: true, rationale: false })
}

pub fn notif_enabled() -> Result<bool, String> {
    Ok(true)
}

pub fn battery_ignored() -> Result<bool, String> {
    Ok(true)
}

pub fn open_app_settings(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn open_battery_settings(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn set_keep_screen_on(_app: &AppHandle, _on: bool) -> Result<(), String> {
    Ok(())
}

pub fn wifi_ssid() -> String {
    "unknown".to_string()
}

pub fn device_model() -> String {
    std::env::consts::OS.to_string()
}
