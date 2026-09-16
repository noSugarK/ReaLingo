import { ref, reactive, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { settings } from "./store";

export interface Line {
  id: number;
  source: string;
  target: string;
  at: number;
}

export type Status = "idle" | "connecting" | "connected" | "closed" | "error";

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

function record(line: object) {
  if (!sessionId) return;
  // Fire and forget: a disk that will not take the line must not stall the subtitle.
  void invoke("history_append", { id: sessionId, line: JSON.stringify(line) }).catch(() => {
    sessionId = "";
  });
}

function commit() {
  if (!current.source && !current.target) return;
  lines.value.push({ id: nextId++, source: current.source, target: current.target, at: Date.now() });
  record({ at: Date.now(), source: current.source, target: current.target });
  if (lines.value.length > 500) lines.value.splice(0, lines.value.length - 500);
  clearCurrent();
}

function clearCurrent() {
  current.source = "";
  current.sourceStash = "";
  current.target = "";
  current.targetStash = "";
}

interface RtEvent {
  kind: "status" | "target" | "source" | "speech" | "error" | "warn" | "progress";
  text: string;
  stash: string;
  lang: string;
  done: boolean;
}

void listen<RtEvent>("rt://event", ({ payload: e }) => {
  switch (e.kind) {
    case "status":
      if (e.text === "connecting") status.value = "connecting";
      else if (e.text === "connected") status.value = "connected";
      else if (e.text === "closed") {
        commit();
        speaking.value = false;
        if (status.value !== "error") status.value = "closed";
      }
      break;

    case "source":
      current.source = e.text;
      current.sourceStash = e.done ? "" : e.stash;
      if (e.lang) detectedLang.value = e.lang;
      speaking.value = !e.done;
      break;

    case "target":
      current.target = e.text;
      current.targetStash = e.done ? "" : e.stash;
      if (e.done) {
        speaking.value = false;
        commit();
      } else {
        speaking.value = true;
      }
      break;

    case "speech":
      speaking.value = e.text === "start";
      break;
    case "progress":
      if (e.text === "done") fileProgress.value = null;
      else {
        const [sent, total] = e.text.split("/");
        fileProgress.value = { sent: Number(sent), total: total === "?" ? null : Number(total) };
      }
      break;
    case "warn":
      // The session is still alive — say so and keep streaming.
      warnMsg.value = e.text;
      window.clearTimeout(warnTimer);
      warnTimer = window.setTimeout(() => (warnMsg.value = ""), 6000);
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

export async function start(source: Source) {
  errorMsg.value = "";
  warnMsg.value = "";
  lines.value = [];
  detectedLang.value = "";
  clearCurrent();
  rawLog.value = [];
  fileProgress.value = null;
  status.value = "connecting";
  // The id is the file name, so it has to survive as a plain slug — and being an ISO
  // timestamp it also sorts chronologically for free.
  sessionId = settings.history ? new Date().toISOString().replace(/[:.]/g, "-") : "";
  record({
    v: 1,
    at: Date.now(),
    source: settings.sourceLang,
    target: settings.targetLang,
    model: settings.model,
    kind: source.kind,
  });
  try {
    await invoke("start_stream", { settings: toRaw(settings), source });
  } catch (e) {
    errorMsg.value = String(e);
    status.value = "error";
  }
}

export async function stop() {
  await invoke("stop_stream");
  commit();
  speaking.value = false;
  if (status.value !== "error") status.value = "idle";
}

export const isRunning = () => status.value === "connecting" || status.value === "connected";

export function exportTxt(rows: Line[] = lines.value): string {
  return rows.map((l) => (l.source ? `${l.source}\n${l.target}` : l.target)).join("\n\n");
}

/** SRT timings are derived from arrival time — good enough to follow along, not frame-accurate. */
export function exportSrt(rows: Line[] = lines.value): string {
  const t0 = rows[0]?.at ?? Date.now();
  return rows
    .map((l, i) => {
      const start = l.at - t0;
      const end = (rows[i + 1]?.at ?? l.at + 3000) - t0;
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
