<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { langName } from "../languages";
import { locale, t } from "../i18n";
import { saveAs, type Line } from "../stream";
import { settings } from "../store";
import Sheet from "./Sheet.vue";

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

async function remove(id: string) {
  if (!armedFor(id)) return;
  await call("history_delete", { id });
  await load();
}
</script>

<template>
  <Sheet :title="t('history')" wide @close="$emit('close')">
    <p v-if="err" class="err">{{ err }}</p>

    <p v-if="!sessions.length" class="blank">
      {{ settings.history ? t("historyNone") : t("historyOff") }}
      <button v-if="!settings.history" class="chip" @click="settings.history = true">
        {{ t("historyGo") }}
      </button>
    </p>

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
        <button class="chip" @click="openDir">{{ t("historyDir") }}</button>
        <button class="chip danger" @click="clearAll">
          {{ armed === "*" ? t("historyConfirm") : t("historyClear") }}
        </button>
      </div>

      <div class="right">
        <div class="tools">
          <input v-model="q" type="search" :placeholder="t('historySearch')" spellcheck="false" />
          <button class="chip" :disabled="!shown.length" @click="saveAs('txt', shown, openId)">
            {{ t("exportTxt") }}
          </button>
          <button class="chip" :disabled="!shown.length" @click="saveAs('srt', shown, openId)">
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
  </Sheet>
</template>

<style scoped>
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
</style>
