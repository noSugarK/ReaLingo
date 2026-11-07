//! Android platform glue: the runtime permissions the phone UI has to reason about, the
//! system-settings pages it links to, and the device name a hotspot capture needs.
//!
//! Everything is behind `cfg(target_os = "android")`; the desktop gets the same command
//! surface through `mobile_stub.rs` (declared in lib.rs via cfg+path), so commands are
//! registered once and the frontend needs no platform check.
//!
//! JNI comes from `jni` and `ndk-context`, both already in the dependency graph via cpal's
//! AAudio backend and tauri's Android support — declaring them for the Android target adds
//! no new crates to the lockfile.
//!
//! Threading: JNI env is attached per call; anything touching window tokens (the consent
//! dialog, startActivity, FLAG_KEEP_SCREEN_ON) hops onto the main thread with
//! `run_on_main_thread` and returns through a channel. Permission *results* cannot be read
//! synchronously either: `requestPermissions` resolves asynchronously, so the frontend
//! polls `perm_status` after firing the request (see src/mobile/perms.ts).
//!
//! The Activity itself comes from Tauri (`AndroidAppHandleExt::android_app()`), not from
//! ndk-context — `AndroidContext` only carries the VM and the application context.

#![cfg(target_os = "android")]

use jni::objects::{JObject, JString, JValue};
use jni::JNIEnv;
use std::sync::mpsc;
use tauri::android::AndroidAppHandleExt;

/// Every command's error is a plain String for the frontend; this folds jni's own error
/// type into it so `?` works directly (String has no From<jni::Error>).
type Jum<T> = Result<T, String>;

trait Je<T> {
    fn je(self) -> Jum<T>;
}
impl<T> Je<T> for std::result::Result<T, jni::errors::Error> {
    fn je(self) -> Jum<T> {
        self.map_err(|e| e.to_string())
    }
}

/// Run `f` with a live JNIEnv. Closures return `Jum<R>` themselves — with_env forwards it
/// instead of nesting another Ok around it.
fn with_env<R>(f: impl FnOnce(&mut JNIEnv) -> Jum<R>) -> Jum<R> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    f(&mut env)
}

/// The application context, as a JObject living as long as the env we hand it to.
fn context<'a>(_env: &mut JNIEnv<'a>) -> Jum<JObject<'a>> {
    Ok(unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) })
}

/// The activity, as Tauri hands it out — the token the consent dialog and window flags
/// hang on. `AndroidAppHandleExt::activity()` answers the raw jobject on the main thread.
fn activity_obj(app: &tauri::AppHandle) -> JObject<'static> {
    unsafe { JObject::from_raw(app.activity()) }
}

/// `context.getSystemService(name)` — the three services we touch all answer the same way.
fn service<'a>(env: &mut JNIEnv<'a>, name: &str) -> Jum<JObject<'a>> {
    let ctx = context(env)?;
    let sname: JObject = env.new_string(name).je()?.into();
    env.call_method(
        &ctx,
        "getSystemService",
        "(Ljava/lang/String;)Ljava/lang/Object;",
        &[JValue::Object(&sname)],
    )
    .je()?
    .l()
    .je()
}

fn call_bool(env: &mut JNIEnv, obj: &JObject, method: &str, sig: &str, args: &[JValue]) -> Jum<bool> {
    env.call_method(obj, method, sig, args).je()?.z().je()
}

/// `checkSelfPermission` is Context-level since API 23; minSdk is 26, so it is always there.
fn self_granted(env: &mut JNIEnv, permission: &str) -> Jum<bool> {
    let ctx = context(env)?;
    let p: JObject = env.new_string(permission).je()?.into();
    let code = env
        .call_method(&ctx, "checkSelfPermission", "(Ljava/lang/String;)I", &[JValue::Object(&p)])
        .je()?
        .i()
        .je()?;
    Ok(code == 0) // PackageManager.PERMISSION_GRANTED
}

/// `Activity.shouldShowRequestPermissionRationale` — the difference between "denied once"
/// and "never again": the case the design says only the app can guide the user out of.
fn rationale(env: &mut JNIEnv, activity: &JObject, permission: &str) -> Jum<bool> {
    let p: JObject = env.new_string(permission).je()?.into();
    env.call_method(
        activity,
        "shouldShowRequestPermissionRationale",
        "(Ljava/lang/String;)Z",
        &[JValue::Object(&p)],
    )
    .je()?
    .z()
    .je()
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
    let sink = app.clone();
    app.run_on_main_thread(move || {
        let _ = with_env(|env| {
            let activity = activity_obj(&sink);
            // One-element String[] pre-filled with the permission itself; Activity's own
            // requestPermissions(String[], int) suffices from API 23 (minSdk 26), so no
            // ActivityCompat. requestCode is meaningless to us (we poll the status, the
            // dialog result needs no routing) — 0 it is.
            let s = env.new_string(&perm).je()?;
            let array: JObject = env.new_object_array(1, "java/lang/String", &s).je()?.into();
            env.call_method(
                &activity,
                "requestPermissions",
                "([Ljava/lang/String;I)V",
                &[JValue::Object(&array), JValue::Int(0)],
            )
            .je()?;
            Ok(())
        });
    })
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct MicStatus {
    pub granted: bool,
    pub rationale: bool,
}

/// Both halves read the same permission; rationale needs the Activity, so the whole call
/// runs on the main thread like the others (the frontend polls this anyway).
pub fn mic_status(app: &tauri::AppHandle) -> Result<MicStatus, String> {
    let sink = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(with_env(|env| {
            let activity = activity_obj(&sink);
            Ok(MicStatus {
                granted: self_granted(env, "android.permission.RECORD_AUDIO")?,
                rationale: rationale(env, &activity, "android.permission.RECORD_AUDIO")?,
            })
        }));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// POST_NOTIFICATIONS is a runtime permission from API 33; on 26–32 notifications are simply
/// on. Reporting false only where the user can actually still grant.
pub fn notif_enabled() -> Jum<bool> {
    let sdk = with_env(|env| {
        let cls = env.find_class("android/os/Build$VERSION").je()?;
        env.get_static_field(&cls, "SDK_INT", "I").je()?.i().je()
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
        let id = env.call_method(&ctx, "getPackageName", "()Ljava/lang/String;", &[]).je()?.l().je()?;
        call_bool(env, &pm, "isIgnoringBatteryOptimizations", "(Ljava/lang/String;)Z", &[JValue::Object(&id)])
    })
}

fn launch(env: &mut JNIEnv, action: &str, data_pkg: Option<&str>) -> Jum<()> {
    let ctx = context(env)?;
    let s: JObject = env.new_string(action).je()?.into();
    let intent = env
        .new_object("android/content/Intent", "(Ljava/lang/String;)V", &[JValue::Object(&s)])
        .je()?;
    if let Some(pkg) = data_pkg {
        // Uri.parse("package:<pkg>") keeps the page on *this* app instead of the global list.
        let uri_str: JObject = env.new_string(format!("package:{pkg}")).je()?.into();
        let uri = env
            .call_static_method("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", &[JValue::Object(&uri_str)])
            .je()?
            .l()
            .je()?;
        env.call_method(&intent, "setData", "(Landroid/net/Uri;)Landroid/content/Intent;", &[JValue::Object(&uri)])
            .je()?;
    }
    env.call_method(&ctx, "startActivity", "(Landroid/content/Intent;)V", &[JValue::Object(&intent)])
        .je()?;
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
    let sink = app.clone();
    app.run_on_main_thread(move || {
        let _ = with_env(|env| {
            let activity = activity_obj(&sink);
            let window = env.call_method(&activity, "getWindow", "()Landroid/view/Window;", &[]).je()?.l().je()?;
            let (method, flag) = if on { ("addFlags", 0x0000_0080) } else { ("clearFlags", 0x0000_0080) };
            // The JValue call_method returns borrows from env, so drop it here rather than
            // returning it out of the closure.
            env.call_method(&window, method, "(I)V", &[JValue::Int(flag)]).je()?;
            Ok(())
        });
    })
    .map_err(|e| e.to_string())
}

fn package_name() -> Jum<String> {
    with_env(|env| {
        let ctx = context(env)?;
        let s = env.call_method(&ctx, "getPackageName", "()Ljava/lang/String;", &[]).je()?.l().je()?;
        Ok(env.get_string(&JString::from(s)).je()?.into())
    })
}

/// SSID of the Wi-Fi we are joined to (quoted by Android; quotes stripped), or "unknown".
/// The hotspot-file source names this so the user can tell which phone is which at a glance.
pub fn wifi_ssid() -> String {
    with_env(|env| {
        let wifi = service(env, "wifi")?;
        let info = env.call_method(&wifi, "getConnectionInfo", "()Landroid/net/wifi/WifiInfo;", &[]).je()?.l().je()?;
        if info.is_null() {
            return Ok("unknown".to_string());
        }
        let s = env.call_method(&info, "getSSID", "()Ljava/lang/String;", &[]).je()?.l().je()?;
        let str: String = env.get_string(&JString::from(s)).je()?.into();
        Ok(str.trim_matches('"').to_string())
    })
    .unwrap_or_else(|_| "unknown".to_string())
}

/// Manufacturer + model, for the same purpose on phones whose hotspot we cannot name.
pub fn device_model() -> String {
    let f = |key: &str| -> String {
        with_env(|env| {
            let cls = env.find_class("android/os/Build").je()?;
            let obj = env.get_static_field(&cls, key, "Ljava/lang/String;").je()?.l().je()?;
            Ok(env.get_string(&JString::from(obj)).je()?.into())
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
