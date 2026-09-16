import { reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { MODEL_NEW } from "./languages";

export type Region = "beijing" | "singapore";
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

export interface SubtitleStyle {
  show: boolean;
  mode: SubMode;
  opacity: number; // background alpha, 0..1
  fontSize: number;
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

export interface Settings {
  apiKey: string;
  workspaceId: string;
  region: Region;
  sourceLang: string;
  targetLang: string;
  model: string;
  /** Off by default: translations are private, so nothing hits the disk unless asked. */
  history: boolean;
  /** Hotwords: source term -> preferred translation. Sent with `session.update`. */
  hotwords: Record<string, string>;
  theme: Theme;
  sub: SubtitleStyle;
}

export const settings = reactive<Settings>({
  apiKey: "",
  workspaceId: "",
  region: "beijing",
  sourceLang: "auto",
  targetLang: "en",
  model: MODEL_NEW,
  hotwords: {},
  history: false,
  theme: "system",
  sub: {
    show: false,
    mode: "both",
    opacity: 0.5,
    fontSize: 30,
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
});

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
    Object.assign(settings, saved, { sub: { ...settings.sub, ...(saved.sub ?? {}) } });
  }

  keyringOk.value = (await invoke<{ keyring: boolean }>("platform")).keyring;
  if (keyringOk.value) {
    // Anything still in the file is from a build that predates the credential store (or a
    // hand-edited config). Move it across and blank it out — leaving the plaintext copy
    // behind would make the whole exercise pointless.
    if (settings.apiKey) await invoke("set_api_key", { key: settings.apiKey });
    else settings.apiKey = await invoke<string>("get_api_key");
  }

  applyTheme();
  if (persist) {
    watch(settings, (v) => void store?.set(KEY, persistable(v)), { deep: true });
    if (keyringOk.value) watch(() => settings.apiKey, saveApiKey);
  }
  watch(() => settings.theme, applyTheme);
}

/** What goes to settings.json — never the API key once the credential store holds it. */
function persistable(v: Settings) {
  const plain = JSON.parse(JSON.stringify(v)) as Settings;
  if (keyringOk.value) plain.apiKey = "";
  return plain;
}

// Debounced: one credential-store write per pause, not one per keystroke.
let keyTimer: number | undefined;
function saveApiKey(key: string) {
  clearTimeout(keyTimer);
  keyTimer = window.setTimeout(() => void invoke("set_api_key", { key }), 400);
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
dark.addEventListener("change", applyTheme);

/** The theme actually in effect, with "system" already resolved. */
export const resolvedTheme = ref<"light" | "dark">("light");

export function applyTheme() {
  resolvedTheme.value = settings.theme === "system" ? (dark.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = resolvedTheme.value;
}
