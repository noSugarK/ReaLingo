<script setup lang="ts">
import { onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../i18n";
import Sheet from "./Sheet.vue";
import mark from "../assets/mark.png";

defineEmits<{ close: [] }>();

const REPO = "https://github.com/noSugarK/ReaLingo";
const AUTHOR = "https://github.com/noSugarK";

const version = ref("");
onMounted(async () => (version.value = await getVersion()));

// Always via the opener plugin — an <a href> navigates the app's own webview away.
const open = (url: string) => invoke("plugin:opener|open_url", { url });

type Check = { state: "idle" | "checking" | "latest" | "found" | "failed"; tag?: string };
const check = ref<Check>({ state: "idle" });

/** "1.2.10" > "1.2.9": compare numerically per segment, not as strings. */
function isNewer(tag: string, current: string) {
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
async function checkUpdate() {
  check.value = { state: "checking" };
  try {
    const r = await fetch("https://api.github.com/repos/noSugarK/ReaLingo/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(String(r.status));
    const tag = (await r.json()).tag_name as string;
    check.value = isNewer(tag, version.value)
      ? { state: "found", tag }
      : { state: "latest", tag };
  } catch {
    check.value = { state: "failed" };
  }
}
</script>

<template>
  <Sheet :title="t('about')" @close="$emit('close')">
    <div class="hero">
      <img :src="mark" alt="" draggable="false" />
      <div>
        <strong>ReaLingo</strong>
        <span class="ver">v{{ version }}</span>
        <p>{{ t("aboutTagline") }}</p>
      </div>
    </div>

    <div class="update">
      <button class="btn" :disabled="check.state === 'checking'" @click="checkUpdate">
        {{ check.state === "checking" ? t("updChecking") : t("updCheck") }}
      </button>
      <button
        v-if="check.state === 'found'"
        class="btn btn-primary"
        @click="open(`${REPO}/releases/latest`)"
      >
        {{ t("updFound") }} {{ check.tag }} ↗
      </button>
      <span v-else-if="check.state === 'latest'" class="note">{{ t("updLatest") }}</span>
      <span v-else-if="check.state === 'failed'" class="note warn">{{ t("updFailed") }}</span>
    </div>

    <hr />

    <dl class="meta">
      <dt>{{ t("aboutRepo") }}</dt>
      <dd><button class="link" @click="open(REPO)">noSugarK/ReaLingo ↗</button></dd>

      <dt>{{ t("aboutAuthor") }}</dt>
      <dd><button class="link" @click="open(AUTHOR)">noSugarK ↗</button></dd>

      <dt>{{ t("aboutIssues") }}</dt>
      <dd><button class="link" @click="open(`${REPO}/issues`)">{{ t("aboutIssuesLink") }} ↗</button></dd>

      <dt>{{ t("aboutLicense") }}</dt>
      <dd><button class="link" @click="open(`${REPO}/blob/main/LICENSE`)">MIT ↗</button></dd>
    </dl>
  </Sheet>
</template>

<style scoped>
.hero { display: flex; align-items: center; gap: 14px; }
.hero img { width: 56px; height: auto; -webkit-user-drag: none; }
.hero strong { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.hero p { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--ink-3); }

.ver {
  margin-left: 7px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px; font-weight: 700;
  color: var(--accent);
  background: rgba(10, 132, 255, 0.12);
}

.update { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.update .btn { height: 32px; padding: 0 14px; font-size: 13px; }
.note { font-size: 12px; color: var(--ink-3); }
.note.warn { color: var(--danger); }

.meta {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 9px 16px;
  align-items: baseline;
  font-size: 13px;
}
.meta dt { color: var(--ink-3); font-size: 12px; }
.meta dd { margin: 0; }

.link {
  padding: 0;
  font: inherit; font-weight: 600;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.link:hover { filter: brightness(1.15); }

hr { border: none; border-top: 1px solid var(--hairline); margin: 0; }
</style>
