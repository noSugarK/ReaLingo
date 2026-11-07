//! Android platform glue: the runtime permissions the phone UI has to reason about, the
//! system-settings pages it links to, and the device name a hotspot capture needs.
//!
//! Everything is behind `cfg(target_os = "android")`; on the desktop the commands are not
//! registered at all, and the frontend's `call()` wrapper treats the missing command as
//! "granted / unknown", which is exactly the desktop's real state (there is nothing to
//! grant there beyond TCC, which the OS prompts for on first capture anyway).
//!
//! JNI comes from `jni` and `ndk-context`, both already in the dependency graph via cpal's
//! AAudio backend and tauri's Android support — declaring them for the Android target adds
//! no new crates to the lockfile.
//!
//! Threading: `ndk_context::android_context()` only answers on a thread Android knows
//! about. Tauri runs commands on its tokio pool, so every entry point hops onto the main
//! thread with `run_on_main_thread` and returns through a channel. Permission *results*
//! cannot be read synchronously either: `request_permissions` resolves asynchronously, so
//! the frontend polls `perm_status` after firing the request (see src/mobile/perms.ts).

#![cfg(target_os = "android")]

use jni::objects::{JObject, JValue};
use jni::JNIEnv;
use std::sync::mpsc;

/// Class-lookup failure is a bug in this file, not user input: panic on desktop-visible
/// paths, but these functions all run inside a command whose Result the frontend swallows.
type Jum<T> = Result<T, String>;

fn with_env<R>(f: impl FnOnce(&mut JNIEnv) -> R) -> Jum<R> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    Ok(f(&mut env))
}

fn context(env: &mut JNIEnv) -> Jum<JObject> {
    Ok(unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) })
}

/// `context.getSystemService(name)` — the three services we touch all answer the same way.
fn service(env: &mut JNIEnv, name: &str) -> Jum<JObject> {
    let ctx = context(env)?;
    let sname = env.new_string(name).map_err(|e| e.to_string())?;
    let obj = env
        .call_method(&ctx, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[JValue::Object(&sname)])
        .map_err(|e| e.to_string())?
        .l()?;
    Ok(obj)
}

fn call_bool(env: &mut JNIEnv, obj: &JObject, method: &str, sig: &str, args: &[JValue]) -> Jum<bool> {
    env.call_method(obj, method, sig, args).map_err(|e| e.to_string())?.z().map_err(|e| e.to_string())
}

/// `checkSelfPermission` is Context-level since API 23; minSdk is 26, so it is always there.
fn self_granted(env: &mut JNIEnv, permission: &str) -> Jum<bool> {
    let ctx = context(env)?;
    let p = env.new_string(permission).map_err(|e| e.to_string())?;
    let code = env
        .call_method(&ctx, "checkSelfPermission", "(Ljava/lang/String;)I", &[JValue::Object(&p)])
        .map_err(|e| e.to_string())?
        .i()?;
    Ok(code == 0) // PackageManager.PERMISSION_GRANTED
}

/// `Activity.shouldShowRequestPermissionRationale` — the difference between "denied once"
/// and "never again": the case the design says only the app can guide the user out of.
fn rationale(env: &mut JNIEnv, permission: &str) -> Jum<bool> {
    let activity = unsafe { JObject::from_raw(ndk_context::android_context().activity().cast()) };
    let p = env.new_string(permission).map_err(|e| e.to_string())?;
    env.call_method(&activity, "shouldShowRequestPermissionRationale", "(Ljava/lang/String;)Z", &[JValue::Object(&p)])
        .map_err(|e| e.to_string())?
        .z()
        .map_err(|e| e.to_string())
}

fn permission_name(name: &str) -> Jum<&'static str> {
    match name {
        "mic" => Ok("android.permission.RECORD_AUDIO"),
        "notif" => Ok("android.permission.POST_NOTIFICATIONS"),
        _ => Err(format!("unknown permission: {name}")),
    }
}

/// The system dialog, fired on the main thread (window tokens belong to it).
pub fn request(app: &tauri::AppHandle, name: String) -> Result<(), String> {
    let perm = permission_name(&name)?.to_string();
    let app = app.clone();
    app.run_on_main_thread(move || {
        let _ = with_env(|env| {
            let activity = unsafe { JObject::from_raw(ndk_context::android_context().activity().cast()) };
            let s = env.new_string(&perm).map_err(|e| e.to_string())?;
            let empty = env.new_string("").map_err(|e| e.to_string())?;
            let array = env
                .new_object_array(1, "java/lang/String", JValue::from(&empty))
                .map_err(|e| e.to_string())?;
            env.set_object_array_element(&array, 0, JObject::from(&s)).map_err(|e| e.to_string())?;
            // ActivityCompat: requestPermissions(String[], int). The plain Activity method
            // exists since API 23 with the same signature. requestCode is meaningless to us
            // (we poll the status, the dialog result needs no routing) — 0 it is.
            env.call_method(&activity, "requestPermissions", "([Ljava/lang/String;I)V", &[JValue::Object(&array), JValue::Int(0)])
                .map_err(|e| e.to_string())
        });
    })
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct MicStatus {
    pub granted: bool,
    pub rationale: bool,
}

/// Returns `Result` even though reading the state cannot realistically fail, so the stub's
/// signature matches and `lib.rs` need not care which module it is calling.
pub fn mic_status() -> Result<MicStatus, String> {
    with_env(|env| {
        Ok(MicStatus { granted: self_granted(env, "android.permission.RECORD_AUDIO")?, rationale: rationale(env, "android.permission.RECORD_AUDIO")? })
    })
}

/// POST_NOTIFICATIONS is a runtime permission from API 33; on 26–32 notifications are simply
/// on. Reporting false only where the user can actually still grant.
pub fn notif_enabled() -> Jum<bool> {
    let sdk = with_env(|env| {
        let cls = env.find_class("android/os/Build$VERSION").map_err(|e| e.to_string())?;
        env.get_static_field(&cls, "SDK_INT", "I").map_err(|e| e.to_string())?.i().map_err(|e| e.to_string())
    })?;
    if sdk < 33 {
        return Ok(true);
    }
    with_env(|env| self_granted(env, "android.permission.POST_NOTIFICATIONS"))
}

/// "Ignore battery optimizations" is an allowlist the user toggles in settings; there is no
/// runtime dialog, only this query and the settings deep link next to it.
pub fn battery_ignored() -> Jum<bool> {
    with_env(|env| {
        let pm = service(env, "power")?;
        let ctx = context(env)?;
        let id = env
            .call_method(&ctx, "getPackageName", "()Ljava/lang/String;", &[])
            .map_err(|e| e.to_string())?
            .l()?;
        call_bool(env, &pm, "isIgnoringBatteryOptimizations", "(Ljava/lang/String;)Z", &[JValue::Object(&id)])
    })
}

fn launch(env: &mut JNIEnv, action: &str, data_pkg: Option<&str>) -> Jum<()> {
    let ctx = context(env)?;
    let s = env.new_string(action).map_err(|e| e.to_string())?;
    let intent = env
        .new_object("android/content/Intent", "(Ljava/lang/String;)V", &[JValue::Object(&s)])
        .map_err(|e| e.to_string())?;
    if let Some(pkg) = data_pkg {
        // Uri.parse("package:<pkg>") keeps the page on *this* app instead of the global list.
        let uri_str = env.new_string(format!("package:{pkg}")).map_err(|e| e.to_string())?;
        let uri = env
            .call_static_method("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", &[JValue::Object(&uri_str)])
            .map_err(|e| e.to_string())?
            .l()?;
        env.call_method(&intent, "setData", "(Landroid/net/Uri;)Landroid/content/Intent;", &[JValue::Object(&uri)])
            .map_err(|e| e.to_string())?;
    }
    env.call_method(&ctx, "startActivity", "(Landroid/content/Intent;)V", &[JValue::Object(&intent)])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Application-details page, where the mic toggle lives ("应用信息 → 权限 → 麦克风").
pub fn open_app_settings(app: &tauri::AppHandle) -> Result<(), String> {
    let pkg = package_name()?;
    let app = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(with_env(|env| launch(env, "android.settings.APPLICATION_DETAILS_SETTINGS", Some(&pkg))));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// The battery-optimization allowlist dialog, which answers immediately — hence no polling.
pub fn open_battery_settings(app: &tauri::AppHandle) -> Result<(), String> {
    let pkg = package_name()?;
    let app = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(with_env(|env| launch(env, "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS", Some(&pkg))));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// WindowManager.FLAG_KEEP_SCREEN_ON, set on the activity's window while a session runs so
/// "屏幕常亮" means the phone, not the webview's own timer hacks (which WebView ignores).
pub fn set_keep_screen_on(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    let app = app.clone();
    app.run_on_main_thread(move || {
        let _ = with_env(|env| {
            let activity = unsafe { JObject::from_raw(ndk_context::android_context().activity().cast()) };
            let window = env
                .call_method(&activity, "getWindow", "()Landroid/view/Window;", &[])
                .map_err(|e| e.to_string())?
                .l()?;
            let (method, flag) = if on { ("addFlags", 0x0000_0080) } else { ("clearFlags", 0x0000_0080) };
            env.call_method(&window, method, "(I)V", &[JValue::Int(flag)])
                .map_err(|e| e.to_string())
        });
    })
    .map_err(|e| e.to_string())
}

fn package_name() -> Jum<String> {
    with_env(|env| {
        let ctx = context(env)?;
        let s = env
            .call_method(&ctx, "getPackageName", "()Ljava/lang/String;", &[])
            .map_err(|e| e.to_string())?
            .l()?;
        Ok(env.get_string(&s.into()).map_err(|e| e.to_string())?.into())
    })
}

/// SSID of the Wi-Fi we are joined to (quoted by Android; quotes stripped), or "unknown".
/// The hotspot-file source names this so the user can tell which phone is which at a glance.
pub fn wifi_ssid() -> String {
    with_env(|env| {
        let wifi = service(env, "wifi")?;
        let info = env
            .call_method(&wifi, "getConnectionInfo", "()Landroid/net/wifi/WifiInfo;", &[])
            .map_err(|e| e.to_string())?
            .l()?;
        if info.is_null() {
            return Ok("unknown".to_string());
        }
        let s = env
            .call_method(&info, "getSSID", "()Ljava/lang/String;", &[])
            .map_err(|e| e.to_string())?
            .l()?;
        let str = env.get_string(&s.into()).map_err(|e| e.to_string())?.into();
        Ok(str.trim_matches('"').to_string())
    })
    .unwrap_or_else(|_| "unknown".to_string())
}

/// Manufacturer + model, for the same purpose on phones whose hotspot we cannot name.
pub fn device_model() -> String {
    let f = |key: &str| {
        with_env(|env| {
            let cls = env.find_class("android/os/Build").map_err(|e| e.to_string())?;
            let obj = env
                .get_static_field(&cls, key, "Ljava/lang/String;")
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;
            Ok(env.get_string(&obj.into()).map_err(|e| e.to_string())?.into())
        })
        .unwrap_or_default()
    };
    let maker = f("MANUFACTURER");
    let model = f("MODEL");
    if maker.is_empty() && model.is_empty() {
        "unknown".to_string()
    } else {
        format!("{maker} {model}").trim().to_string()
    }
}
