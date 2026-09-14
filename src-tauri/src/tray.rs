//! System tray: keeps the app reachable while the main window is tucked away, and carries a
//! right-click menu of the settings worth changing without opening the window.
//!
//! All labels come from the frontend, which already owns the zh/en dictionary — the tray is
//! rebuilt from scratch on every state change rather than mutating item handles, which is
//! both shorter and immune to the menu and the UI drifting apart.

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const TRAY_ID: &str = "main";
/// Menu clicks that are not `show`/`quit` are forwarded here for the UI to act on.
pub const ACTION_EVENT: &str = "tray://action";

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
    /// Already resolved to "Start" or "Stop" by the caller.
    pub run_label: String,
    pub overlay_label: String,
    pub overlay_on: bool,
    pub click_through_label: String,
    pub click_through_on: bool,
    pub mode_label: String,
    pub modes: Vec<TrayMode>,
    pub quit_label: String,
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn menu(app: &AppHandle, s: &TrayState) -> tauri::Result<Menu<Wry>> {
    let show = MenuItem::with_id(app, "show", &s.show_label, true, None::<&str>)?;
    let run = MenuItem::with_id(app, "run", &s.run_label, true, None::<&str>)?;
    let overlay = CheckMenuItem::with_id(
        app, "overlay", &s.overlay_label, true, s.overlay_on, None::<&str>,
    )?;
    let click_through = CheckMenuItem::with_id(
        app, "click-through", &s.click_through_label, true, s.click_through_on, None::<&str>,
    )?;

    let mode_items = s
        .modes
        .iter()
        .map(|m| {
            CheckMenuItem::with_id(app, format!("mode:{}", m.id), &m.label, true, m.on, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let mode_refs: Vec<&dyn IsMenuItem<Wry>> =
        mode_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let modes = Submenu::with_items(app, &s.mode_label, true, &mode_refs)?;

    let quit = MenuItem::with_id(app, "quit", &s.quit_label, true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &run,
            &overlay,
            &click_through,
            &modes,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Create the tray once, at startup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("ReaLingo")
        // Left click belongs to "open the window"; the menu is right-click only.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            id => {
                let _ = app.emit(ACTION_EVENT, id);
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the menu to match the current UI state. Called whenever that state changes.
#[tauri::command]
pub fn sync_tray(app: AppHandle, menu_state: TrayState) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon is not available".to_string())?;
    let menu = menu(&app, &menu_state).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(&menu_state.tooltip)).map_err(|e| e.to_string())?;
    Ok(())
}
