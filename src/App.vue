<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import Card from "./components/Card.vue";
import LangSelect from "./components/LangSelect.vue";
import Settings from "./components/Settings.vue";
import { locale, setLocale, t } from "./i18n";
import { langName } from "./languages";
import { settings, initSettings, resolvedTheme, type SubMode } from "./store";
import {
  current,
  detectedLang,
  errorMsg,
  exportSrt,
  exportTxt,
  fileProgress,
  isRunning,
  lines,
  rawLog,
  speaking,
  start,
  status,
  stop,
} from "./stream";

type SourceKind = "mic" | "system" | "file";

const win = getCurrentWindow();
const showSettings = ref(false);
const showDiag = ref(false);
const sourceKind = ref<SourceKind>("mic");
const devices = ref<{ id: string; name: string; loopback: boolean }[]>([]);
const deviceId = ref("");
const filePath = ref("");
const level = ref(0);
const streamEl = ref<HTMLElement | null>(null);

const isDark = computed(() => resolvedTheme.value === "dark");
function cycleTheme() {
  settings.theme = isDark.value ? "light" : "dark";
}

const AUDIO_EXT = ["mp3", "wav", "m4a", "mp4", "aac", "flac", "ogg", "oga"];

const visibleDevices = computed(() =>
  devices.value.filter((d) => d.loopback === (sourceKind.value === "system"))
);
const fileName = computed(() => filePath.value.split(/[\\/]/).pop() ?? "");
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
  devices.value = await invoke("list_devices");
  await pickDefaultDevice();
}

async function pickDefaultDevice() {
  if (sourceKind.value === "file") return;
  const wantLoopback = sourceKind.value === "system";
  if (visibleDevices.value.some((d) => d.id === deviceId.value)) return;
  const preferred = await invoke<string | null>("default_device", { loopback: wantLoopback });
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

async function syncOverlay() {
  const w = await subtitleWindow();
  if (!w) return;
  await (settings.sub.show ? w.show() : w.hide());
  await w.setIgnoreCursorEvents(settings.sub.locked);
  await emitTo("subtitle", "sub://style", JSON.parse(JSON.stringify(settings.sub)));
}
watch(() => settings.sub, syncOverlay, { deep: true });

const subModes: [SubMode, "subBoth" | "subTarget" | "subSource"][] = [
  ["both", "subBoth"],
  ["target", "subTarget"],
  ["source", "subSource"],
];

/* ---------- export ---------- */
async function exportAs(kind: "txt" | "srt") {
  const path = await saveDialog({
    defaultPath: `translation.${kind}`,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (!path) return;
  await invoke("write_text", { path, contents: kind === "txt" ? exportTxt() : exportSrt() });
}

/* ---------- lifecycle ---------- */
let levelTimer: number | undefined;

onMounted(async () => {
  await initSettings();
  await refreshDevices();
  await syncOverlay();
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
      <div class="brand" data-tauri-drag-region>
        <span class="mark" />
        <div class="brand-text" data-tauri-drag-region>
          <strong>{{ t("appTitle") }}</strong>
          <small>{{ t("appSub") }}</small>
        </div>
      </div>

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
        <button class="btn-icon" aria-label="Minimize" @click="win.minimize()">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
        <button class="btn-icon danger" aria-label="Close" @click="win.close()">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      </div>
    </header>

    <main class="grid">
      <aside class="side">
        <!-- audio source -->
        <Card :title="t('srcTitle')">
          <div class="seg">
            <button :class="{ on: sourceKind === 'mic' }" @click="sourceKind = 'mic'">{{ t("srcMic") }}</button>
            <button :class="{ on: sourceKind === 'system' }" @click="sourceKind = 'system'">{{ t("srcSystem") }}</button>
            <button :class="{ on: sourceKind === 'file' }" @click="sourceKind = 'file'">{{ t("srcFile") }}</button>
          </div>

          <template v-if="sourceKind !== 'file'">
            <div class="row">
              <select v-model="deviceId" :disabled="isRunning()">
                <option v-if="!visibleDevices.length" value="">
                  {{ sourceKind === "system" ? t("loopbackOnlyWin") : t("noDevice") }}
                </option>
                <option v-for="d in visibleDevices" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
              <button class="btn-icon" :aria-label="t('device')" @click="refreshDevices">
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path d="M13 7.5a5.5 5.5 0 1 1-1.7-3.9M13 1.5V5H9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
            <div class="meter" :title="t('level')">
              <i :style="{ transform: `scaleX(${Math.min(1, level * 1.6)})` }" />
            </div>
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
              <LangSelect v-model="settings.sourceLang" allow-auto :disabled="isRunning()" />
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
              <LangSelect v-model="settings.targetLang" :disabled="isRunning()" />
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

          <label class="line stack">
            <span class="mini">{{ t("subOpacity") }} · {{ Math.round(settings.sub.opacity * 100) }}%</span>
            <input
              v-model.number="settings.sub.opacity"
              type="range" min="0" max="1" step="0.01"
              :style="{ '--fill': settings.sub.opacity * 100 + '%' }"
            />
          </label>

          <label class="line stack">
            <span class="mini">{{ t("subFontSize") }} · {{ settings.sub.fontSize }}px</span>
            <input
              v-model.number="settings.sub.fontSize"
              type="range" min="14" max="72" step="1"
              :style="{ '--fill': ((settings.sub.fontSize - 14) / 58) * 100 + '%' }"
            />
          </label>

          <div class="line">
            <span>{{ t("subColors") }}</span>
            <div class="row">
              <input v-model="settings.sub.color" type="color" :title="t('subColor')" />
              <input v-model="settings.sub.srcColor" type="color" :title="t('subSrcColor')" />
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
      </aside>

      <!-- translation stream -->
      <Card class="stream-card" :title="t('streamTitle')" flush>
        <template #action>
          <div class="row">
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

    <footer class="dock">
      <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
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
  </div>

  <Settings v-if="showSettings" @close="showSettings = false" />
</template>

<style scoped>
.shell {
  position: relative;
  z-index: 1;
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto;
  padding: 0 14px 14px;
}

/* ---------- titlebar ---------- */
.titlebar { display: flex; align-items: center; gap: 8px; height: 52px; }
.brand { display: flex; align-items: center; gap: 10px; padding-left: 4px; }
.mark {
  width: 26px; height: 26px; border-radius: 8px;
  background: var(--accent-grad);
  box-shadow: 0 4px 12px -4px rgba(94, 92, 230, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}
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
.side {
  display: flex; flex-direction: column; gap: 10px;
  overflow-y: auto; padding-right: 4px; padding-bottom: 6px;
  /* Fade the last few pixels so a clipped card reads as "scroll for more". */
  mask-image: linear-gradient(#000 calc(100% - 18px), transparent);
}
.side > * { flex: none; }

.mini { font-size: 11px; font-weight: 600; color: var(--ink-3); margin-bottom: 5px; }
.hint { font-size: 11.5px; color: var(--ink-3); }

.line { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; cursor: pointer; }
.line.stack { flex-direction: column; align-items: stretch; gap: 0; cursor: default; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pair .line { gap: 6px; }

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

/* ---------- stream ---------- */
.stream-card { min-height: 0; }
.chip {
  height: 26px; padding: 0 10px;
  border-radius: 9px; font-size: 11.5px; font-weight: 600;
  color: var(--ink-2); background: var(--shade);
  transition: background 0.2s, color 0.2s;
}
.chip:hover:not(:disabled) { background: var(--accent); color: #fff; }
.chip:disabled { opacity: 0.35; cursor: not-allowed; }

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
.dock { display: flex; align-items: center; justify-content: center; gap: 14px; height: 70px; position: relative; }
.err {
  position: absolute; left: 0; right: 0; bottom: 56px;
  margin: 0; text-align: center; font-size: 12px; color: var(--danger); font-weight: 600;
}

.go {
  position: relative;
  display: flex; align-items: center; gap: 9px;
  height: 46px; padding: 0 30px;
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
