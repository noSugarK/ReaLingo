import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

const SLUG = "noSugarK/ReaLingo";
export const REPO = `https://github.com/${SLUG}`;
/** Where "there is a new version" leads: the project page, with the download buttons on it. */
export const HOME = "https://nosugark.github.io/ReaLingo/";

export type CheckState = "idle" | "checking" | "latest" | "found" | "failed";

/**
 * Shared by the title bar and the About sheet — one check, one answer, one place. `body` is
 * that release's full text; the About sheet picks the news out of it with `whatsNew`.
 */
export const check = ref<{ state: CheckState; tag?: string; body?: string }>({ state: "idle" });

/**
 * The news in a release body, in the UI language where the body offers one.
 *
 * Release bodies are `.github/release-notes/<tag>.md` followed by GitHub's generated
 * changelog. A bilingual notes file marks its halves with HTML comments, which GitHub's page
 * hides, so both languages show there while the app takes just one:
 *
 *     <!-- zh -->
 *     ## 新增
 *     - …
 *     <!-- en -->
 *     ## New
 *     - …
 *
 * Within the chosen part (or the whole body, for older single-language notes) the news ends
 * at the standing sections — feature list, install steps — or at the generated changelog.
 */
export function whatsNew(body: string, locale: "zh" | "en"): string {
  let lines = body.replace(/\r\n/g, "\n").split("\n");
  const marker = (l: string) => /^<!--\s*(zh|en)\s*-->$/.exec(l.trim())?.[1];
  const start = lines.findIndex((l) => marker(l) === locale);
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const next = rest.findIndex((l) => marker(l) !== undefined);
    lines = next < 0 ? rest : rest.slice(0, next);
  }
  // `(\s|$)`, not `\b`: to a JS regex CJK characters are not word characters, so "\b" after
  // "功能一览" never matched and the whole install guide came along.
  const stop = /^(## (功能一览|安装与打开|Features|Install|What's Changed|New Contributors)(\s|$)|\*\*Full Changelog\*\*)/;
  const end = lines.findIndex((l) => stop.test(l.trim()));
  return (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
}

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
    const release = await r.json();
    const tag = release.tag_name as string;
    const body = (release.body as string) ?? "";
    const current = await getVersion();
    check.value = { state: isNewer(tag, current) ? "found" : "latest", tag, body };
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
