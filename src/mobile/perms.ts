import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";

/**
 * Android runtime permissions for the phone shell, in one module, so the top-bar dot, the
 * settings check bar, the permission centre and the start button all read one truth.
 *
 * The implementation is the Kotlin bridge (src-tauri/android/MainActivity.kt, registered
 * as window.ReaLingoAndroid — the LittleLobby pattern). An earlier revision went through
 * Rust JNI commands; Tauri's AppHandle has no stable Activity accessor and the jni
 * lifetime fight cost CI rounds, so the commands are gone. The `invoke` fallbacks only
 * answer "granted / unknown" on desktop, where this shell never mounts anyway; they exist
 * so a stale webview bundle against an older APK degrades permissively, not fatally.
 *
 * `micStatus` returns {granted, rationale} — rationale is
 * shouldShowRequestPermissionRationale, the line between "denied once, the system will ask
 * again" and "never ask again", which per the design is the only case the app itself may
 * guide the user out of.
 */
export type MicState = "unset" | "granted" | "denied" | "permanent";

interface Droid {
  micStatus(): string;
  requestMic(): void;
  notifEnabled(): boolean;
  batteryIgnored(): boolean;
  openAppSettings(): void;
  openBatterySettings(): void;
  setKeepScreenOn(on: boolean): void;
  deviceName(): string;
  pickAudioFile(): void;
  pickResult(): string;
  overlayStatus(): string;
  systemAudioSupported(): boolean;
  requestOverlay(): void;
  showOverlay(show: boolean): void;
  updateOverlay(json: string): void;
  resetOverlayPosition(): void;
  startCapture(kind: string): void;
  stopCapture(): void;
  requestSystemAudio(): void;
  saveText(name: string, contents: string): void;
  saveTextResult(): string;
}

/** Null on the desktop, and on an Android APK built before the bridge existed. */
export const droid = (window as { ReaLingoAndroid?: Droid }).ReaLingoAndroid ?? null;

export const perms = reactive({
  mic: "unset" as MicState,
  notif: true,
  battery: true,
  /** Guide dialog sent us to system settings; on return, start the session once granted. */
  pendingStart: false,
  /** Identity of this phone, for the drawer that names the session peer; fetched once. */
  deviceName: null as string | null,
});

// Remembered across launches: before the first-ever request, rationale is also false, and
// the two cases must not look alike (unset would otherwise read as permanently denied).
let asked = localStorage.getItem("micAsked") === "1";

/** Re-read every permission. Called on launch and on every resume — the design's
 *  "改完不用重启": the user flips something in system settings, comes back, state follows. */
export async function refreshPerms(): Promise<void> {
  if (droid) {
    try {
      const r = JSON.parse(droid.micStatus()) as { granted: boolean; rationale: boolean; requesting?: boolean };
      if (!r.requesting) perms.mic = r.granted ? "granted" : r.rationale ? "denied" : asked ? "permanent" : "unset";
      perms.notif = droid.notifEnabled();
      perms.battery = droid.batteryIgnored();
      if (perms.deviceName === null) perms.deviceName = droid.deviceName();
      return;
    } catch {
      // A throwing bridge method is worse than no bridge: fall through to the old
      // commands, whose failure still lands on the permissive defaults below.
    }
  }
  try {
    const r = await invoke<{ granted: boolean; rationale: boolean }>("perm_status", { name: "mic" });
    perms.mic = r.granted ? "granted" : r.rationale ? "denied" : asked ? "permanent" : "unset";
    perms.notif = await invoke<boolean>("notif_enabled");
    perms.battery = await invoke<boolean>("battery_ignored");
    if (perms.deviceName === null) perms.deviceName = await invoke<string>("device_name");
  } catch {
    /* older APK without the command: keep the permissive defaults */
  }
}

/**
 * Fire the system dialog and wait for its answer. Android resolves the request
 * asynchronously and we never get a JS callback for it, so poll until the status moves.
 * A human needs a beat to read the dialog, hence half-second ticks for up to 30 s; after
 * that the next resume refresh still catches a slow answer (start() waits on it).
 */
export async function askMic(autoStart = false): Promise<MicState> {
  asked = true;
  localStorage.setItem("micAsked", "1");
  const before = perms.mic;
  if (droid) droid.requestMic();
  else await invoke("perm_request", { name: "mic" }).catch(() => {});
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    await refreshPerms();
    // rationale stays false while the OS dialog is open. It only means permanent
    // denial after onRequestPermissionsResult, not on the first polling tick.
    if (droid) {
      const { requesting } = JSON.parse(droid.micStatus());
      if (requesting) continue;
      if (requesting === false) break;
    }
    if (perms.mic !== before) break;
  }
  // Dialog still open after 30 s: let the resume refresh start on a late yes.
  if (autoStart && droid && JSON.parse(droid.micStatus()).requesting) perms.pendingStart = true;
  return perms.mic;
}

export function openAppSettings(autoStart: boolean) {
  perms.pendingStart = autoStart;
  if (droid) droid.openAppSettings();
  else void invoke("open_app_settings").catch(() => {});
}

export function openBatterySettings() {
  if (droid) droid.openBatterySettings();
  else void invoke("open_battery_settings").catch(() => {});
}

export function setKeepScreenOn(on: boolean) {
  if (droid) droid.setKeepScreenOn(on);
  else void invoke("set_keep_screen_on", { on }).catch(() => {});
}

/**
 * The system document picker, through the bridge: Tauri's dialog plugin has no Android
 * implementation, and the plugin call would just reject. The Kotlin side copies the
 * content:// uri into our cache (the decode pipeline wants a plain path) and reports
 * through pickResult; this polls the one-slot state, matching how askMic waits.
 * Resolves with the file path, or null when the user backed out.
 */
export async function pickAudio(): Promise<string | null> {
  if (!droid) return null;
  droid.pickAudioFile();
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = JSON.parse(droid.pickResult()) as { state: string; path?: string };
    if (s.state === "picked") return s.path ?? null;
    if (s.state === "cancelled" || s.state === "error") return null;
  }
  return null; // two minutes: the picker may remain open, but stop polling
}

/** Permissions the system dialog can no longer fix — the only ones worth alarming on.
 *  The first-time `unset` state is deliberately absent: the OS prompt owns that case. */
export function pendingList(): ("mic" | "battery")[] {
  const bad: ("mic" | "battery")[] = [];
  if (perms.mic === "permanent") bad.push("mic");
  if (!perms.battery) bad.push("battery");
  return bad;
}
