import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { activeKey, settings } from "./store";
import { canSpeak, langName, languageCodes, PROTOCOLS, VOICE_LISTS, voiceLabel } from "./languages";
import { locale } from "./i18n";
import { caps } from "./platform";
import { current, detectedLang, errorMsg, fileProgress, isRunning, lines, rawLog, speaking, start, status, stop, warnMsg } from "./stream";

/** Which audio the session reads. */
export type SourceKind = "mic" | "system" | "file";

/**
 * Everything a session needs that is not a window: picking a device or a file, keeping the
 * language pair legal for the protocol, and deciding whether the translation may be spoken.
 *
 * Lives here rather than inside `App.vue` because the phone shell and the desktop window ask
 * for exactly the same answers, and a per-protocol rule written twice is a rule that drifts.
 */
export function useSession() {
  // The phone's choice survives launches (localStorage, not settings.json: the desktop
  // keeps its own tab state and the Rust Settings would only ignore a foreign field).
  const saved = localStorage.getItem("sourceKind");
  const sourceKind = ref<SourceKind>(saved === "system" || saved === "file" ? saved : "mic");
  watch(sourceKind, (v) => localStorage.setItem("sourceKind", v));
  const devices = ref<{ id: string; name: string; loopback: boolean }[]>([]);
  const deviceId = ref("");
  const filePath = ref("");
  const level = ref(0);

  /* ---------- audio devices ---------- */
  // Where loopback is unavailable (Linux), the "system audio" tab still lists ordinary inputs:
  // the user routes our recording stream to a monitor source outside the app.
  const wantLoopback = computed(() => sourceKind.value === "system" && caps.value.loopback);
  const visibleDevices = computed(() => devices.value.filter((d) => d.loopback === wantLoopback.value));
  const fileName = computed(() => filePath.value.split(/[\\/]/).pop() ?? "");
  const deviceOptions = computed(() => visibleDevices.value.map((d) => ({ value: d.id, label: d.name })));
  const canStart = computed(() => (sourceKind.value === "file" ? !!filePath.value : !!deviceId.value));

  async function refreshDevices() {
    devices.value = await invoke("list_devices");
    await pickDefaultDevice();
  }

  async function pickDefaultDevice() {
    if (sourceKind.value === "file") return;
    if (visibleDevices.value.some((d) => d.id === deviceId.value)) return;
    const preferred = await invoke<string | null>("default_device", { loopback: wantLoopback.value });
    deviceId.value = preferred ?? visibleDevices.value[0]?.id ?? "";
  }

  watch(sourceKind, pickDefaultDevice);

  /** Samples the input meter while a session runs; 0 otherwise, so the bar rests. */
  async function pollLevel() {
    level.value = isRunning() ? await invoke<number>("input_level") : 0;
  }

  /* ---------- model / languages ---------- */
  const langCodes = computed(() => languageCodes(settings.protocol, settings.model));
  /** How the source language is set (see PROTOCOLS): some services always detect it. */
  const sourceMode = computed(() => PROTOCOLS[settings.protocol].source);
  watch(sourceMode, (mode) => {
    if (mode === "detected") settings.sourceLang = "auto";
  }, { immediate: true });

  /** The picker matches on both UI languages, so a zh user can still type "japanese". */
  const langOptions = computed(() =>
    langCodes.value.map((c) => ({
      value: c,
      label: langName(c, locale.value),
      note: c,
      keywords: `${langName(c, "zh")} ${langName(c, "en")}`,
    }))
  );
  /** Volcengine wants Chinese or English on one side of every pair (PROTOCOLS `hub`). */
  const hub = computed(() => PROTOCOLS[settings.protocol].hub);
  const onHub = (code: string) => !hub.value.length || hub.value.includes(code);
  /** Once one side is off the hub, the other side may only offer the hub's languages. */
  const pairableWith = (other: string) =>
    onHub(other) ? langOptions.value : langOptions.value.filter((o) => onHub(o.value));
  const sourceLangOptions = computed(() => [
    ...(sourceMode.value === "named" ? [] : [{ value: "auto", label: langName("auto", locale.value) }]),
    ...(sourceMode.value === "detected" ? [] : pairableWith(settings.targetLang)),
  ]);
  const targetLangOptions = computed(() => pairableWith(settings.sourceLang));

  // Switching to the smaller model can strand a language it cannot translate into; the
  // session would then be refused server-side, so repair the selection here instead. The
  // pickers keep a pair valid from then on; this covers arriving with one already invalid.
  watch([langCodes, sourceMode, hub], ([codes, mode]) => {
    const ok = new Set(codes);
    if (settings.sourceLang !== "auto" && !ok.has(settings.sourceLang)) settings.sourceLang = "auto";
    if (!ok.has(settings.targetLang)) settings.targetLang = ok.has("en") ? "en" : codes[0];
    if (mode === "named" && settings.sourceLang === "auto") settings.sourceLang = settings.targetLang === "zh" ? "en" : "zh";
    if (!onHub(settings.sourceLang) && !onHub(settings.targetLang)) settings.targetLang = hub.value[0];
  }, { immediate: true });

  /** Chinese ⇄ English in one session; only where the protocol can, and then pickers step aside. */
  const canTwoWay = computed(() => PROTOCOLS[settings.protocol].twoWay);
  const twoWay = computed(() => canTwoWay.value && settings.twoWay);

  /* ---------- read aloud ---------- */
  const voiceList = computed(() => PROTOCOLS[settings.protocol].voices);
  const voiceOptions = computed(() =>
    VOICE_LISTS[voiceList.value ?? "qwen"].map((v) => ({
      value: v.id,
      label: voiceLabel(v, locale.value),
      note: locale.value === "zh" ? v.descZh : v.descEn,
      keywords: `${v.zh} ${v.descZh} ${v.descEn}`,
    }))
  );
  // One `voice` setting serves every list, so each list's pick is parked on the way out and
  // brought back on the way in — a round trip through Volcengine keeps the Qwen voice.
  watch(voiceList, (now, was) => {
    if (was) settings.savedVoices[was] = settings.voice;
    if (!now) return;
    const list = VOICE_LISTS[now];
    const back = settings.savedVoices[now];
    if (back && list.some((v) => v.id === back)) settings.voice = back;
    else if (!list.some((v) => v.id === settings.voice)) settings.voice = list[0].id;
  }, { immediate: true });

  // Why speaking cannot happen with the current choices, if it cannot. Linux has no way to
  // leave our own playback out of a monitor source, so system audio would hear itself.
  const speakBlocked = computed(() => {
    // Two-way speaks Chinese and English, both always speakable where two-way exists.
    if (!twoWay.value && !canSpeak(settings.protocol, settings.targetLang)) return "speakNoLang" as const;
    if (caps.value.os === "linux" && sourceKind.value === "system") return "speakLinuxSystem" as const;
    return null;
  });

  /* ---------- run ---------- */
  const statusKey = computed(() => {
    if (!activeKey().trim()) return "statusNoKey" as const;
    if (status.value === "error") return "statusError" as const;
    if (status.value === "connecting") return "statusConnecting" as const;
    if (status.value === "stopping") return "statusStopping" as const;
    if (status.value === "connected") return speaking.value ? ("statusListening" as const) : ("statusConnected" as const);
    return "statusIdle" as const;
  });

  /**
   * Starts from whatever the source selection currently holds. `guards` lets the phone shell
   * check a runtime permission before the first frame is captured; the desktop has nothing to
   * ask, so it passes nothing. Returns false when a guard (or a missing key) stopped the run.
   */
  async function toggle(guards?: () => Promise<boolean>): Promise<boolean> {
    if (isRunning()) {
      await stop();
      return true;
    }
    if (!activeKey().trim()) return false;
    if (guards && !(await guards())) return false;
    await start(
      sourceKind.value === "file" ? { kind: "file", path: filePath.value } : { kind: "device", id: deviceId.value },
      settings.speak && !speakBlocked.value
    );
    return true;
  }

  return {
    sourceKind, devices, deviceId, filePath, level, fileName, deviceOptions, canStart,
    refreshDevices, pickDefaultDevice, pollLevel,
    langCodes, sourceMode, langOptions, sourceLangOptions, targetLangOptions, hub, canTwoWay, twoWay,
    voiceList, voiceOptions, speakBlocked, statusKey,
    toggle,
  };
}

export type Session = ReturnType<typeof useSession>;

/**
 * One session for the phone shell, created at module level: the mobile components
 * (top-bar chip, source drawer, run page, permission pages) all need the same refs, and
 * prop-drilling a composable through five sheets buys nothing. The desktop App.vue keeps
 * its own instance and never imports this.
 */
export const session: Session = useSession();

/** The stream the run button drives; re-exported so a view imports its data from one place. */
export { current, detectedLang, errorMsg, fileProgress, isRunning, lines, rawLog, speaking, status, warnMsg, saveAs } from "./stream";
export { t } from "./i18n";
