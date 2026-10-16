import { reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { MODEL_QWEN3_5, MODEL_QWEN3_8, PROTOCOLS, type Vendor } from "./languages";

/** Only the regions that serve the LiveTranslate models — see `config::Region` in Rust. */
export type Region = "beijing" | "singapore";

/** Model Studio's region id: part of every console link. */
export const REGION_ID: Record<Region, string> = { beijing: "cn-beijing", singapore: "ap-southeast-1" };
export type Theme = "system" | "light" | "dark";
export type SubMode = "both" | "target" | "source";
export type SubAlign = "left" | "center" | "right";

/** Where the overlay was last parked, in physical pixels. Null until it is first moved. */
export interface SubRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Font sizes of the two rows in the main window's translation stream, in px. */
export interface StreamStyle {
  srcSize: number;
  tgtSize: number;
}

/** What the two stream sliders are allowed to reach; also clamps a hand-edited config. */
export const STREAM_SIZE = { min: 10, max: 32 } as const;

/** The same for the overlay's two sliders. Wide: it sits over video, so small is common. */
export const SUB_SIZE = { min: 12, max: 72 } as const;

export interface SubtitleStyle {
  show: boolean;
  mode: SubMode;
  opacity: number; // background alpha, 0..1
  /** The overlay's two rows, sized independently in px. */
  srcSize: number;
  tgtSize: number;
  color: string; // translation
  srcColor: string; // source transcript
  outline: boolean;
  align: SubAlign;
  /** Not style, but it travels with it: the overlay reports it, the main window stores it. */
  rect: SubRect | null;
  /** true: wrap and grow the window to the text. false: one line per row, tail-aligned. */
  grow: boolean;
  locked: boolean; // click-through
}

/**
 * The message format, which follows the protocol rather than the vendor: Qwen3.8 speaks a
 * different schema from Qwen3/3.5. Model and URL are free-form on top of it.
 */
export type Protocol = "qwen35" | "qwen38" | "openai" | "gemini";

/** Where each vendor's key lives. A key belongs to the account, not the protocol. */
const KEY_FIELD = { qwen: "apiKey", openai: "openaiKey", gemini: "geminiKey" } as const;
const keyField = (p: Protocol) => KEY_FIELD[PROTOCOLS[p].vendor];
/** One protocol per credential-store slot, for the loops that visit every key once. */
const KEY_SLOTS = ["qwen35", "openai", "gemini"] as const;

export interface Settings {
  protocol: Protocol;
  apiKey: string;
  openaiKey: string;
  geminiKey: string;
  /** Empty: the protocol's default endpoint. */
  url: string;
  /** What each protocol / vendor was last set to, restored when switching back to it. */
  savedModels: Partial<Record<Protocol, string>>;
  savedUrls: Partial<Record<Vendor, string>>;
  workspaceId: string;
  region: Region;
  sourceLang: string;
  targetLang: string;
  model: string;
  /** Off by default: translations are private, so nothing hits the disk unless asked. */
  history: boolean;
  /** Hotwords: source term -> preferred translation. Sent with `session.update`. */
  hotwords: Record<string, string>;
  /** Read the translation aloud. Only takes effect where `canSpeak` allows it. */
  speak: boolean;
  voice: string;
  theme: Theme;
  sub: SubtitleStyle;
  stream: StreamStyle;
}

export const settings = reactive<Settings>({
  protocol: "qwen35",
  apiKey: "",
  openaiKey: "",
  geminiKey: "",
  url: "",
  savedModels: {},
  savedUrls: {},
  workspaceId: "",
  region: "beijing",
  sourceLang: "auto",
  targetLang: "en",
  model: MODEL_QWEN3_5,
  history: false,
  hotwords: {},
  speak: false,
  voice: "Tina",
  theme: "system",
  sub: {
    show: false,
    mode: "both",
    opacity: 0.5,
    srcSize: 19,
    tgtSize: 30,
    color: "#ffffff",
    srcColor: "#a8c0dd",
    outline: true,
    align: "center",
    rect: null,
    grow: true,
    // Default to click-through: an always-on-top overlay otherwise eats every click inside
    // its window rect, transparent parts included. Turn it off to reposition the bar.
    locked: true,
  },
  stream: {
    srcSize: 13,
    tgtSize: 16,
  },
});

/** Keeps a size inside the slider's range — a hand-edited file can hold anything. */
const streamSize = (n: unknown, fallback: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(STREAM_SIZE.max, Math.max(STREAM_SIZE.min, Math.round(v)));
};

const subSize = (n: unknown, fallback: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(SUB_SIZE.max, Math.max(SUB_SIZE.min, Math.round(v)));
};

const FILE = "settings.json";
const KEY = "settings";
let store: Store | null = null;

/**
 * Whether the API key lives in the OS credential store. False only where there is none —
 * Linux without a Secret Service provider — and then it stays in settings.json as before.
 */
export const keyringOk = ref(true);

/** Load persisted settings; afterwards every change is written back automatically. */
export async function initSettings(persist = true) {
  store = await load(FILE, { autoSave: 200 });
  const saved = await store.get<Partial<Settings>>(KEY);
  if (saved) {
    Object.assign(settings, saved, {
      sub: { ...settings.sub, ...(saved.sub ?? {}) },
      stream: { ...settings.stream, ...(saved.stream ?? {}) },
    });
    // Saved before the protocol was a setting: the model was what picked the 3.8 schema.
    if (!saved.protocol) settings.protocol = saved.model === MODEL_QWEN3_8 ? "qwen38" : "qwen35";
    // Before the two rows were sized separately, the bar had one `fontSize` and the source
    // line was 0.62em of it. Carry that pair over so an existing install looks unchanged.
    const oldSub = saved.sub as (Partial<SubtitleStyle> & { fontSize?: number }) | undefined;
    if (oldSub && oldSub.srcSize == null && oldSub.tgtSize == null && oldSub.fontSize != null) {
      settings.sub.srcSize = Math.round(oldSub.fontSize * 0.62);
      settings.sub.tgtSize = oldSub.fontSize;
    }
  }
  settings.stream.srcSize = streamSize(settings.stream.srcSize, 13);
  settings.stream.tgtSize = streamSize(settings.stream.tgtSize, 16);
  settings.sub.srcSize = subSize(settings.sub.srcSize, 19);
  settings.sub.tgtSize = subSize(settings.sub.tgtSize, 30);

  keyringOk.value = (await invoke<{ keyring: boolean }>("platform")).keyring;
  if (keyringOk.value) {
    // Anything still in the file is from a build that predates the credential store (or a
    // hand-edited config). Move it across and blank it out — leaving the plaintext copy
    // behind would make the whole exercise pointless.
    for (const protocol of KEY_SLOTS) {
      const field = keyField(protocol);
      if (settings[field]) await invoke("set_api_key", { protocol, key: settings[field] });
      else settings[field] = await invoke<string>("get_api_key", { protocol });
    }
  }

  applyTheme();
  if (persist) {
    watch(settings, (v) => void store?.set(KEY, persistable(v)), { deep: true });
    if (keyringOk.value) {
      for (const protocol of KEY_SLOTS) {
        watch(() => settings[keyField(protocol)], (key) => saveApiKey(protocol, key));
      }
    }
  }
  watch(() => settings.theme, applyTheme);
}

/** The key of the protocol in use — the one a session will actually send. */
export function activeKey(): string {
  return settings[keyField(settings.protocol)];
}

export function setActiveKey(key: string) {
  settings[keyField(settings.protocol)] = key;
}

/** What goes to settings.json — never an API key once the credential store holds it. */
function persistable(v: Settings) {
  const plain = JSON.parse(JSON.stringify(v)) as Settings;
  if (keyringOk.value) for (const field of Object.values(KEY_FIELD)) plain[field] = "";
  return plain;
}

// Debounced: one credential-store write per pause, not one per keystroke.
const keyTimers: Partial<Record<Protocol, number>> = {};
function saveApiKey(protocol: Protocol, key: string) {
  clearTimeout(keyTimers[protocol]);
  keyTimers[protocol] = window.setTimeout(() => void invoke("set_api_key", { protocol, key }), 400);
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
dark.addEventListener("change", applyTheme);

/** The theme actually in effect, with "system" already resolved. */
export const resolvedTheme = ref<"light" | "dark">("light");

export function applyTheme() {
  resolvedTheme.value = settings.theme === "system" ? (dark.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = resolvedTheme.value;
}
