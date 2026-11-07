import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";

/**
 * Android runtime permissions for the phone shell, in one module, so the top-bar dot, the
 * settings check bar, the permission centre and the start button all read one truth.
 *
 * On the desktop the same commands exist (mobile_stub.rs) and answer "granted / no-op", so
 * no platform check is needed here; the shell that renders them only ever mounts on
 * Android anyway. `perm_status` returns {granted, rationale} — rationale is
 * shouldShowRequestPermissionRationale, the line between "denied once, the system will ask
 * again" and "never ask again", which per the design is the only case the app itself may
 * guide the user out of.
 */
export type MicState = "unset" | "granted" | "denied" | "permanent";

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

async function call<T>(cmd: string, args?: object): Promise<T | null> {
  try {
    return await invoke<T>(cmd, args);
  } catch {
    return null; // older APK without the command: keep the permissive default
  }
}

/** Re-read every permission. Called on launch and on every resume — the design's
 *  "改完不用重启": the user flips something in system settings, comes back, state follows. */
export async function refreshPerms(): Promise<void> {
  const r = await call<{ granted: boolean; rationale: boolean }>("perm_status", { name: "mic" });
  if (r !== null) {
    perms.mic = r.granted ? "granted" : r.rationale ? "denied" : asked ? "permanent" : "unset";
  }
  const n = await call<boolean>("notif_enabled");
  if (n !== null) perms.notif = n;
  const b = await call<boolean>("battery_ignored");
  if (b !== null) perms.battery = b;
  if (perms.deviceName === null) {
    perms.deviceName = await call<string>("device_name");
  }
}

/**
 * Fire the system dialog and wait for its answer. Android resolves the request
 * asynchronously and we never get a JS callback for it, so poll until the status moves.
 * A human needs a beat to read the dialog, hence half-second ticks for up to 30 s; after
 * that the next resume refresh still catches a slow answer (start() waits on it).
 */
export async function askMic(): Promise<MicState> {
  asked = true;
  localStorage.setItem("micAsked", "1");
  const before = perms.mic;
  await call("perm_request", { name: "mic" });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    await refreshPerms();
    if (perms.mic !== before) break;
  }
  return perms.mic;
}

export function openAppSettings(autoStart: boolean) {
  perms.pendingStart = autoStart;
  void invoke("open_app_settings").catch(() => {});
}

export function openBatterySettings() {
  void invoke("open_battery_settings").catch(() => {});
}

export function setKeepScreenOn(on: boolean) {
  void invoke("set_keep_screen_on", { on }).catch(() => {});
}

/** Permissions the system dialog can no longer fix — the only ones worth alarming on.
 *  The first-time `unset` state is deliberately absent: the OS prompt owns that case. */
export function pendingList(): ("mic" | "battery")[] {
  const bad: ("mic" | "battery")[] = [];
  if (perms.mic === "permanent") bad.push("mic");
  if (!perms.battery) bad.push("battery");
  return bad;
}
