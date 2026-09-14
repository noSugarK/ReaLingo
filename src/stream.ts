import { ref, reactive, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
export const speaking = ref(false);
export const fileProgress = ref<{ sent: number; total: number | null } | null>(null);
/** Raw server frames, newest last — the diagnostics drawer. */
export const rawLog = ref<unknown[]>([]);

let nextId = 1;

function commit() {
  if (!current.source && !current.target) return;
  lines.value.push({ id: nextId++, source: current.source, target: current.target, at: Date.now() });
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
  kind: "status" | "target" | "source" | "speech" | "error" | "progress";
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
  lines.value = [];
  detectedLang.value = "";
  clearCurrent();
  rawLog.value = [];
  fileProgress.value = null;
  status.value = "connecting";
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

export function exportTxt(): string {
  return lines.value.map((l) => (l.source ? `${l.source}\n${l.target}` : l.target)).join("\n\n");
}

/** SRT timings are derived from arrival time — good enough to follow along, not frame-accurate. */
export function exportSrt(): string {
  const t0 = lines.value[0]?.at ?? Date.now();
  return lines.value
    .map((l, i) => {
      const start = l.at - t0;
      const end = (lines.value[i + 1]?.at ?? l.at + 3000) - t0;
      const body = l.source ? `${l.source}\n${l.target}` : l.target;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${body}\n`;
    })
    .join("\n");
}

function srtTime(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
