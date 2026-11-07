<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

import SourceSheet from "./SourceSheet.vue";
import LangSheet from "./LangSheet.vue";
import ModelSheet from "./ModelSheet.vue";
import AboutSheet from "./AboutSheet.vue";
import UiLangSheet from "./UiLangSheet.vue";
import StreamList from "./StreamList.vue";
import Toaster from "./Toaster.vue";
import { session } from "../session";
import { loadCaps } from "../platform";
import { settings, activeKey, initSettings } from "../store";
import { PRESETS, PROTOCOLS, langName, modelName } from "../languages";
import { locale, t, tf } from "../i18n";
import { checkUpdateAtStartup } from "../update";
import { isRunning, lines, status, errorMsg, warnMsg, fileProgress, saveAs } from "../stream";
import { perms, refreshPerms, askMic, openAppSettings, openBatterySettings, pendingList, setKeepScreenOn } from "./perms";
import { toast } from "./toasts";

type Page = "home" | "settings" | "perms";
const page = ref<Page>("home");
type Drawer = null | "src" | "lang" | "model" | "about" | "uilang";
const drawer = ref<Drawer>(null);

/** Modes layered over the home layout: the room reads these, the hand does not. */
const mode = ref<"normal" | "face" | "big">("normal");

/* ---------- boot ---------- */
let levelTimer: number | undefined;

/** Coming back to the app re-checks permissions (the design's "改完不用重启") and fires a
 *  start the guide dialog promised. `tauri://resume` is mobile's lifecycle event;
 *  `visibilitychange` is the belt-and-braces fallback — whichever arrives first wins, and
 *  the guard inside keeps a double delivery from starting twice. */
async function onResume() {
  await refreshPerms();
  if (perms.pendingStart && perms.mic === "granted") {
    perms.pendingStart = false;
    void start();
  }
}

onMounted(async () => {
  void checkUpdateAtStartup();
  await initSettings();
  await loadCaps();
  await refreshPerms();
  await session.refreshDevices();
  levelTimer = window.setInterval(() => void session.pollLevel(), 120);
  void listen("tauri://resume", onResume);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void onResume();
  });
});
onUnmounted(() => window.clearInterval(levelTimer));

/* ---------- derived ---------- */
const running = computed(() => isRunning());
const srcLabel = computed(() => t({ mic: "srcMic", system: "srcSystem", file: "srcFile" }[session.sourceKind.value]));
const modelLine = computed(() => `${modelName(settings.protocol, settings.model)} · ${PRESETS[settings.protocol][0].langs} ${t("langsUnit")}`);
const bad = computed(() => pendingList());
const emptyText = computed(() => tf("streamEmptyPhone", { lang: langName(settings.targetLang, locale.value) }));

// Keep-screen-on follows the session, and only the user's switch: the native flag is a
// side effect of running, not of the page being open.
watch([running, () => settings.keepScreenOn], ([run, keep]) => setKeepScreenOn(run && keep), { immediate: true });

/* ---------- start / stop with the permission state machine ---------- */
async function start() {
  if (!activeKey().trim()) {
    toast(t("noKeyToast"), { label: t("goSettings"), run: () => (page.value = "settings") });
    return;
  }
  if (session.sourceKind.value === "mic" && perms.mic !== "granted") {
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
  await session.toggle();
  if (errorMsg.value) toast(errorMsg.value);
}

function stop() {
  void session.toggle();
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

// The desktop subtitle window has no phone counterpart yet (floating overlay is phase 2);
// the toggle in the dock opens the in-app full-screen mode instead.
function toggleSub() {
  mode.value = mode.value === "big" ? "normal" : "big";
}
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
    <!-- ══ HOME / RUN ══ -->
    <div v-show="page === 'home'" class="page">
      <header class="topbar">
        <button class="brand" :aria-label="t('about')" @click="drawer = 'about'">
          <span class="mark">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7M7.5 5v3M4 12h9M4 19h6"/><path d="M15 9l4.5 10M13.5 15h6"/></svg>
          </span>
          <span class="brand-col">
            <strong>{{ t("appTitle") }}</strong>
            <small @click.stop="drawer = 'model'">{{ modelLine }}</small>
          </span>
        </button>
        <span class="spacer" />
        <!-- Narrow screens drop the label and keep the icon: the source always has a
             distinct glyph, so no text is needed to tell the three states apart. -->
        <button class="pill" :aria-label="t('srcTitle')" @click="drawer = 'src'">
          <svg v-if="session.sourceKind.value === 'mic'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v11"/><path d="M8 7a4 4 0 0 0 8 0"/><path d="M5.5 12.5A6.5 6.5 0 0 0 12 19a6.5 6.5 0 0 0 6.5-6.5"/><path d="M12 19v2.5"/></svg>
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.4v2.8M12 18.8v2.8M2.4 12h2.8M18.8 12h2.8M5.2 5.2l2 2M16.8 16.8l2 2M18.8 5.2l-2 2M7.2 16.8l-2 2"/></svg>
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
          <svg width="16" height="16" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5v10M4 12.5L1.8 10.3M4 12.5l2.2-2.2M11 12.5v-10M11 2.5L8.8 4.7M11 2.5l2.2 2.2"/></svg>
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
          <span class="st" :class="{ ok: running }">{{ running ? t("statusListening") : t("statusIdle") }}</span>
          <span v-if="fileProgress" class="meta">
            {{ fileProgress.total ? `${Math.round((fileProgress.sent / fileProgress.total) * 100)}%` : "…" }}
          </span>
          <span class="spacer" />
          <button v-if="lines.length" class="exp" @click="saveAs('srt', lines)">{{ t("exportSrt") }}</button>
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

      <p v-if="errorMsg" class="err-line">{{ errorMsg }}</p>
      <p v-else-if="warnMsg" class="warn-line">{{ warnMsg }}</p>

      <!-- dock -->
      <footer class="dock">
        <button class="icobtn" :class="{ on: mode === 'big' }" :aria-label="t('fullscreenSub')" @click="toggleSub">
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
          {{ running ? t("stop") : t("start") }}
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
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v11"/><path d="M8 7a4 4 0 0 0 8 0"/><path d="M5.5 12.5A6.5 6.5 0 0 0 12 19a6.5 6.5 0 0 0 6.5-6.5"/><path d="M12 19v2.5"/></svg>
            </span>
            <span class="tx"><b>{{ t("pmMic") }} <em class="badge r">{{ t("pmMust") }}</em></b><small>{{ perms.mic === "permanent" ? t("micSubPerm") : perms.mic === "denied" ? t("micSubDenied") : t("micSub") }}</small></span>
            <span class="state" :class="{ g: perms.mic === 'granted', r: perms.mic === 'permanent', d: perms.mic === 'denied' }">
              {{ t({ granted: "pmGranted", denied: "pmDenied", permanent: "pmPermanent", unset: "pmUnset" }[perms.mic]) }}
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

        <p class="hintx center">{{ t("permRecheck") }}</p>
      </div>
    </div>

    <!-- ══ drawers ══ -->
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
.brand .mark { width: 26px; height: 26px; border-radius: 8px; background: var(--accent-grad); display: grid; place-items: center; box-shadow: 0 5px 14px -5px rgba(10, 132, 255, 0.95); }
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
.err-line { color: var(--danger); }
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
