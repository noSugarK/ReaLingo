<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

import Hotwords from "../components/Hotwords.vue";
import History from "../components/History.vue";
import DiagnosticsSheet from "./DiagnosticsSheet.vue";
import OverlaySheet from "./OverlaySheet.vue";
import { native, refreshNative, requestOverlay, showOverlay, updateOverlay, beginCapture, stopCapture } from "./native";
import SourceSheet from "./SourceSheet.vue";
import LangSheet from "./LangSheet.vue";
import ModelSheet from "./ModelSheet.vue";
import AboutSheet from "./AboutSheet.vue";
import UiLangSheet from "./UiLangSheet.vue";
import StreamList from "./StreamList.vue";
import Toaster from "./Toaster.vue";
import Icon from "./Icon.vue";
import mark from "../assets/mark.png";
import { session } from "../session";
import { loadCaps } from "../platform";
import { settings, STREAM_SIZE, activeKey, setActiveKey, keyringOk, initSettings } from "../store";
import { PRESETS, PROTOCOLS, langName, modelName } from "../languages";
import { locale, t, tf } from "../i18n";
import { checkUpdateAtStartup } from "../update";
import { isRunning, lines, current, status, errorMsg, warnMsg, fileProgress, saveAs } from "../stream";
import { perms, droid, refreshPerms, askMic, openAppSettings, openBatterySettings, pendingList, setKeepScreenOn, pickAudio } from "./perms";
import { toast } from "./toasts";

type Page = "home" | "settings" | "perms";
const page = ref<Page>("home");
type Drawer = null | "src" | "lang" | "model" | "about" | "uilang" | "overlay" | "history" | "diagnostics";
const drawer = ref<Drawer>(null);

/** Modes layered over the home layout: the room reads these, the hand does not. */
const mode = ref<"normal" | "face" | "big">("normal");

/* ---------- boot ---------- */
let nativeTimer: number | undefined;
let pendingOverlay = false;
let lastNativeError = "";
const starting = ref(false);
let levelTimer: number | undefined;
let unlistenResume: (() => void) | undefined;
const bootError = ref("");
const reload = () => window.location.reload();

/** Coming back to the app re-checks permissions (the design's "改完不用重启") and fires a
 *  start the guide dialog promised. `tauri://resume` is mobile's lifecycle event;
 *  `visibilitychange` is the belt-and-braces fallback — whichever arrives first wins, and
 *  the guard inside keeps a double delivery from starting twice. */
async function onResume() {
  await refreshPerms();
  refreshNative();
  if (pendingOverlay && native.granted) { pendingOverlay = false; await toggleOverlay(); }
  if (perms.pendingStart && perms.mic === "granted") {
    perms.pendingStart = false;
    void start();
  }
}

onMounted(async () => {
  try {
    await initSettings();
    await loadCaps();
    refreshNative();
    settings.sub.show = native.visible;
    syncOverlay();
    nativeTimer = window.setInterval(() => {
      refreshNative();
      settings.sub.show = native.visible;
      if (native.visible && native.width >= 40 && native.width <= 100) settings.sub.mobileWidth = native.width;
      if (native.error && native.error !== lastNativeError) toast(native.error);
      lastNativeError = native.error;
      if ((status.value === "connecting" || status.value === "connected") && !starting.value && !native.captureKind) { void session.toggle(); toast(t("captureEnded")); }
    }, 1000);
    await refreshPerms();
    await session.refreshDevices();
    levelTimer = window.setInterval(() => void session.pollLevel(), 120);
    unlistenResume = await listen("tauri://resume", onResume);
    document.addEventListener("visibilitychange", onVisible);
    void checkUpdateAtStartup();
  } catch (e) {
    bootError.value = String(e);
    console.error("ReaLingo startup failed", e);
  }
});
function onVisible() {
  if (!document.hidden) void onResume();
}
onUnmounted(() => {
  window.clearInterval(levelTimer);
  window.clearInterval(nativeTimer);
  unlistenResume?.();
  document.removeEventListener("visibilitychange", onVisible);
});

/* ---------- derived ---------- */
const running = computed(() => isRunning());
const srcLabel = computed(() => t(({ mic: "srcMic", system: "srcSystem", file: "srcFile" } as const)[session.sourceKind.value]));
const modelLine = computed(() => `${modelName(settings.protocol, settings.model)} · ${PRESETS[settings.protocol][0].langs} ${t("langsUnit")}`);
const bad = computed(() => pendingList());
const emptyText = computed(() => tf("streamEmptyPhone", { lang: langName(settings.targetLang, locale.value) }));
const apiKey = computed({ get: activeKey, set: setActiveKey });

// Keep-screen-on follows the session, and only the user's switch: the native flag is a
// side effect of running, not of the page being open.
watch([running, () => settings.keepScreenOn], ([run, keep]) => setKeepScreenOn(run && keep), { immediate: true });

/* ---------- start / stop with the permission state machine ---------- */
async function start() {
  if (starting.value) return;
  if (!activeKey().trim()) {
    toast(t("noKeyToast"), { label: t("goSettings"), run: () => (page.value = "settings") });
    return;
  }
  if (session.sourceKind.value !== "file" && perms.mic !== "granted") {
    if (perms.mic === "permanent") {
      drawer.value = null;
      guideOpen.value = true;
      return;
    }
    // First time, or denied-but-will-ask-again: the system dialog owns it. The app adds
    // nothing around it (design rule) — just waits for the answer and starts on a yes.
    const after = await askMic();
    if (after === "granted") void doStart();
    else if (after === "permanent") guideOpen.value = true;
    else if (after === "denied") toast(t("permDeniedToast"));
    return;
  }
  await doStart();
}

async function doStart() {
  if (starting.value) return;
  starting.value = true;
  try {
    if (!await beginCapture(session.sourceKind.value)) return;
    await session.refreshDevices();
    await session.toggle();
    if (errorMsg.value) toast(errorMsg.value);
    if (!isRunning()) stopCapture();
  } catch (e) { stopCapture(); toast(String(e)); }
  finally { starting.value = false; }
}
watch(running, (run, old) => { if (old && !run) stopCapture(); });

async function exportRows(kind: "txt" | "srt") {
  try { await saveAs(kind, lines.value); } catch (e) { toast(String(e)); }
}
async function stop() {
  stopCapture();
  try { await session.toggle(); }
  catch (e) { errorMsg.value = String(e); status.value = "error"; }
}

/** The toast's "重新开始": stop, then start again with the new wire format. Stopping is
 *  asynchronous on the server's tail, so the restart waits for the status to settle. */
async function restartNow() {
  await session.toggle(); // running -> stop
  const until = Date.now() + 5000;
  while (isRunning() && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
  await doStart();
}

const guideOpen = ref(false);
function guideToSettings() {
  guideOpen.value = false;
  openAppSettings(true);
  toast(t("autoStartToast"));
}
function guideUseFile() {
  guideOpen.value = false;
  session.sourceKind.value = "file";
  void chooseFile();
}

/* ---------- file source ---------- */
const AUDIO_EXT = ["mp3", "wav", "m4a", "mp4", "aac", "flac", "ogg", "oga"];
async function chooseFile() {
  // Android: the Kotlin bridge owns the picker (ACTION_OPEN_DOCUMENT plus a cache copy —
  // Tauri's dialog plugin has no mobile file dialog, and content:// paths would not open
  // in the decode pipeline anyway). Elsewhere: the desktop dialog plugin.
  const viaBridge = await pickAudio();
  if (viaBridge !== null) {
    session.filePath.value = viaBridge;
    return;
  }
  if (droid) return; // user backed out of the system picker — do not open a second dialog
  const picked = await openDialog({ multiple: false, directory: false, filters: [{ name: "Audio", extensions: AUDIO_EXT }] });
  if (typeof picked === "string") session.filePath.value = picked;
}
watch(session.sourceKind, (k) => {
  if (k === "file" && !session.filePath.value) void chooseFile();
});

/* ---------- theme cycle: follow system -> light -> dark ---------- */
function cycleTheme() {
  settings.theme = settings.theme === "system" ? "light" : settings.theme === "light" ? "dark" : "system";
}
const themeLabel = computed(() =>
  `${t("theme")} · ${settings.theme === "system" ? t("themeSystem") : settings.theme === "light" ? t("themeLight") : t("themeDark")}`,
);

/* ---------- language card ---------- */
function swap() {
  if (settings.sourceLang === "auto" || session.sourceMode.value === "detected") {
    toast(t("swapAuto"));
    return;
  }
  [settings.sourceLang, settings.targetLang] = [settings.targetLang, settings.sourceLang];
}

/* ---------- stream pin-to-bottom lives inside StreamList ---------- */

function toggleSub() { drawer.value = "overlay"; }
async function toggleOverlay() {
  try {
    refreshNative();
    if (!native.granted) { pendingOverlay = true; requestOverlay(); return; }
    if (!localStorage.getItem("overlay-configured")) {
      settings.sub.locked = false;
      localStorage.setItem("overlay-configured", "1");
    }
    syncOverlay();
    await showOverlay(!native.visible);
    settings.sub.show = native.visible;
  } catch (e) { toast(String(e)); }
}
function syncOverlay() {
  const active = current.source || current.sourceStash || current.target || current.targetStash;
  const pair = active ? { source: current.source + current.sourceStash, target: current.target + current.targetStash } : lines.value[lines.value.length - 1];
  updateOverlay({ ...settings.sub, source: pair?.source ?? "", target: pair?.target ?? "",
    empty: emptyText.value, close: t("subHide"), resize: t("overlayWidth"),
    notification: t("captureNotification"), captureEnded: t("captureEnded") });
}
watch([() => settings.sub, current, lines, locale], syncOverlay, { deep: true });
function toggleFace() {
  mode.value = mode.value === "face" ? "normal" : "face";
  // Face-to-face only makes sense where the protocol speaks both ways; entering it turns
  // two-way on if the API can (the picker rule keeps zh/en as the pair).
  if (mode.value === "face" && PROTOCOLS[settings.protocol].twoWay) settings.twoWay = true;
}

/** Speak-aloud honours the same block list as the desktop (target language the model
 *  refuses, etc.): turning it on when it cannot work explains why instead of going mute. */
function toggleSpeak() {
  if (!settings.speak && session.speakBlocked.value) {
    toast(t(session.speakBlocked.value));
    return;
  }
  settings.speak = !settings.speak;
}

/** Ask from the permission centre: on a permanent denial the same guide the start button
 *  uses, otherwise just the system dialog. */
async function askFromCenter() {
  const s = await askMic();
  if (s === "permanent") guideOpen.value = true;
  else if (s === "denied") toast(t("permDeniedToast"));
}
</script>

<template>
  <div class="ambient"><i /></div>

  <div class="phone">
    <div v-if="bootError" class="boot-error" role="alert">
      <b>{{ t("startupFailed") }}</b>
      <small>{{ bootError }}</small>
      <button class="ghost" @click="reload">{{ t("retryStartup") }}</button>
    </div>
    <!-- ══ HOME / RUN ══ -->
    <div v-show="page === 'home'" class="page">
      <header class="topbar">
        <button class="brand" :aria-label="t('about')" @click="drawer = 'about'">
          <img class="mark" :src="mark" alt="ReaLingo" />
          <span class="brand-col">
            <strong>{{ t("appTitle") }}</strong>
            <small>{{ modelLine }}</small>
          </span>
        </button>
        <span class="spacer" />
        <!-- Narrow screens drop the label and keep the icon: the source always has a
             distinct glyph, so no text is needed to tell the three states apart. -->
        <button class="pill" :aria-label="t('srcTitle')" @click="drawer = 'src'">
          <Icon v-if="session.sourceKind.value === 'mic'" name="mic" :size="16" />
          <svg v-else-if="session.sourceKind.value === 'system'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.5 6.5 8H3v8h3.5L11 19.5z"/><path d="M15 8.6a4.6 4.6 0 0 1 0 6.8"/></svg>
          <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H14l5 5v10.5A2.5 2.5 0 0 1 16.5 21h-10A2.5 2.5 0 0 1 4 18.5z"/><path d="M13.5 3.2V8.5H19"/></svg>
          <span class="tx">{{ srcLabel }}</span>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-linecap="round"><path d="m4 6 4 4 4-4"/></svg>
        </button>
        <button class="icobtn xs" :aria-label="themeLabel" @click="cycleTheme">
          <svg v-if="settings.theme === 'system'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7"/></svg>
          <svg v-else-if="settings.theme === 'light'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.2A8.2 8.2 0 0 1 10.8 4 7.6 7.6 0 1 0 20 13.2z"/></svg>
        </button>
        <button class="icobtn xs" :aria-label="t('settings')" @click="page = 'settings'">
          <Icon name="settings" :size="19" />
          <em v-if="bad.length" class="dot" />
        </button>
      </header>

      <!-- language card: same slot idle and running (design rule), target is the protagonist -->
      <div class="langcard glass-thin">
        <button class="side" @click="drawer = 'lang'">
          <span class="cap">{{ t("from") }}</span>
          <span class="val dim">{{ settings.sourceLang === "auto" || session.sourceMode.value === "detected" ? langName("auto", locale) : langName(settings.sourceLang, locale) }}</span>
        </button>
        <button class="swap" :aria-label="t('swap')" :disabled="session.sourceMode.value === 'detected'" @click="swap">
          <Icon name="swap" :size="19" />
        </button>
        <button class="side right" @click="drawer = 'lang'">
          <span class="cap">{{ t("to") }}</span>
          <span class="val strong">{{ langName(settings.targetLang, locale) }}</span>
        </button>
      </div>

      <!-- stream -->
      <div class="stream-card glass" :class="{ face: mode === 'face', big: mode === 'big' }">
        <div class="stream-head">
          <span class="dotstat" :class="{ ok: running }" />
          <span class="st" :class="{ ok: status === 'connected' }">{{ t(session.statusKey.value) }}</span>
          <span v-if="fileProgress" class="meta">
            {{ fileProgress.total ? `${Math.round((fileProgress.sent / fileProgress.total) * 100)}%` : "…" }}
          </span>
          <span class="spacer" />
          <button v-if="lines.length" class="exp" @click="exportRows('txt')">{{ t("exportTxt") }}</button>
          <button v-if="lines.length" class="exp" @click="exportRows('srt')">{{ t("exportSrt") }}</button>
          <button class="exp" @click="lines = []">{{ t("clear") }}</button>
        </div>
        <div class="stream-half top">
          <StreamList :lines="lines" :empty="emptyText" :big="mode === 'big'" />
        </div>
        <!-- face-to-face: the lower half turns 180° toward the person opposite -->
        <div v-if="mode === 'face'" class="stream-half bottom">
          <div class="flip">
            <div class="mini-head">{{ langName(settings.targetLang, locale) }}</div>
            <StreamList :lines="lines" big />
          </div>
        </div>
      </div>

      <p v-if="errorMsg" class="err-line" role="alert" :aria-label="errorMsg">{{ errorMsg }}</p>
      <p v-else-if="warnMsg" class="warn-line" role="status" :aria-label="warnMsg">{{ warnMsg }}</p>

      <!-- dock -->
      <footer class="dock">
        <button class="icobtn" :class="{ on: native.visible }" :aria-label="t('subTitle')" @click="toggleSub">
          <svg width="19" height="19" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="1.5" y="3" width="13" height="10" rx="2.4"/><path d="M4.5 9.4h4M4.5 6.8h7"/></svg>
        </button>
        <button v-if="PROTOCOLS[settings.protocol].twoWay" class="icobtn" :class="{ on: mode === 'face' }" :aria-label="t('faceMode')" :title="t('faceModeHint')" @click="toggleFace">
          <svg width="19" height="19" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5v13M8 5 5.5 2.5M8 5l2.5-2.5M8 11 5.5 13.5M8 11l2.5 2.5"/></svg>
        </button>
        <button class="icobtn" :class="{ on: settings.speak }" :aria-label="t('speak')" @click="toggleSpeak">
          <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.5 7 8H4v4h3l4 3.5z"/><path d="M14 7.6a3.4 3.4 0 0 1 0 4.8"/></svg>
        </button>
        <button class="go" :class="{ running }" :disabled="status === 'stopping'" @click="running ? stop() : start()">
          <span class="go-ring" />
          <svg v-if="!running" width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.6v10.8L13 8z"/></svg>
          <svg v-else width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="2"/></svg>
          {{ status === 'stopping' ? t("statusStopping") : running ? t("stop") : t("start") }}
        </button>
      </footer>

      <!-- big mode dismiss: a tap anywhere on the full-screen layer exits it -->
      <button v-if="mode === 'big'" class="big-exit" @click="mode = 'normal'">{{ t("exitMode") }}</button>
    </div>

    <!-- ══ SETTINGS ══ -->
    <div v-show="page === 'settings'" class="page sub">
      <header class="topbar">
        <button class="icobtn sm" :aria-label="t('back')" @click="page = 'home'">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>
        </button>
        <div class="pt">
          <div class="pt1">{{ t("settings") }}</div>
          <div class="pt2">{{ t("platformAndroid") }}</div>
        </div>
      </header>

      <div class="settings-scroll">
        <button v-if="bad.length" class="checkbar" :class="perms.mic === 'permanent' ? 'red' : 'yellow'" @click="page = 'perms'">
          <span class="tx">
            <b>{{ tf("cbTitle", { n: bad.length }) }}</b>
            <small>{{ tf("cbSubBad", { list: bad.map((b) => t(b === "mic" ? "pmMic" : "pmBattery")).join(" · ") }) }}</small>
          </span>
          <span class="fix">{{ t("cbGo") }}</span>
        </button>

        <section>
          <span class="glabel">{{ t("groupConn") }}</span>
          <div class="rows">
            <button class="rowbtn" @click="drawer = 'model'">
              <span class="rt"><b>{{ t("protocol") }}</b><small>{{ t("ifaceSub") }}</small></span>
              <span class="rv">{{ modelName(settings.protocol, PRESETS[settings.protocol][0].id) }}</span>
            </button>
            <button class="rowbtn" @click="drawer = 'model'">
              <span class="rt"><b>{{ t("model") }}</b><small class="mono">{{ settings.model }}</small></span>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--ink-3)" stroke-width="1.8" stroke-linecap="round"><path d="m6 4 4 4-4 4"/></svg>
            </button>
            <label class="connection-field">
              <b>{{ t("apiKey") }}</b>
              <input v-model.trim="apiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="running" />
              <small>{{ keyringOk ? t("apiKeyHint") : t("apiKeyPlain") }}</small>
            </label>
            <label v-if="PROTOCOLS[settings.protocol].vendor === 'qwen'" class="connection-field">
              <b>{{ t("region") }}</b><select v-model="settings.region" :disabled="running"><option value="beijing">{{ t("regionBJ") }}</option><option value="singapore">{{ t("regionSG") }}</option></select>
            </label>
            <label v-if="PROTOCOLS[settings.protocol].vendor === 'qwen'" class="connection-field">
              <b>{{ t("workspace") }}</b><input v-model.trim="settings.workspaceId" :disabled="running" spellcheck="false" autocapitalize="off" /><small>{{ t("workspaceHint") }}</small>
            </label>
            <label class="connection-field">
              <b>{{ t("url") }}</b>
              <input v-model.trim="settings.url" type="url" placeholder="wss://…" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="running" />
              <small>{{ PROTOCOLS[settings.protocol].urlAsIs ? t("urlHintAsIs") : t("urlHint") }}</small>
            </label>
          </div>
        </section>

        <section>
          <span class="glabel">{{ t("groupPerm") }}</span>
          <div class="rows">
            <button class="rowbtn" @click="page = 'perms'">
              <span class="rt"><b>{{ t("permCenter") }}</b><small>{{ t("permCenterSub") }}</small></span>
              <span class="statpill" :class="bad.length ? (perms.mic === 'permanent' ? 'r' : 'y') : 'g'">
                {{ bad.length ? tf("permPending", { n: bad.length }) : t("permAllOk") }}
              </span>
            </button>
            <label class="rowbtn noscroll">
              <span class="rt"><b>{{ t("keepScreen") }}</b><small>{{ t("keepScreenSub") }}</small></span>
              <button class="sw" :class="{ on: settings.keepScreenOn }" @click.prevent="settings.keepScreenOn = !settings.keepScreenOn" />
            </label>
          </div>
        </section>

        <section>
          <span class="glabel">{{ t("groupTranslate") }}</span>
          <div class="rows">
            <div v-if="PROTOCOLS[settings.protocol].vendor === 'qwen'" class="connection-field"><Hotwords /></div>
            <label class="rowbtn"><span class="rt"><b>{{ t("speak") }}</b></span><button class="sw" :class="{ on: settings.speak }" :disabled="running" @click.prevent="toggleSpeak" /></label>
            <label v-if="session.voiceList.value" class="connection-field"><b>{{ t("voice") }}</b><select v-model="settings.voice" :disabled="running"><option v-for="v in session.voiceOptions.value" :key="v.value" :value="v.value">{{ v.label }}</option></select></label>
            <small v-else>{{ t("voiceServer") }}</small>
            <button class="rowbtn" @click="drawer = 'overlay'"><span class="rt"><b>{{ t("subTitle") }}</b></span></button>
            <label class="connection-field"><b>{{ t("subSrcSize") }} · {{ settings.stream.srcSize }}</b><input v-model.number="settings.stream.srcSize" type="range" :min="STREAM_SIZE.min" :max="STREAM_SIZE.max" /></label>
            <label class="connection-field"><b>{{ t("subTgtSize") }} · {{ settings.stream.tgtSize }}</b><input v-model.number="settings.stream.tgtSize" type="range" :min="STREAM_SIZE.min" :max="STREAM_SIZE.max" /></label>
            <label v-if="PROTOCOLS[settings.protocol].twoWay" class="rowbtn noscroll">
              <span class="rt"><b>{{ t("twoWay") }}</b><small>{{ t("twoWayHint") }}</small></span>
              <button class="sw" :class="{ on: settings.twoWay }" :disabled="running" @click.prevent="settings.twoWay = !settings.twoWay" />
            </label>
          </div>
        </section>

        <section>
          <span class="glabel">{{ t("groupData") }}</span>
          <div class="rows">
            <label class="rowbtn noscroll">
              <span class="rt"><b>{{ t("history") }}</b><small>{{ t("historyHint") }}</small></span>
              <button class="sw" :class="{ on: settings.history }" @click.prevent="settings.history = !settings.history" />
            </label>
            <button class="rowbtn" @click="drawer = 'history'"><span class="rt"><b>{{ t("history") }}</b></span></button>
            <button class="rowbtn" @click="drawer = 'uilang'">
              <span class="rt"><b>{{ t("uiLang") }}</b></span>
              <span class="rv">{{ settings.uiLang === "system" ? t("uiSystem") : settings.uiLang === "zh" ? "简体中文" : "English" }}</span>
            </button>
            <button class="rowbtn" @click="cycleTheme">
              <span class="rt"><b>{{ t("theme") }}</b><small>{{ t("themeSub") }}</small></span>
              <span class="rv">{{ settings.theme === "system" ? t("themeSystem") : settings.theme === "light" ? t("themeLight") : t("themeDark") }}</span>
            </button>
          </div>
        </section>

        <section>
          <div class="rows">
            <button class="rowbtn" @click="drawer = 'diagnostics'"><span class="rt"><b>{{ t("diagnostics") }}</b></span></button>
            <button class="rowbtn" @click="drawer = 'about'">
              <span class="rt"><b>{{ t("about") }}</b></span>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--ink-3)" stroke-width="1.8" stroke-linecap="round"><path d="m6 4 4 4-4 4"/></svg>
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- ══ PERMISSION CENTER ══ -->
    <div v-show="page === 'perms'" class="page sub">
      <header class="topbar">
        <button class="icobtn sm" :aria-label="t('back')" @click="page = 'settings'">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>
        </button>
        <div class="pt">
          <div class="pt1">{{ t("permCenter") }}</div>
          <div class="pt2">{{ tf("permSum", { ok: 3 - bad.length, bad: bad.length }) }}</div>
        </div>
      </header>

      <div class="settings-scroll">
        <div class="card" :class="{ alert: perms.mic === 'permanent' }">
          <div class="card-row">
            <span class="tint" :class="{ g: perms.mic === 'granted', r: perms.mic === 'permanent' }">
              <Icon name="mic" :size="19" />
            </span>
            <span class="tx"><b>{{ t("pmMic") }} <em class="badge r">{{ t("pmMust") }}</em></b><small>{{ perms.mic === "permanent" ? t("micSubPerm") : perms.mic === "denied" ? t("micSubDenied") : t("micSub") }}</small></span>
            <span class="state" :class="{ g: perms.mic === 'granted', r: perms.mic === 'permanent', d: perms.mic === 'denied' }">
              {{ t(({ granted: "pmGranted", denied: "pmDenied", permanent: "pmPermanent", unset: "pmUnset" } as const)[perms.mic]) }}
            </span>
          </div>
          <div v-if="perms.mic !== 'granted'" class="actions">
            <button v-if="perms.mic === 'permanent'" class="go danger" @click="openAppSettings(false)">{{ t("pmOpenSet") }}</button>
            <button v-else class="go half" @click="askFromCenter">{{ t("pmAsk") }}</button>
            <button v-if="perms.mic === 'permanent'" class="ghost" @click="askMic()">{{ t("pmReask") }}</button>
          </div>
        </div>

        <div class="card flat">
          <span class="tint g"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg></span>
          <span class="tx"><b>{{ t("pmNotif") }}</b><small>{{ t("pmNotifSub") }}</small></span>
          <span class="statpill g">{{ perms.notif ? t("pmOn") : t("pmUnset") }}</span>
        </div>

        <div class="card flat">
          <span class="tint" :class="perms.battery ? 'g' : 'o'"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="17" height="10" rx="2.6"/><path d="M21.5 10.5v3"/><path d="M11.5 9.5 9 12.5h3L9.5 15"/></svg></span>
          <span class="tx"><b>{{ t("pmBattery") }}</b><small>{{ t("pmBatterySub") }}</small></span>
          <button v-if="!perms.battery" class="chipm warn" @click="openBatterySettings">{{ t("pmGo") }}</button>
          <span v-else class="statpill g">{{ t("pmOn") }}</span>
        </div>

        <div class="card flat">
          <span class="tx"><b>{{ t("subTitle") }}</b><small>{{ t("overlayHint") }}</small></span>
          <button class="chipm warn" @click="drawer = 'overlay'">{{ native.granted ? t("subTitle") : t("overlayAuthorize") }}</button>
        </div>
        <p class="hintx center">{{ t("permRecheck") }}</p>
      </div>
    </div>

    <!-- ══ drawers ══ -->
    <DiagnosticsSheet v-if="drawer === 'diagnostics'" @close="drawer = null" />
    <History v-if="drawer === 'history'" @close="drawer = null" />
    <OverlaySheet v-if="drawer === 'overlay'" @close="drawer = null" @toggle="toggleOverlay" @fullscreen="drawer = null; mode = 'big'" />
    <SourceSheet v-if="drawer === 'src'" @close="drawer = null" />
    <LangSheet v-if="drawer === 'lang'" @close="drawer = null" />
    <ModelSheet v-if="drawer === 'model'" :running="running" @close="drawer = null" @restart="restartNow" />
    <AboutSheet v-if="drawer === 'about'" @close="drawer = null" />
    <UiLangSheet v-if="drawer === 'uilang'" @close="drawer = null" />

    <!-- ══ permanent-denial guide (the only in-app permission dialog, by design) ══ -->
    <div v-if="guideOpen" class="guide-bg" @click.self="guideOpen = false">
      <div class="guide glass">
        <span class="guide-ic">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3v11"/><path d="M8 7a4 4 0 0 0 8 0"/><path d="M5.5 12.5A6.5 6.5 0 0 0 12 19a6.5 6.5 0 0 0 6.5-6.5"/><path d="M4 4l16 16"/></svg>
        </span>
        <h3>{{ t("guideTitle") }}</h3>
        <p class="gd-sub">{{ t("guideSub") }}</p>
        <p class="gd-path">{{ t("guidePath") }}</p>
        <button class="go gd" @click="guideToSettings">{{ t("guideOpen") }}</button>
        <button class="ghost gd" @click="guideUseFile">{{ t("guideFile") }}</button>
        <button class="plain" @click="guideOpen = false">{{ t("guideLater") }}</button>
      </div>
    </div>

    <Toaster />
  </div>
</template>

<style scoped>
.phone {
  position: relative; z-index: 1; height: 100%;
  padding: max(10px, env(safe-area-inset-top)) 16px calc(10px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column;
  color: var(--ink);
}
.page { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 12px; }
.page.sub { gap: 6px; }

/* ---------- topbar ---------- */
.topbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 0 2px; }
.brand { display: flex; align-items: center; gap: 8px; text-align: left; padding: 2px 4px; border-radius: 8px; }
.brand .mark { width: 34px; height: 34px; flex: none; object-fit: contain; }
.boot-error { position: absolute; inset: 0; z-index: 150; padding: 28px; display: flex; flex-direction: column; justify-content: center; gap: 16px; background: var(--canvas); }
.boot-error small { overflow-wrap: anywhere; color: var(--ink-2); }
.brand-col { display: flex; flex-direction: column; line-height: 1.18; }
.brand-col strong { font-size: 13px; font-weight: 730; letter-spacing: -0.022em; }
.brand-col small { font-size: 10px; color: var(--ink-3); font-weight: 600; }
.pill {
  position: relative; height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px;
  border-radius: 999px; background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
  font-size: 12px; font-weight: 680; color: var(--ink-2);
}
.spacer { flex: 1; }

/* Topbar icon buttons share the pill's height so the row stays one line tall. */
.icobtn.xs {
  position: relative; width: 32px; height: 32px; flex: none; border-radius: 999px;
  display: grid; place-items: center; background: var(--shade); color: var(--ink-2);
  box-shadow: inset 0 0 0 1px var(--hairline);
}
.icobtn.xs .dot { position: absolute; top: -2px; right: -2px; width: 9px; height: 9px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 0 2px var(--canvas); }

/* Narrow phones (SE-classic 320 px, desktop subtitle windows on a phone-size view):
   the source pill folds to icon + chevron, the label gives way to space. */
@media (max-width: 360px) {
  .pill .tx { display: none; }
  .pill { padding: 0 9px; }
}

/* ---------- language card ---------- */
.langcard { flex: none; border-radius: 20px; padding: 6px 7px; display: flex; align-items: center; gap: 2px; }
.langcard .side { flex: 1; min-width: 0; padding: 8px 10px; border-radius: 14px; text-align: left; }
.langcard .side.right { text-align: right; }
.cap { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.val { display: block; margin-top: 3px; font-size: 15px; font-weight: 600; letter-spacing: -0.015em; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.val.dim { color: var(--ink-3); }
.val.strong { font-size: 17px; font-weight: 730; letter-spacing: -0.02em; color: var(--ink); }
.swap { width: 34px; height: 34px; flex: none; border-radius: 11px; display: grid; place-items: center; color: var(--ink-3); }
.swap:disabled { opacity: 0.35; }

/* ---------- stream ---------- */
.stream-card { flex: 1; min-height: 0; border-radius: 26px; display: flex; flex-direction: column; overflow: hidden; }
.stream-card.face { border-radius: 0; }
.stream-head { flex: none; padding: 14px 18px 10px; display: flex; align-items: center; gap: 9px; }
.dotstat { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); flex: none; }
.dotstat.ok { background: var(--ok); box-shadow: 0 0 9px var(--ok); }
.st { font-size: 12.5px; font-weight: 700; }
.st.ok { color: var(--ok); }
.meta { font-size: 11.5px; color: var(--ink-3); font-weight: 600; font-family: ui-monospace, monospace; }
.exp { font-size: 11px; font-weight: 650; color: var(--ink-3); padding: 4px 8px; border-radius: 8px; }
.stream-half { flex: 1; min-height: 0; display: flex; }
.stream-half.bottom { border-top: 1px solid var(--hairline); }
.flip { flex: 1; min-height: 0; display: flex; flex-direction: column; transform: rotate(180deg); }
.mini-head { padding: 8px 18px 0; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); }
.stream-card.big { position: absolute; inset: 0; z-index: 20; border-radius: 0; }

.err-line, .warn-line { flex: none; margin: 0; text-align: center; font-size: 12px; font-weight: 600; line-height: 1.45; }
.err-line { color: var(--danger); user-select: text; }
.warn-line { color: #b7791f; }

/* ---------- dock ---------- */
.dock { flex: none; display: flex; gap: 10px; align-items: center; }
.icobtn { width: 46px; height: 46px; flex: none; display: grid; place-items: center; border-radius: 15px; background: var(--shade); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--hairline); }
.icobtn.on { background: var(--accent); color: #fff; box-shadow: none; }
.icobtn.sm { width: 38px; height: 38px; border-radius: 12px; }
.go {
  position: relative; flex: 1; height: 56px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  font-size: 16px; font-weight: 720; color: #fff; letter-spacing: -0.01em;
  background: var(--accent-grad);
  box-shadow: 0 14px 34px -12px rgba(10, 132, 255, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.45);
}
.go.running { background: linear-gradient(135deg, #ff453a, #ff2d55); }
.go:disabled { opacity: 0.4; }
.go-ring { position: absolute; inset: -5px; border-radius: 999px; border: 2px solid currentColor; opacity: 0; pointer-events: none; }
.go.running .go-ring { animation: breathe 1.9s var(--ease) infinite; }
@keyframes breathe { 0% { opacity: 0.5; transform: scale(1); } 70%, 100% { opacity: 0; transform: scale(1.16); } }
.go.half { flex: 1; height: 40px; font-size: 13.5px; }
.go.danger { height: 40px; flex: 1; font-size: 13.5px; background: var(--danger); box-shadow: none; }
.go.gd { height: 48px; font-size: 15px; flex: none; width: 100%; }

.big-exit { position: absolute; top: 14px; right: 14px; z-index: 25; height: 34px; padding: 0 14px; border-radius: 999px; background: rgba(11, 13, 19, 0.6); color: #fff; font-size: 12.5px; font-weight: 700; }

/* ---------- settings ---------- */
.pt { flex: 1; }
.pt1 { font-size: 22px; font-weight: 730; letter-spacing: -0.03em; }
.pt2 { font-size: 11px; color: var(--ink-3); font-weight: 600; margin-top: 2px; }
.settings-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; padding-bottom: 8px; }
section { display: flex; flex-direction: column; }
.glabel { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin: 0 4px 8px; }
.rows { border-radius: 18px; background: var(--glass); box-shadow: inset 0 0 0 1px var(--hairline); padding: 0 15px; }
.connection-field { display: flex; flex-direction: column; gap: 8px; padding: 13px 0; border-top: 1px solid var(--hairline); }
.connection-field b { font-size: 14.5px; font-weight: 560; }
.connection-field select { padding: 10px; border-radius: 10px; background: var(--shade); color: var(--ink); font: inherit; }
.connection-field input { width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid var(--hairline); border-radius: 11px; background: var(--shade); color: var(--ink); font: inherit; font-size: 16px; }
.connection-field small { color: var(--ink-3); font-size: 11.5px; line-height: 1.45; }
.rowbtn { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 54px; padding: 8px 0; text-align: left; color: var(--ink); }
.rowbtn + .rowbtn { box-shadow: inset 0 1px 0 var(--hairline); }
.rowbtn .rt { flex: 1; min-width: 0; }
.rowbtn .rt b { display: block; font-size: 14.5px; font-weight: 560; }
.rowbtn .rt small { display: block; margin-top: 2px; font-size: 11.5px; color: var(--ink-3); line-height: 1.45; }
.rowbtn .rt small.mono { font-family: ui-monospace, monospace; word-break: break-all; }
.rowbtn .rv { font-size: 13px; color: var(--ink-3); font-weight: 550; }
.statpill { font-size: 10.5px; font-weight: 800; padding: 3px 9px; border-radius: 999px; }
.statpill.g { color: var(--ok); background: rgba(48, 209, 88, 0.14); }
.statpill.r { color: var(--danger); background: rgba(255, 69, 58, 0.15); }
.statpill.y { color: #b7791f; background: rgba(255, 214, 10, 0.15); }
.checkbar {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  border-radius: 18px; padding: 13px 15px;
}
.checkbar.yellow { background: rgba(255, 214, 10, 0.1); box-shadow: inset 0 0 0 1.2px rgba(255, 214, 10, 0.3); }
.checkbar.red { background: rgba(255, 69, 58, 0.12); box-shadow: inset 0 0 0 1.3px rgba(255, 69, 58, 0.42); }
.checkbar .tx { flex: 1; }
.checkbar b { display: block; font-size: 14.5px; font-weight: 700; color: var(--ink); }
.checkbar small { display: block; margin-top: 3px; font-size: 11.5px; line-height: 1.5; color: var(--ink-2); }
.checkbar .fix { flex: none; font-size: 12.5px; font-weight: 700; padding: 6px 13px; border-radius: 999px; background: var(--warn, #ffd60a); color: #1a1c22; }

/* ---------- permission center ---------- */
.card { border-radius: 18px; padding: 14px 15px; background: var(--glass); box-shadow: inset 0 0 0 1px var(--hairline); }
.card.flat { display: flex; align-items: center; gap: 11px; padding: 13px 15px; }
.card.alert { box-shadow: inset 0 0 0 1.3px rgba(255, 69, 58, 0.4); }
.card-row { display: flex; align-items: center; gap: 11px; }
.card .tx { flex: 1; }
.card .tx b { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 700; color: var(--ink); }
.card .tx small { display: block; margin-top: 3px; font-size: 11.5px; color: var(--ink-2); line-height: 1.5; }
.badge { font-style: normal; font-size: 10px; font-weight: 800; padding: 2.5px 8px; border-radius: 999px; }
.badge.r { color: var(--danger); background: rgba(255, 69, 58, 0.18); }
.state { font-size: 11.5px; font-weight: 800; }
.state.g { color: var(--ok); } .state.r { color: var(--danger); } .state.d { color: var(--ink-3); }
.tint { width: 31px; height: 31px; flex: none; border-radius: 10px; display: grid; place-items: center; background: rgba(10, 132, 255, 0.13); color: var(--accent); }
.tint.g { background: rgba(48, 209, 88, 0.14); color: var(--ok); }
.tint.r { background: rgba(255, 69, 58, 0.15); color: var(--danger); }
.tint.o { background: rgba(255, 214, 10, 0.15); color: #b7791f; }
.actions { margin-top: 12px; display: flex; gap: 8px; }
.chipm { height: 32px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 999px; font-size: 12.5px; font-weight: 650; }
.chipm.warn { background: var(--warn, #ffd60a); color: #1a1c22; }
.hintx { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--ink-3); }
.hintx.center { text-align: center; margin-top: 6px; }
.ghost { height: 40px; padding: 0 14px; border-radius: 13px; background: var(--shade); color: var(--ink-2); font-size: 13.5px; font-weight: 650; }
.plain { height: 34px; color: var(--ink-3); font-size: 13px; font-weight: 600; background: none; }
.gd { width: 100%; }

/* ---------- guide dialog ---------- */
.guide-bg { position: fixed; inset: 0; z-index: 120; background: rgba(6, 8, 14, 0.66); display: flex; align-items: center; justify-content: center; padding: 0 26px; }
.guide { width: 100%; max-width: 340px; border-radius: 28px; padding: 24px 22px 18px; display: flex; flex-direction: column; gap: 10px; }
.guide-ic { align-self: center; width: 54px; height: 54px; border-radius: 17px; background: rgba(255, 69, 58, 0.14); display: grid; place-items: center; color: var(--danger); }
.guide h3 { margin: 0; font-size: 19px; font-weight: 720; text-align: center; }
.gd-sub { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-2); text-align: center; }
.gd-path {
  margin: 4px 0; padding: 11px 13px; border-radius: 13px;
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
  font-size: 12px; font-weight: 600; color: var(--ink-2); text-align: center;
}
</style>
