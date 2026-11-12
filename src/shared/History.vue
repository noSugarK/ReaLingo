<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { langName } from "../core/languages";
import { locale, t } from "../core/i18n";
import { saveAs, type Line } from "../core/stream";
import { settings } from "../core/store";
import { caps } from "../core/platform";
import Sheet from "./Sheet.vue";

const props = defineProps<{ mobile?: boolean }>();
defineEmits<{ close: [] }>();

// Both shapes come from history.rs already parsed — `meta` is null when the session's
// first line is unreadable.
interface Meta {
  at: number;
  source: string;
  target: string;
}
interface SessionRow {
  id: string;
  meta: Meta | null;
  count: number;
  bytes: number;
}

const sessions = ref<SessionRow[]>([]);
const openId = ref("");
const rows = ref<Line[]>([]);
const q = ref("");
const err = ref("");
/**
 * The button waiting for its second click: two clicks to delete, so a mis-click cannot take
 * a saved session — or all of them — with it. `"*"` is the clear-everything button, and no
 * session id can collide with it (history.rs only accepts alphanumerics, `-` and `_`).
 */
const armed = ref("");

onMounted(load);

/** Whatever the backend refuses is shown in the panel: silence here reads as "no history". */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  err.value = "";
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    err.value = String(e);
  }
}

async function load() {
  sessions.value = (await call<SessionRow[]>("history_list")) ?? [];
  if (sessions.value.length) await open(sessions.value[0].id);
  else openId.value = "";
}

async function open(id: string) {
  openId.value = id;
  q.value = "";
  armed.value = "";
  const raw = (await call<Omit<Line, "id">[]>("history_read", { id })) ?? [];
  rows.value = raw.map((l, i) => ({ id: i, ...l }));
}

function when(s: SessionRow): string {
  const at = s.meta?.at;
  return at ? new Date(at).toLocaleString(locale.value === "zh" ? "zh-CN" : "en-GB") : s.id;
}

function pair(s: SessionRow): string {
  if (!s.meta) return "";
  return `${langName(s.meta.source, locale.value)} → ${langName(s.meta.target, locale.value)}`;
}

const shown = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return rows.value;
  return rows.value.filter((l) => `${l.source}\n${l.target}`.toLowerCase().includes(needle));
});

/** True on the second click, and disarms; false on the first, and arms. */
function armedFor(what: string): boolean {
  if (armed.value === what) {
    armed.value = "";
    return true;
  }
  armed.value = what;
  return false;
}

async function clearAll() {
  if (!armedFor("*")) return;
  await call("history_clear");
  await load();
}

// reveal, not open_path: revealing is what `opener:default` already grants, while opening a
// path needs its own permission plus a scope entry for a directory whose name is only known
// at runtime. Same destination, one fewer moving part.
//
// The argument is `paths`, and it is a list — passing a single `path` fails the command's
// deserialisation, and nothing here would have shown you that.
const openDir = async () => {
  const dir = await call<string>("history_dir");
  if (dir) await call("plugin:opener|reveal_item_in_dir", { paths: [dir] });
};

async function saveRows(kind: "txt" | "srt") {
  try { await saveAs(kind, shown.value, openId.value); } catch (e) { err.value = String(e); }
}
async function remove(id: string) {
  if (!armedFor(id)) return;
  await call("history_delete", { id });
  await load();
}
</script>

<template>
  <component :is="props.mobile ? 'div' : Sheet" class="history-shell" :class="{ mobile: props.mobile }" :title="props.mobile ? undefined : t('history')" :wide="!props.mobile" @close="$emit('close')">
    <p v-if="err" class="err">{{ err }}</p>

    <div v-if="props.mobile && !sessions.length" class="mobile-empty">
      <span class="empty-mark">◷</span>
      <b>{{ settings.history ? t("historyNone") : t("historyOff") }}</b>
      <small>{{ t("historyMobileSub") }}</small>
      <button v-if="!settings.history" class="mobile-action primary" @click="settings.history = true">{{ t("historyGo") }}</button>
    </div>

    <p v-else-if="!sessions.length" class="blank">
      {{ settings.history ? t("historyNone") : t("historyOff") }}
      <button v-if="!settings.history" class="chip" @click="settings.history = true">{{ t("historyGo") }}</button>
    </p>

    <template v-else-if="props.mobile">
      <div class="session-strip" role="group" :aria-label="t('history')">
        <button v-for="s in sessions" :key="s.id" class="session-card" :class="{ on: s.id === openId }" :aria-pressed="s.id === openId" @click="open(s.id)">
          <b>{{ when(s) }}</b>
          <small>{{ pair(s) || s.id }} · {{ s.count }} {{ t("historyUnit") }}</small>
        </button>
      </div>
      <label class="history-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input v-model="q" type="search" :aria-label="t('historySearch')" :placeholder="t('historySearch')" spellcheck="false" />
      </label>
      <div class="mobile-actions">
        <button class="mobile-action" :disabled="!shown.length" @click="saveRows('txt')">TXT</button>
        <button class="mobile-action" :disabled="!shown.length" @click="saveRows('srt')">SRT</button>
        <button class="mobile-action danger" @click="remove(openId)">{{ armed === openId ? t("historyConfirm") : t("historyDel") }}</button>
        <button class="mobile-action danger" @click="clearAll">{{ armed === "*" ? t("historyConfirm") : t("historyClear") }}</button>
      </div>
      <div class="mobile-rows">
        <p v-if="!shown.length" class="mobile-no-rows">{{ t("historyPick") }}</p>
        <article v-for="l in shown" :key="l.id" class="history-row">
          <p v-if="l.source" class="src">{{ l.source }}</p>
          <p class="tgt">{{ l.target }}</p>
        </article>
      </div>
    </template>

    <div v-else class="panes">
      <div class="list">
        <button
          v-for="s in sessions"
          :key="s.id"
          class="item"
          :class="{ on: s.id === openId }"
          @click="open(s.id)"
        >
          <b>{{ when(s) }}</b>
          <small>{{ pair(s) }} · {{ s.count }} {{ t("historyUnit") }}</small>
        </button>
      </div>

      <div class="list-foot">
        <button v-if="caps.os !== 'android'" class="chip" @click="openDir">{{ t("historyDir") }}</button>
        <button class="chip danger" @click="clearAll">
          {{ armed === "*" ? t("historyConfirm") : t("historyClear") }}
        </button>
      </div>

      <div class="right">
        <div class="tools">
          <input v-model="q" type="search" :placeholder="t('historySearch')" spellcheck="false" />
          <button class="chip" :disabled="!shown.length" @click="saveRows('txt')">
            {{ t("exportTxt") }}
          </button>
          <button class="chip" :disabled="!shown.length" @click="saveRows('srt')">
            {{ t("exportSrt") }}
          </button>
          <button class="chip danger" @click="remove(openId)">
            {{ armed === openId ? t("historyConfirm") : t("historyDel") }}
          </button>
        </div>

        <div class="rows">
          <p v-if="!shown.length" class="blank">{{ t("historyPick") }}</p>
          <article v-for="l in shown" :key="l.id">
            <p v-if="l.source" class="src">{{ l.source }}</p>
            <p class="tgt">{{ l.target }}</p>
          </article>
        </div>
      </div>
    </div>
  </component>
</template>

<style scoped>
.history-shell { min-height: 0; }
.history-shell.mobile { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
.mobile-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; padding: 28px; text-align: center; color: var(--ink-2); }
.empty-mark { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 22px; background: var(--shade); color: var(--accent); font-size: 34px; }
.mobile-empty b { font-size: 17px; color: var(--ink); }
.mobile-empty small { max-width: 28ch; font-size: 13px; line-height: 1.5; color: var(--ink-3); }
.mobile-empty .mobile-action { flex: none; }
.session-strip { display: flex; flex: none; gap: 8px; overflow-x: auto; padding: 2px 2px 5px; scroll-snap-type: x proximity; }
.session-card { flex: 0 0 auto; max-width: 78vw; display: flex; flex-direction: column; gap: 4px; padding: 10px 13px; border-radius: 15px; text-align: left; background: var(--shade); scroll-snap-align: start; }
.session-card b { font-size: 12px; font-weight: 680; }
.session-card small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--ink-3); }
.session-card.on { background: var(--accent); color: #fff; }
.session-card.on small { color: rgba(255,255,255,.82); }
.history-search { flex: none; height: 42px; display: flex; align-items: center; gap: 9px; padding: 0 13px; border-radius: 13px; background: var(--shade); color: var(--ink-3); }
.history-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 14px; }
.mobile-actions { flex: none; display: flex; gap: 7px; overflow-x: auto; }
.mobile-action { flex: 1 0 auto; min-height: 36px; padding: 0 11px; border-radius: 11px; background: var(--shade); color: var(--ink-2); font-size: 12px; font-weight: 680; white-space: nowrap; }
.mobile-action:disabled { opacity: .4; }
.mobile-action.danger { color: var(--danger); }
.mobile-action.primary { background: var(--accent); color: white; }
.mobile-rows { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 2px 2px 12px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.history-row { padding: 12px 13px; border-radius: 15px; background: var(--glass); box-shadow: inset 0 0 0 1px var(--hairline); }
.mobile-no-rows { margin: auto; color: var(--ink-3); font-size: 13px; }
/* A fixed box rather than one that grows with the longest session: the sheet must not
   change size every time another row is selected. */
.panes {
  display: grid;
  grid-template-columns: 224px 1fr;
  grid-template-rows: 1fr auto;
  gap: 10px 14px;
  height: min(58vh, 440px);
  min-height: 0;
}
.list-foot { display: flex; gap: 6px; }

.list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 4px;
}
.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
  text-align: left;
  border-radius: var(--r-md);
  background: var(--shade);
  transition: background 0.2s;
}
.item:hover { background: var(--glass-hi); }
.item.on { background: var(--accent); color: #fff; }
.item b { font-size: 12.5px; font-weight: 650; }
.item small { font-size: 11px; opacity: 0.75; }

/* Spans both rows so the folder buttons sit under the session list only, not under the
   sentences. */
.right {
  grid-row: 1 / 3;
  grid-column: 2;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.tools { display: flex; align-items: center; gap: 6px; }
.tools input { height: 30px; font-size: 12.5px; }

.rows {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 4px;
}
.src { margin: 0 0 3px; font-size: 12.5px; line-height: 1.55; color: var(--ink-3); user-select: text; }
.tgt { margin: 0; font-size: 15px; line-height: 1.55; font-weight: 600; user-select: text; }

.blank {
  margin: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink-3);
  font-size: 13px;
}
@media (max-width: 600px) {
  .panes { display: flex; flex-direction: column; height: auto; }
  .list { max-height: 160px; flex-shrink: 0; }
  .right { min-height: 240px; }
  .tools { flex-wrap: wrap; }
  .tools input { width: 100%; }
}
</style>
