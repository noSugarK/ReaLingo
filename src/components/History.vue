<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { langName } from "../languages";
import { locale, t } from "../i18n";
import { saveAs, type Line } from "../stream";
import { settings } from "../store";
import Sheet from "./Sheet.vue";

defineEmits<{ close: [] }>();

/** One file on disk. `meta` is its first JSONL line, still unparsed — see history.rs. */
interface SessionRow {
  id: string;
  meta: string;
  count: number;
  bytes: number;
}
interface Meta {
  at: number;
  source: string;
  target: string;
}

const sessions = ref<SessionRow[]>([]);
const openId = ref("");
const rows = ref<Line[]>([]);
const q = ref("");
/** The session whose delete button is armed — a second click is the confirmation. */
const armed = ref("");

onMounted(load);

async function load() {
  sessions.value = await invoke<SessionRow[]>("history_list");
  if (sessions.value.length) await open(sessions.value[0].id);
  else openId.value = "";
}

async function open(id: string) {
  openId.value = id;
  q.value = "";
  armed.value = "";
  const raw = await invoke<string[]>("history_read", { id });
  rows.value = raw.flatMap(parseLine);
}

// A half-written last line is what a kill during a session leaves behind. Drop it and show
// the rest — the whole point of one-line-per-sentence is that damage stays local.
function parseLine(text: string, i: number): Line[] {
  try {
    const o = JSON.parse(text);
    return [{ id: i, at: o.at ?? 0, source: o.source ?? "", target: o.target ?? "" }];
  } catch {
    return [];
  }
}

function metaOf(s: SessionRow): Meta | null {
  try {
    return JSON.parse(s.meta) as Meta;
  } catch {
    return null;
  }
}

function when(s: SessionRow): string {
  const at = metaOf(s)?.at;
  return at ? new Date(at).toLocaleString(locale.value === "zh" ? "zh-CN" : "en-GB") : s.id;
}

function pair(s: SessionRow): string {
  const m = metaOf(s);
  if (!m) return "";
  return `${langName(m.source, locale.value)} → ${langName(m.target, locale.value)}`;
}

const shown = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return rows.value;
  return rows.value.filter((l) => `${l.source}\n${l.target}`.toLowerCase().includes(needle));
});

/** Two clicks to clear: a mis-click must not take every saved session with it. */
const armedAll = ref(false);
async function clearAll() {
  if (!armedAll.value) {
    armedAll.value = true;
    return;
  }
  await invoke("history_clear");
  armedAll.value = false;
  await load();
}

// reveal, not open_path: revealing is what `opener:default` already grants, while opening a
// path needs its own permission plus a scope entry for a directory whose name is only known
// at runtime. Same destination, one fewer moving part.
//
// The argument is `paths`, and it is a list — passing a single `path` fails the command's
// deserialisation, and nothing here would have shown you that.
const openDir = async () =>
  invoke("plugin:opener|reveal_item_in_dir", { paths: [await invoke<string>("history_dir")] });

async function remove(id: string) {
  if (armed.value !== id) {
    armed.value = id;
    return;
  }
  await invoke("history_delete", { id });
  armed.value = "";
  await load();
}
</script>

<template>
  <Sheet :title="t('history')" wide @close="$emit('close')">
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
          <small>{{ pair(s) }} · {{ s.count }} {{ t("unitLines") }}</small>
        </button>
      </div>

      <div class="list-foot">
        <button class="chip" @click="openDir">{{ t("historyDir") }}</button>
        <button class="chip danger" @click="clearAll">
          {{ armedAll ? t("confirmQ") : t("historyClear") }}
        </button>
      </div>

      <div class="right">
        <div class="tools">
          <input v-model="q" type="search" :placeholder="t('searchHere')" spellcheck="false" />
          <button class="chip" :disabled="!shown.length" @click="saveAs('txt', shown, openId)">
            {{ t("exportTxt") }}
          </button>
          <button class="chip" :disabled="!shown.length" @click="saveAs('srt', shown, openId)">
            {{ t("exportSrt") }}
          </button>
          <button class="chip danger" @click="remove(openId)">
            {{ armed === openId ? t("confirmQ") : t("del") }}
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

.chip {
  height: 26px;
  padding: 0 10px;
  border-radius: 9px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-2);
  background: var(--shade);
  white-space: nowrap;
  transition: background 0.2s, color 0.2s;
}
.chip:hover:not(:disabled) { background: var(--accent); color: #fff; }
.chip:disabled { opacity: 0.35; cursor: not-allowed; }
.chip.danger:hover { background: #ff453a; }
</style>
