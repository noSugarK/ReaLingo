<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import Card from "./components/Card.vue";
import Picker from "./components/Picker.vue";
import Slider from "./components/Slider.vue";
import Settings from "./components/Settings.vue";
import About from "./components/About.vue";
import History from "./components/History.vue";
import { locale, setLocale, t } from "./i18n";
import { langName, languageCodes } from "./languages";
import { check, checkUpdateAtStartup, openHome } from "./update";
import { settings, initSettings, resolvedTheme, type SubAlign, type SubMode, type SubtitleStyle } from "./store";
import {
  current,
  detectedLang,
  errorMsg,
  saveAs,
  fileProgress,
  isRunning,
  lines,
  rawLog,
  speaking,
  start,
  status,
  stop,
  warnMsg,
} from "./stream";

type SourceKind = "mic" | "system" | "file";

const win = getCurrentWindow();
const showSettings = ref(false);
const showAbout = ref(false);
const showHistory = ref(false);
const showDiag = ref(false);
const sourceKind = ref<SourceKind>("mic");
const devices = ref<{ id: string; name: string; loopback: boolean }[]>([]);
const deviceId = ref("");
const filePath = ref("");
const level = ref(0);
/** What the host OS can do; decides whether the "system audio" tab has real devices. */
const caps = ref({ os: "", loopback: true });
const streamEl = ref<HTMLElement | null>(null);

const maximized = ref(false);
/** The window draws its own rounded edge, which has to go flat when it fills the screen. */
async function syncMaximized() {
  maximized.value = await win.isMaximized();
  document.documentElement.toggleAttribute("data-maximized", maximized.value);
}
void win.onResized(syncMaximized);

const isDark = computed(() => resolvedTheme.value === "dark");
function cycleTheme() {
  settings.theme = isDark.value ? "light" : "dark";
}

const AUDIO_EXT = ["mp3", "wav", "m4a", "mp4", "aac", "flac", "ogg", "oga"];

// Where loopback is unavailable (Linux), the "system audio" tab still lists ordinary inputs:
// the user routes our recording stream to a monitor source outside the app.
const wantLoopback = computed(() => sourceKind.value === "system" && caps.value.loopback);
const visibleDevices = computed(() =>
  devices.value.filter((d) => d.loopback === wantLoopback.value)
);
const fileName = computed(() => filePath.value.split(/[\\/]/).pop() ?? "");
const deviceOptions = computed(() =>
  visibleDevices.value.map((d) => ({ value: d.id, label: d.name }))
);
const canStart = computed(() =>
  sourceKind.value === "file" ? !!filePath.value : !!deviceId.value
);

const statusKey = computed(() => {
  if (!settings.apiKey.trim()) return "statusNoKey" as const;
  if (status.value === "error") return "statusError" as const;
  if (status.value === "connecting") return "statusConnecting" as const;
  if (status.value === "connected") return speaking.value ? ("statusListening" as const) : ("statusConnected" as const);
  return "statusIdle" as const;
});

async function refreshDevices() {
  caps.value = await invoke("platform");
  devices.value = await invoke("list_devices");
  await pickDefaultDevice();
}

async function pickDefaultDevice() {
  if (sourceKind.value === "file") return;
  if (visibleDevices.value.some((d) => d.id === deviceId.value)) return;
  const preferred = await invoke<string | null>("default_device", {
    loopback: wantLoopback.value,
  });
  deviceId.value = preferred ?? visibleDevices.value[0]?.id ?? "";
}

watch(sourceKind, pickDefaultDevice);

async function chooseFile() {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Audio", extensions: AUDIO_EXT }],
  });
  if (typeof picked === "string") filePath.value = picked;
}

async function toggle() {
  if (isRunning()) {
    await stop();
    return;
  }
  if (!settings.apiKey.trim()) {
    showSettings.value = true;
    return;
  }
  await start(
    sourceKind.value === "file"
      ? { kind: "file", path: filePath.value }
      : { kind: "device", id: deviceId.value }
  );
}

/* ---------- subtitle overlay ---------- */
async function subtitleWindow() {
  return await WebviewWindow.getByLabel("subtitle");
}

async function pushOverlayStyle() {
  await emitTo("subtitle", "sub://style", JSON.parse(JSON.stringify(settings.sub)));
}

async function showOverlay(show: boolean) {
  const w = await subtitleWindow();
  if (!w) return;
  if (!show) return w.hide();
  await w.show();
  await setOverlayClickThrough(settings.sub.locked);
  await pushOverlayStyle();
  // An always-on-top overlay appearing must not pull focus away from the window the user
  // is actually clicking in.
  await win.setFocus();
}

async function setOverlayClickThrough(locked: boolean) {
  const w = await subtitleWindow();
  // A hidden window has no underlying GDK window on Linux, and the click-through call
  // unwraps it -> hard panic at startup. Only ever apply it to a window that is up;
  // showOverlay re-applies it right after show().
  if (!w || !(await w.isVisible())) return;
  await w.setIgnoreCursorEvents(locked);
}

// Styling is cheap to push on every tick; show/hide and click-through are window calls that
// must fire only on a real change. Dragging a slider used to re-`show()` an already visible
// always-on-top window dozens of times a second, which is what made focus feel broken.
// The overlay's own right-click menu. It cannot persist anything itself — settings live
// here — so it sends the change up and the watch below broadcasts the result back down.
void listen<Partial<SubtitleStyle>>("sub://patch", ({ payload }) => Object.assign(settings.sub, payload));

watch(() => settings.sub, pushOverlayStyle, { deep: true });
watch(() => settings.sub.show, showOverlay);
watch(() => settings.sub.locked, setOverlayClickThrough);

/* ---------- model / languages ---------- */
const langCodes = computed(() => languageCodes(settings.model));

/** The picker matches on both UI languages, so a zh user can still type "japanese". */
const langOptions = computed(() =>
  langCodes.value.map((c) => ({
    value: c,
    label: langName(c, locale.value),
    note: c,
    keywords: `${langName(c, "zh")} ${langName(c, "en")}`,
  }))
);
const sourceLangOptions = computed(() => [
  { value: "auto", label: langName("auto", locale.value) },
  ...langOptions.value,
]);

// Switching to the smaller model can strand a language it cannot translate into; the
// session would then be refused server-side, so repair the selection here instead.
watch(langCodes, (codes) => {
  const ok = new Set(codes);
  if (settings.sourceLang !== "auto" && !ok.has(settings.sourceLang)) settings.sourceLang = "auto";
  if (!ok.has(settings.targetLang)) settings.targetLang = ok.has("en") ? "en" : codes[0];
});

/** Stored 0–1, edited as whole percent — "0.53" in a number field reads badly. */
const subOpacityPct = computed({
  get: () => Math.round(settings.sub.opacity * 100),
  set: (v: number) => (settings.sub.opacity = v / 100),
});

/** The three bars of each icon, wide/short/wide, shifted to show the alignment. */
const subAligns: [SubAlign, "alignLeft" | "alignCenter" | "alignRight", string][] = [
  ["left", "alignLeft", "M2 4h12M2 8h7M2 12h12"],
  ["center", "alignCenter", "M2 4h12M4.5 8h7M2 12h12"],
  ["right", "alignRight", "M2 4h12M7 8h7M2 12h12"],
];

const subModes: [SubMode, "subBoth" | "subTarget" | "subSource"][] = [
  ["both", "subBoth"],
  ["target", "subTarget"],
  ["source", "subSource"],
];

/* ---------- system tray ---------- */
async function syncTray() {
  // Labels are sent from here because the zh/en dictionary lives in the frontend; Rust just
  // rebuilds the menu from whatever it is given.
  await invoke("sync_tray", {
    menuState: {
      tooltip: `ReaLingo · ${t(statusKey.value)}`,
      showLabel: t("trayShow"),
      runLabel: isRunning() ? t("stop") : t("start"),
      overlayLabel: t("subShow"),
      overlayOn: settings.sub.show,
      clickThroughLabel: t("subLockShort"),
      clickThroughOn: settings.sub.locked,
      modeLabel: t("subMode"),
      modes: subModes.map(([value, key]) => ({
        id: value,
        label: t(key),
        on: settings.sub.mode === value,
      })),
      quitLabel: t("trayQuit"),
    },
  });
}

void listen<string>("tray://action", ({ payload: id }) => {
  if (id === "run") void toggle();
  else if (id === "overlay") settings.sub.show = !settings.sub.show;
  else if (id === "click-through") settings.sub.locked = !settings.sub.locked;
  else if (id.startsWith("mode:")) settings.sub.mode = id.slice(5) as SubMode;
});

// Deliberately not watching `speaking`: it flips on every VAD tick and rebuilding a native
// menu that often is the same churn that broke focus for the overlay.
watch([locale, status, () => settings.sub], syncTray, { deep: true });

/* ---------- export ---------- */
const exportAs = (kind: "txt" | "srt") => saveAs(kind, lines.value);

/* ---------- lifecycle ---------- */
let levelTimer: number | undefined;

onMounted(async () => {
  // Fire and forget: the window must not wait on GitHub to finish painting.
  void checkUpdateAtStartup();
  await initSettings();
  await refreshDevices();
  await showOverlay(settings.sub.show);
  await syncTray();
  levelTimer = window.setInterval(async () => {
    level.value = isRunning() ? await invoke<number>("input_level") : 0;
  }, 60);
});

onUnmounted(() => window.clearInterval(levelTimer));

watch([lines, current], async () => {
  await nextTick();
  streamEl.value?.scrollTo({ top: streamEl.value.scrollHeight, behavior: "smooth" });
}, { deep: true });
</script>

<template>
  <div class="ambient"><i /></div>

  <div class="shell">
    <header class="titlebar" data-tauri-drag-region>
      <!-- Opens About rather than jumping straight to the browser: this sits inside the
           drag region, and a mis-aimed window drag should not launch a browser tab. The
           repository link lives one click away, in the sheet. -->
      <button class="brand" :title="t('about')" @click="showAbout = true">
        <img class="mark" src="./assets/mark.png" alt="" draggable="false" />
        <div class="brand-text">
          <strong>{{ t("appTitle") }}</strong>
          <small>{{ t("appSub") }}</small>
        </div>
      </button>

      <button
        v-if="check.state === 'found'"
        class="upd"
        :title="t('updFound') + ' ' + check.tag"
        @click="openHome"
      >
        {{ t("updFound") }} {{ check.tag }}
      </button>

      <div class="pill glass-thin" :class="status">
        <span class="dot" />
        {{ t(statusKey) }}
      </div>

      <div class="spacer" data-tauri-drag-region />

      <button class="btn-icon locale" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
        {{ locale === "zh" ? "中" : "EN" }}
      </button>
      <button class="btn-icon" :aria-label="t('theme')" @click="cycleTheme">
        <svg v-if="isDark" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.8 5.8 0 1 0 7 7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 1v1.7M8 13.3V15M15 8h-1.7M2.7 8H1M12.9 3.1l-1.2 1.2M4.3 11.7l-1.2 1.2M12.9 12.9l-1.2-1.2M4.3 4.3L3.1 3.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      <button class="btn-icon" :class="{ active: showDiag }" title="Raw events" @click="showDiag = !showDiag">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 3L2.5 8 6 13M10 3l3.5 5-3.5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="btn-icon" :aria-label="t('settings')" @click="showSettings = true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4.5h5M10 4.5h4M2 11.5h4M9 11.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <circle cx="8.6" cy="4.5" r="1.9" stroke="currentColor" stroke-width="1.6" />
          <circle cx="7.4" cy="11.5" r="1.9" stroke="currentColor" stroke-width="1.6" />
        </svg>
      </button>
      <div class="win-buttons">
        <button class="btn-icon" :title="t('toTray')" :aria-label="t('toTray')" @click="win.hide()">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M6.5 1v6.2M6.5 7.4L4.1 5M6.5 7.4L8.9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M1.6 9.8v1.1a1 1 0 0 0 1 1h7.8a1 1 0 0 0 1-1V9.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
        <button class="btn-icon" aria-label="Minimize" @click="win.minimize()">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
        <button
          class="btn-icon"
          :aria-label="maximized ? t('restore') : t('maximize')"
          :title="maximized ? t('restore') : t('maximize')"
          @click="win.toggleMaximize()"
        >
          <svg v-if="maximized" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1.5" y="3.5" width="7" height="7" rx="1.4" stroke="currentColor" stroke-width="1.3" />
            <path d="M4 3.2V2.9a1.4 1.4 0 0 1 1.4-1.4h4.2A1.4 1.4 0 0 1 11 2.9v4.2A1.4 1.4 0 0 1 9.6 8.5h-.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1.5" y="1.5" width="9" height="9" rx="1.6" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
        <button class="btn-icon danger" aria-label="Close" @click="win.close()">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      </div>
    </header>

    <main class="grid">
      <aside class="side">
        <div class="side-scroll">
          <!-- audio source -->
          <Card :title="t('srcTitle')">
            <div class="seg">
              <button :class="{ on: sourceKind === 'mic' }" @click="sourceKind = 'mic'">{{ t("srcMic") }}</button>
              <button :class="{ on: sourceKind === 'system' }" @click="sourceKind = 'system'">{{ t("srcSystem") }}</button>
              <button :class="{ on: sourceKind === 'file' }" @click="sourceKind = 'file'">{{ t("srcFile") }}</button>
            </div>

            <template v-if="sourceKind !== 'file'">
              <div class="row">
                <Picker
                  v-model="deviceId"
                  :options="deviceOptions"
                  :placeholder="t('noDevice')"
                  :disabled="isRunning()"
                />
                <button class="btn-icon" :aria-label="t('device')" @click="refreshDevices">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                    <path d="M13 7.5a5.5 5.5 0 1 1-1.7-3.9M13 1.5V5H9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
              <div class="meter" :title="t('level')">
                <i :style="{ transform: `scaleX(${Math.min(1, level * 1.6)})` }" />
              </div>
              <p v-if="sourceKind === 'system' && !caps.loopback" class="hint notice">
                {{ caps.os === "macos" ? t("loopbackMacOld") : t("loopbackLinux") }}
              </p>
            </template>

            <template v-else>
              <button class="btn drop" :disabled="isRunning()" @click="chooseFile">
                <span v-if="fileName" class="fname">{{ fileName }}</span>
                <span v-else>{{ t("pickFile") }}</span>
              </button>
              <small class="hint">{{ t("fileFormats") }}</small>
              <div v-if="fileProgress" class="meter">
                <i :style="{ transform: `scaleX(${fileProgress.total ? fileProgress.sent / fileProgress.total : 0.5})` }" />
              </div>
            </template>
          </Card>

          <!-- languages -->
          <Card :title="t('langTitle')">
            <div class="langs">
              <div class="col grow">
                <span class="mini">
                  {{ t("from") }}
                  <em v-if="settings.sourceLang === 'auto' && detectedLang" class="detected">
                    {{ langName(detectedLang, locale) }}
                  </em>
                </span>
                <Picker v-model="settings.sourceLang" :options="sourceLangOptions" :disabled="isRunning()" />
              </div>
              <button
                class="btn-icon swap"
                :aria-label="t('swap')"
                :disabled="settings.sourceLang === 'auto' || isRunning()"
                @click="[settings.sourceLang, settings.targetLang] = [settings.targetLang, settings.sourceLang]"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path d="M4 2.5v10M4 12.5L1.8 10.3M4 12.5l2.2-2.2M11 12.5v-10M11 2.5L8.8 4.7M11 2.5l2.2 2.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div class="col grow">
                <span class="mini">{{ t("to") }}</span>
                <Picker v-model="settings.targetLang" :options="langOptions" :disabled="isRunning()" />
              </div>
            </div>
          </Card>

          <!-- subtitle overlay -->
          <Card :title="t('subTitle')">
            <label class="line">
              <span>{{ t("subShow") }}</span>
              <button class="sw" :class="{ on: settings.sub.show }" @click="settings.sub.show = !settings.sub.show" />
            </label>

            <div class="seg">
              <button
                v-for="[value, key] in subModes"
                :key="value"
                :class="{ on: settings.sub.mode === value }"
                @click="settings.sub.mode = value"
              >
                {{ t(key) }}
              </button>
            </div>

            <div class="line">
              <span>{{ t("subOpacity") }}</span>
              <Slider v-model="subOpacityPct" :min="0" :max="100" :step="1" unit="%" />
            </div>

            <div class="line">
              <span>{{ t("subFontSize") }}</span>
              <Slider v-model="settings.sub.fontSize" :min="14" :max="72" :step="1" unit="px" />
            </div>

            <div class="line">
              <span>{{ t("subColors") }}</span>
              <div class="row">
                <input v-model="settings.sub.color" type="color" :title="t('subColor')" />
                <input v-model="settings.sub.srcColor" type="color" :title="t('subSrcColor')" />
              </div>
            </div>

            <div class="line">
              <span>{{ t("subAlign") }}</span>
              <div class="seg icons">
                <button
                  v-for="[value, key, d] in subAligns"
                  :key="value"
                  :class="{ on: settings.sub.align === value }"
                  :title="t(key)"
                  :aria-label="t(key)"
                  @click="settings.sub.align = value"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                    <path :d="d" />
                  </svg>
                </button>
              </div>
            </div>

            <div class="line">
              <span>{{ t("subHeight") }}</span>
              <div class="seg">
                <button :class="{ on: settings.sub.grow }" @click="settings.sub.grow = true">{{ t("subGrow") }}</button>
                <button :class="{ on: !settings.sub.grow }" @click="settings.sub.grow = false">{{ t("subTicker") }}</button>
              </div>
            </div>

            <div class="pair">
              <label class="line">
                <span>{{ t("subOutline") }}</span>
                <button class="sw" :class="{ on: settings.sub.outline }" @click="settings.sub.outline = !settings.sub.outline" />
              </label>
              <label class="line">
                <span>{{ t("subLockShort") }}</span>
                <button class="sw" :class="{ on: settings.sub.locked }" @click="settings.sub.locked = !settings.sub.locked" />
              </label>
            </div>
          </Card>
        </div>

        <footer class="dock">
          <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
          <p v-else-if="warnMsg" class="warn">{{ warnMsg }}</p>
          <button
            class="go"
            :class="{ running: isRunning() }"
            :disabled="!canStart && !isRunning()"
            @click="toggle"
          >
            <span class="go-ring" />
            <svg v-if="!isRunning()" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.6v10.8L13 8z" /></svg>
            <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="2" /></svg>
            {{ isRunning() ? t("stop") : t("start") }}
          </button>
        </footer>
      </aside>

      <!-- translation stream -->
      <Card class="stream-card" :title="t('streamTitle')" flush>
        <template #action>
          <div class="row">
            <button
              class="sw sm"
              :class="{ on: settings.history }"
              :title="t('historyHint')"
              :aria-label="t('historyRec')"
              @click="settings.history = !settings.history"
            />
            <button class="chip" @click="showHistory = true">{{ t("history") }}</button>
            <button class="chip" :disabled="!lines.length" @click="lines = []">{{ t("clear") }}</button>
            <button class="chip" :disabled="!lines.length" @click="exportAs('txt')">{{ t("exportTxt") }}</button>
            <button class="chip" :disabled="!lines.length" @click="exportAs('srt')">{{ t("exportSrt") }}</button>
          </div>
        </template>

        <div ref="streamEl" class="stream">
          <p v-if="!lines.length && !current.target && !current.source" class="empty">{{ t("streamEmpty") }}</p>

          <article v-for="l in lines" :key="l.id" class="line-item">
            <p v-if="l.source" class="src">{{ l.source }}</p>
            <p class="tgt">{{ l.target }}</p>
          </article>

          <article
            v-if="current.source || current.target || current.sourceStash || current.targetStash"
            class="line-item live"
          >
            <p v-if="current.source || current.sourceStash" class="src">
              {{ current.source }}<span class="stash">{{ current.sourceStash }}</span>
            </p>
            <p class="tgt">
              {{ current.target }}<span class="stash">{{ current.targetStash }}</span><span class="caret" />
            </p>
          </article>
        </div>

        <div v-if="showDiag" class="diag">
          <div class="diag-head">rt://raw · {{ rawLog.length }}</div>
          <pre>{{ rawLog.map((r) => JSON.stringify(r)).join("\n") }}</pre>
        </div>
      </Card>
    </main>

  </div>

  <Settings v-if="showSettings" @close="showSettings = false" />
  <About v-if="showAbout" @close="showAbout = false" />
  <History v-if="showHistory" @close="showHistory = false" />
</template>

<style scoped>
.shell {
  position: relative;
  z-index: 1;
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 0 14px 14px;
}

/* ---------- titlebar ---------- */
.titlebar { display: flex; align-items: center; gap: 8px; height: 52px; }
.brand {
  display: flex; align-items: center; gap: 10px;
  padding: 4px 8px 4px 4px;
  border-radius: var(--r-sm);
  text-align: left;
  transition: background 0.2s;
}
.brand:hover { background: var(--shade); }
/* No plate, no shadow: the mark is transparent artwork now, not a white icon tile. */
.mark { width: 26px; height: auto; -webkit-user-drag: none; }
.brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.brand-text strong { font-size: 13px; font-weight: 700; letter-spacing: -0.01em; }
.brand-text small { font-size: 10px; color: var(--ink-3); }

.pill {
  display: flex; align-items: center; gap: 7px;
  height: 26px; padding: 0 11px 0 9px;
  border-radius: 999px;
  font-size: 11.5px; font-weight: 600; color: var(--ink-2);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-3); }
.pill.connecting .dot { background: #ffd60a; animation: blink 1s infinite; }
.pill.connected .dot { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.pill.error .dot { background: var(--danger); }
@keyframes blink { 50% { opacity: 0.25; } }

.locale { font-size: 12px; font-weight: 700; }
.btn-icon.active { background: var(--shade); color: var(--accent); }
.btn-icon.danger:hover { background: var(--danger); color: #fff; }
.win-buttons { display: flex; gap: 2px; margin-left: 6px; }

/* ---------- layout ---------- */
.grid { display: grid; grid-template-columns: 336px 1fr; gap: 14px; min-height: 0; }
/* The sidebar scrolls, the run button below it does not — it stays reachable whatever the
   window height, and lets the stream column run all the way to the bottom edge. */
.side { display: flex; flex-direction: column; min-height: 0; }
.side-scroll {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  overflow-y: auto; padding-right: 4px; padding-bottom: 6px;
  /* Fade the last few pixels so a clipped card reads as "scroll for more". */
  mask-image: linear-gradient(#000 calc(100% - 18px), transparent);
}
.side-scroll > * { flex: none; }

.mini { font-size: 11px; font-weight: 600; color: var(--ink-3); margin-bottom: 5px; }
.hint { font-size: 11.5px; color: var(--ink-3); }
.notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  line-height: 1.5;
  color: var(--ink-2);
  background: rgba(255, 214, 10, 0.14);
}

.line { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; cursor: pointer; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pair .line { gap: 6px; }
.seg.icons > button { display: flex; align-items: center; justify-content: center; }

.langs { display: flex; align-items: flex-end; gap: 8px; }
.swap { margin-bottom: 2px; }
.swap:disabled { opacity: 0.3; cursor: not-allowed; }

.meter { height: 6px; border-radius: 3px; background: var(--shade); overflow: hidden; }
.meter > i {
  display: block; height: 100%; width: 100%;
  background: linear-gradient(90deg, var(--ok), #ffd60a 70%, var(--danger));
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 0.08s linear;
}

.drop { height: 64px; border-style: dashed; border-width: 1.5px; font-weight: 500; }
.fname { font-weight: 600; word-break: break-all; }

.upd {
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  white-space: nowrap;
  transition: filter 0.2s;
}
.upd:hover { filter: brightness(1.1); }

/* ---------- stream ---------- */
.stream-card { min-height: 0; }

.stream {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 4px 20px 20px;
  display: flex; flex-direction: column; gap: 16px;
  scrollbar-gutter: stable;
}
.empty { margin: auto; color: var(--ink-3); font-size: 13.5px; text-align: center; max-width: 26ch; line-height: 1.6; }

.line-item { animation: slidein 0.35s var(--ease); }
@keyframes slidein { from { opacity: 0; transform: translateY(8px); } }
.src { margin: 0 0 3px; font-size: 13px; line-height: 1.55; color: var(--ink-3); user-select: text; }
.tgt { margin: 0; font-size: 16.5px; line-height: 1.55; font-weight: 600; letter-spacing: -0.005em; user-select: text; }
.live .tgt { color: var(--accent); }

/* The model's tentative continuation: shown, but visibly not final yet. */
.stash { opacity: 0.45; font-weight: 500; }

.detected {
  font-style: normal;
  margin-left: 5px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--accent);
  background: rgba(10, 132, 255, 0.12);
}

.caret {
  display: inline-block; width: 2px; height: 1em; margin-left: 3px;
  vertical-align: -0.13em; border-radius: 1px; background: currentColor;
  animation: blink 1.05s steps(2) infinite;
}

.diag {
  flex: none; max-height: 180px; overflow: auto;
  border-top: 1px solid var(--hairline);
  background: var(--shade);
}
.diag-head { position: sticky; top: 0; padding: 6px 14px; font-size: 10.5px; font-weight: 700; color: var(--ink-3); background: inherit; backdrop-filter: blur(8px); }
.diag pre {
  margin: 0; padding: 0 14px 12px;
  font-family: "SF Mono", "Cascadia Code", ui-monospace, monospace;
  font-size: 10.5px; line-height: 1.5; color: var(--ink-2);
  white-space: pre-wrap; word-break: break-all; user-select: text;
}

/* ---------- dock ---------- */
.dock { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 4px 0 0; }

.go {
  position: relative;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  width: 100%; height: 46px; padding: 0 30px;
  border-radius: 999px;
  font-size: 14.5px; font-weight: 700; color: #fff;
  background: var(--accent-grad);
  box-shadow: 0 12px 30px -10px rgba(10, 132, 255, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.45);
  transition: transform 0.24s var(--ease), filter 0.24s, box-shadow 0.24s;
}
.go:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.go:active:not(:disabled) { transform: scale(0.96); }
.go:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
.go.running { background: linear-gradient(135deg, #ff453a, #ff2d55); box-shadow: 0 12px 30px -10px rgba(255, 69, 58, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.4); }

.go-ring {
  position: absolute; inset: -4px;
  border-radius: 999px; border: 2px solid currentColor;
  opacity: 0; pointer-events: none;
}
.go.running .go-ring { animation: breathe 1.9s var(--ease) infinite; }
@keyframes breathe {
  0% { opacity: 0.5; transform: scale(1); }
  70%, 100% { opacity: 0; transform: scale(1.14); }
}

@media (max-width: 1040px) {
  .grid { grid-template-columns: 300px 1fr; }
}
</style>
