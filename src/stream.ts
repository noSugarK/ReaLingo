import { ref, reactive, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
// `t` is a Turn everywhere in this file, so the translator comes in under another name.
import { t as msg } from "./i18n";
import { settings } from "./store";

export interface Line {
  id: number;
  source: string;
  target: string;
  at: number;
  /** Place in the input audio, ms; absent on history written before it was recorded. */
  start?: number;
  end?: number;
}

/** `stopping`: input has ended, the last sentence is still on its way. */
export type Status = "idle" | "connecting" | "connected" | "stopping" | "closed" | "error";

export const lines = ref<Line[]>([]);
/**
 * The sentence currently in flight. `*Stash` holds the model's unconfirmed tail — the
 * server re-sends the full confirmed text plus a tentative continuation on every frame,
 * so these are assignments, never concatenations.
 */
export const current = reactive({ source: "", sourceStash: "", target: "", targetStash: "" });
/** Source language the model detected, when `sourceLang` is "auto". */
export const detectedLang = ref("");
export const status = ref<Status>("idle");
export const errorMsg = ref("");
/** Non-fatal server notices (e.g. "previous turn is still processing"); auto-clears. */
export const warnMsg = ref("");
let warnTimer: number | undefined;
export const speaking = ref(false);
export const fileProgress = ref<{ sent: number; total: number | null } | null>(null);
/** Raw server frames, newest last — the diagnostics drawer. */
export const rawLog = ref<unknown[]>([]);

let nextId = 1;

/**
 * The history file this run is appending to, "" when history is off. Written as JSONL: one
 * meta line, then one line per sentence. See src-tauri/src/history.rs.
 */
let sessionId = "";

/** Non-fatal notices: shown for a few seconds, then gone. The session keeps running. */
function warn(text: string) {
  warnMsg.value = text;
  window.clearTimeout(warnTimer);
  warnTimer = window.setTimeout(() => (warnMsg.value = ""), 6000);
}

/**
 * Fire and forget: a disk that will not take the line must not stall the subtitle. It does
 * have to be said, though — otherwise the run looks recorded and is not.
 */
function record(cmd: "history_open" | "history_append", args: object) {
  if (!sessionId) return;
  void invoke(cmd, { id: sessionId, ...args }).catch((e) => {
    sessionId = "";
    warn(`${msg("historyFailed")} ${e}`);
  });
}

/**
 * One turn of speech: its transcript and its translation, which arrive as two independent
 * streams and finish at different times — in practice the translation is done first and
 * the transcript lands seconds later, while the *next* turn is already streaming. Keyed by
 * the assistant item id the server puts on every translation frame; transcripts carry the
 * input item's id instead, which a `link` event maps onto this key.
 */
interface Turn {
  key: string;
  input: string;
  source: string;
  sourceStash: string;
  target: string;
  targetStash: string;
  sourceDone: boolean;
  targetDone: boolean;
  at: number;
  /** Audio-time span the server reported, when it does. */
  startMs?: number;
  endMs?: number;
  /** Fallback: the audio clock when this turn's text first and last arrived. */
  firstAt?: number;
  lastAt?: number;
  /** Set once the turn has a row in `lines`; the row is patched in place afterwards. */
  lineId?: number;
}

const turns = new Map<string, Turn>();
/** Input item id -> turn key, from the server's `link` event. */
const byInput = new Map<string, string>();
/** Input item id -> its speech_started / speech_stopped offsets, until a turn claims them. */
const speechAt = new Map<string, { start?: number; end?: number }>();

function timeTurn(t: Turn, e: { startMs?: number; endMs?: number; atMs?: number }) {
  if (e.startMs != null) t.startMs = Math.min(t.startMs ?? e.startMs, e.startMs);
  if (e.endMs != null) t.endMs = Math.max(t.endMs ?? e.endMs, e.endMs);
  if (e.atMs != null) {
    t.firstAt ??= e.atMs;
    t.lastAt = e.atMs;
  }
}

const span = (t: Turn) => ({ start: t.startMs ?? t.firstAt, end: t.endMs ?? t.lastAt });

const oldestTurn = () => turns.values().next().value as Turn | undefined;
const newestTurn = () => [...turns.values()].pop();

function turnFor(key: string): Turn {
  let t = turns.get(key);
  if (!t) {
    t = {
      key,
      input: "",
      source: "",
      sourceStash: "",
      target: "",
      targetStash: "",
      sourceDone: false,
      targetDone: false,
      at: Date.now(),
    };
    turns.set(key, t);
    // A turn whose transcript never arrives would sit here forever. Two or three are open
    // at once in normal speech; well past that, the oldest is never coming back.
    if (turns.size > 8) close(oldestTurn()!);
  }
  return t;
}

/** Show it in the stream as soon as there is something to show, then keep the row current. */
function publish(t: Turn) {
  if (!t.source && !t.target) return;
  if (t.lineId === undefined) {
    t.lineId = nextId++;
    lines.value.push({ id: t.lineId, source: t.source, target: t.target, at: t.at, ...span(t) });
    if (lines.value.length > 500) lines.value.splice(0, lines.value.length - 500);
    return;
  }
  const row = lines.value.find((l) => l.id === t.lineId);
  if (row) {
    row.source = t.source;
    row.target = t.target;
    Object.assign(row, span(t));
  }
}

/** Both halves are final: the row is complete, so this is the one version worth keeping. */
function settle(t: Turn) {
  if (!t.sourceDone || !t.targetDone) return;
  close(t);
}

function close(t: Turn) {
  publish(t);
  if (t.source || t.target) {
    record("history_append", { entry: { at: t.at, source: t.source, target: t.target, ...span(t) } });
  }
  turns.delete(t.key);
  if (t.input) {
    byInput.delete(t.input);
    speechAt.delete(t.input);
  }
  syncCurrent();
}

function flush() {
  for (const t of [...turns.values()]) close(t);
}

/**
 * `current` is what the subtitle window and the live row render. It mirrors the newest
 * turn — the one still being spoken — so the overlay never waits on a transcript that is
 * still catching up with a turn the user has already finished saying.
 */
function syncCurrent() {
  const t = newestTurn();
  current.source = t?.source ?? "";
  current.sourceStash = t?.sourceStash ?? "";
  current.target = t?.target ?? "";
  current.targetStash = t?.targetStash ?? "";
}

/** Drops every open turn; `current` follows, since it only ever mirrors the newest one. */
function resetTurns() {
  turns.clear();
  byInput.clear();
  speechAt.clear();
  syncCurrent();
}

interface RtEvent {
  kind: "status" | "target" | "source" | "link" | "speech" | "error" | "warn" | "progress";
  text: string;
  stash: string;
  lang: string;
  /** Turn id: the assistant item for translations, the input item for transcripts. */
  id: string;
  done: boolean;
  startMs?: number;
  endMs?: number;
  atMs?: number;
}

void listen<RtEvent>("rt://event", ({ payload: e }) => {
  switch (e.kind) {
    case "status":
      if (e.text === "connecting") status.value = "connecting";
      else if (e.text === "connected") status.value = "connected";
      else if (e.text === "closed") {
        flush();
        speaking.value = false;
        if (status.value !== "error") status.value = "closed";
      }
      break;

    // Arrives before either stream for the turn, so the transcript always has a home.
    case "link": {
      byInput.set(e.text, e.id);
      turnFor(e.id).input = e.text;
      const at = speechAt.get(e.text);
      if (at) timeTurn(turnFor(e.id), { startMs: at.start, endMs: at.end });
      break;
    }

    case "source": {
      // Falling back to the newest turn keeps a transcript that outran its link visible
      // rather than silently dropped.
      const key = byInput.get(e.id) ?? newestTurn()?.key;
      if (!key) break;
      const t = turnFor(key);
      timeTurn(t, e);
      t.source = e.text;
      t.sourceStash = e.done ? "" : e.stash;
      if (e.lang) detectedLang.value = e.lang;
      speaking.value = !e.done;
      if (e.done) t.sourceDone = true;
      // Only ever patches here: a turn still waiting for its translation belongs in the
      // live row, not as a second, half-empty row in the stream.
      if (t.lineId !== undefined) publish(t);
      syncCurrent();
      settle(t);
      break;
    }

    case "target": {
      const t = turnFor(e.id);
      timeTurn(t, e);
      t.target = e.text;
      t.targetStash = e.done ? "" : e.stash;
      speaking.value = !e.done;
      if (e.done) {
        t.targetDone = true;
        // Into the stream now, even though the transcript may still be seconds away —
        // waiting would leave the row blank while the model has already answered.
        publish(t);
      }
      syncCurrent();
      settle(t);
      break;
    }

    case "speech": {
      speaking.value = e.text === "start";
      if (!e.id) break;
      // Usually ahead of the link that names its turn; held until then.
      const at = { ...speechAt.get(e.id), ...(e.startMs != null && { start: e.startMs }), ...(e.endMs != null && { end: e.endMs }) };
      speechAt.set(e.id, at);
      const key = byInput.get(e.id);
      if (key) timeTurn(turnFor(key), { startMs: at.start, endMs: at.end });
      break;
    }
    case "progress":
      if (e.text === "done") fileProgress.value = null;
      else {
        const [sent, total] = e.text.split("/");
        fileProgress.value = { sent: Number(sent), total: total === "?" ? null : Number(total) };
      }
      break;
    case "warn":
      // The session is still alive — say so and keep streaming.
      warn(e.text);
      break;
    case "error":
      errorMsg.value = e.text;
      status.value = "error";
      break;
  }
});

void listen("rt://raw", ({ payload }) => {
  rawLog.value.push(payload);
  if (rawLog.value.length > 300) rawLog.value.splice(0, rawLog.value.length - 300);
});

export type Source = { kind: "device"; id: string } | { kind: "file"; path: string };

/** `speak` is decided by the caller: whether the setting may take effect for this source. */
export async function start(source: Source, speak: boolean) {
  errorMsg.value = "";
  warnMsg.value = "";
  lines.value = [];
  detectedLang.value = "";
  resetTurns();
  rawLog.value = [];
  fileProgress.value = null;
  status.value = "connecting";
  // The id is the file name, so it has to survive as a plain slug — and being an ISO
  // timestamp it also sorts chronologically for free.
  sessionId = settings.history ? new Date().toISOString().replace(/[:.]/g, "-") : "";
  record("history_open", {
    meta: {
      v: 1,
      at: Date.now(),
      source: settings.sourceLang,
      target: settings.targetLang,
      model: settings.model,
      kind: source.kind,
    },
  });
  try {
    await invoke("start_stream", { settings: { ...toRaw(settings), speak }, source });
  } catch (e) {
    errorMsg.value = String(e);
    status.value = "error";
  }
}

/**
 * Ends input and waits: the server is still finishing the last sentence, and the `closed`
 * status that settles everything arrives once it has. Set before the call, so a `closed`
 * that beats the round trip still wins.
 */
export async function stop() {
  if (status.value !== "error") status.value = "stopping";
  await invoke("stop_stream");
}

export const isRunning = () =>
  status.value === "connecting" || status.value === "connected" || status.value === "stopping";

export function exportTxt(rows: Line[] = lines.value): string {
  return rows.map((l) => (l.source ? `${l.source}\n${l.target}` : l.target)).join("\n\n");
}

/**
 * SRT timings are the line's place in the input audio — exact where the server reports it,
 * otherwise when its text arrived on the audio's clock (late by the model's latency). History
 * written before that was recorded falls back to wall-clock arrival, counted from the first line.
 */
export function exportSrt(rows: Line[] = lines.value): string {
  const timed = rows.length > 0 && rows.every((l) => l.start != null);
  const t0 = rows[0]?.at ?? Date.now();
  const startOf = (l: Line) => (timed ? l.start! : l.at - t0);
  return rows
    .map((l, i) => {
      const start = startOf(l);
      const next = rows[i + 1] ? startOf(rows[i + 1]) : undefined;
      // Never past the next line's start, never shorter than a glance.
      const wanted = timed && l.end != null ? l.end : (next ?? start + 3000);
      const end = Math.max(start + 1000, next != null ? Math.min(wanted, next) : wanted);
      const body = l.source ? `${l.source}\n${l.target}` : l.target;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${body}\n`;
    })
    .join("\n");
}

/** Save an export through the user's own file dialog. Shared by the stream and the history panel. */
export async function saveAs(kind: "txt" | "srt", rows: Line[], stem = "translation") {
  const path = await saveDialog({
    defaultPath: `${stem}.${kind}`,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (!path) return;
  await invoke("write_text", { path, contents: kind === "txt" ? exportTxt(rows) : exportSrt(rows) });
}

function srtTime(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
