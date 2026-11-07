//! Android build of the tray surface: same names, same command signature, no system tray.
//!
//! The frontend calls `sync_tray` on every state change to rebuild the menu; there is no
//! menu to rebuild here, so the command accepts the same payload and drops it. Keeping the
//! interface identical means no `cfg` branches reach the Vue side.

// Field-for-field identical to tray.rs's payload types: the wire format must match even
// though nothing here reads the fields, and Debug/unused warnings are noise by design.
#![allow(dead_code)]

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMode {
    pub id: String,
    pub label: String,
    pub on: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub tooltip: String,
    pub show_label: String,
    pub run_label: String,
    pub overlay_label: String,
    pub overlay_on: bool,
    pub click_through_label: String,
    pub click_through_on: bool,
    pub mode_label: String,
    pub modes: Vec<TrayMode>,
    pub quit_label: String,
}

pub fn init(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn sync_tray(_app: tauri::AppHandle, _menu_state: TrayState) -> Result<(), String> {
    Ok(())
}
