import { reactive } from "vue";
import { droid } from "./perms";
import { t } from "../core/i18n";

export const native = reactive({
  supported: !!droid && typeof droid.overlayStatus === "function",
  granted: false, visible: false, ready: false, captureKind: "", systemState: "idle", error: "", frames: 0, width: 0,
  systemSupported: !!droid && typeof droid.systemAudioSupported === "function" && droid.systemAudioSupported(),
});

export function refreshNative() {
  if (!native.supported || !droid) return;
  const state = JSON.parse(droid.overlayStatus()) as Record<string, unknown>;
  for (const key of ["granted", "visible", "ready"] as const) native[key] = state[key] === true;
  for (const key of ["captureKind", "systemState", "error"] as const) native[key] = typeof state[key] === "string" ? state[key] as string : "";
  native.frames = typeof state.frames === "number" && Number.isFinite(state.frames) ? state.frames : 0;
  native.width = typeof state.width === "number" && Number.isFinite(state.width) ? state.width : 0;
}
function requireBridge() {
  if (!native.supported || !droid) throw new Error(t("nativeUnavailable"));
  return droid;
}
export function requestOverlay() { requireBridge().requestOverlay(); }
export function updateOverlay(data: object) { if (native.supported) droid?.updateOverlay(JSON.stringify(data)); }
export function resetOverlayPosition() { requireBridge().resetOverlayPosition(); }
export async function showOverlay(show: boolean) {
  requireBridge().showOverlay(show);
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    refreshNative();
    if (native.error) throw new Error(native.error);
    if (native.visible === show && (!show || native.ready)) return;
  }
  throw new Error(t("overlayStartFailed"));
}
export function stopCapture() { if (native.supported) droid?.stopCapture(); }
export async function beginCapture(kind: "mic" | "system" | "file"): Promise<boolean> {
  const bridge = requireBridge();
  if (kind === "system") {
    if (!native.systemSupported) throw new Error(t("systemAudioAndroid10"));
    bridge.requestSystemAudio();
  } else bridge.startCapture(kind);
  const attempts = kind === "system" ? 240 : 40;
  try {
    for (let i = 0; i < attempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      refreshNative();
      if (native.error) throw new Error(native.error);
      if (kind === "system" && native.systemState === "cancelled") return false;
      if (native.ready && native.captureKind === kind && (kind !== "system" || native.systemState === "ready")) return true;
    }
    throw new Error(t("captureStartFailed"));
  } catch (e) { stopCapture(); throw e; }
}
