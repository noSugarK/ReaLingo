import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

const SLUG = "noSugarK/ReaLingo";
export const REPO = `https://github.com/${SLUG}`;
/** Where "there is a new version" leads: the project page, with the download buttons on it. */
export const HOME = "https://nosugark.github.io/ReaLingo/";

export type CheckState = "idle" | "checking" | "latest" | "found" | "failed";

/** Shared by the title bar and the About sheet — one check, one answer, one place. */
export const check = ref<{ state: CheckState; tag?: string }>({ state: "idle" });

/** "1.2.10" > "1.2.9": compare numerically per segment, not as strings. */
export function isNewer(tag: string, current: string) {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parts(tag), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * Asks GitHub for the latest release rather than bundling an updater: no signing keys to
 * manage, and the user installs from the same page they downloaded from. Draft and
 * prerelease tags are excluded by the `/latest` endpoint itself.
 */
export async function checkUpdate() {
  if (check.value.state === "checking") return;
  check.value = { state: "checking" };
  try {
    const r = await fetch(`https://api.github.com/repos/${SLUG}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(String(r.status));
    const tag = (await r.json()).tag_name as string;
    const current = await getVersion();
    check.value = isNewer(tag, current) ? { state: "found", tag } : { state: "latest", tag };
  } catch {
    check.value = { state: "failed" };
  }
}

/**
 * Startup check, once per launch. Quiet on purpose: a failure here is a network blip, not
 * something to interrupt someone who opened the app to translate a meeting. Only a real
 * find shows up, as the badge in the title bar.
 */
export async function checkUpdateAtStartup() {
  await checkUpdate();
  if (check.value.state === "failed") check.value = { state: "idle" };
}

// Always via the opener plugin — an <a href> navigates the app's own webview away.
export const openHome = () => invoke("plugin:opener|open_url", { url: HOME });
