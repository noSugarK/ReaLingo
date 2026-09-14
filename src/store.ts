import { reactive, ref, watch } from "vue";
import { load, type Store } from "@tauri-apps/plugin-store";
import { MODEL_NEW } from "./languages";

export type Region = "beijing" | "singapore";
export type Theme = "system" | "light" | "dark";
export type SubMode = "both" | "target" | "source";

export interface SubtitleStyle {
  show: boolean;
  mode: SubMode;
  opacity: number; // background alpha, 0..1
  fontSize: number;
  color: string; // translation
  srcColor: string; // source transcript
  outline: boolean;
  locked: boolean; // click-through
}

export interface Settings {
  apiKey: string;
  workspaceId: string;
  region: Region;
  sourceLang: string;
  targetLang: string;
  model: string;
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
  theme: "system",
  sub: {
    show: false,
    mode: "both",
    opacity: 0.5,
    fontSize: 30,
    color: "#ffffff",
    srcColor: "#a8c0dd",
    outline: true,
    // Default to click-through: an always-on-top overlay otherwise eats every click inside
    // its window rect, transparent parts included. Turn it off to reposition the bar.
    locked: true,
  },
});

const FILE = "settings.json";
const KEY = "settings";
let store: Store | null = null;

/** Load persisted settings; afterwards every change is written back automatically. */
export async function initSettings(persist = true) {
  store = await load(FILE, { autoSave: 200 });
  const saved = await store.get<Partial<Settings>>(KEY);
  if (saved) {
    Object.assign(settings, saved, { sub: { ...settings.sub, ...(saved.sub ?? {}) } });
  }
  applyTheme();
  if (persist) {
    watch(settings, (v) => void store?.set(KEY, JSON.parse(JSON.stringify(v))), { deep: true });
  }
  watch(() => settings.theme, applyTheme);
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
dark.addEventListener("change", applyTheme);

/** The theme actually in effect, with "system" already resolved. */
export const resolvedTheme = ref<"light" | "dark">("light");

export function applyTheme() {
  resolvedTheme.value = settings.theme === "system" ? (dark.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = resolvedTheme.value;
}
