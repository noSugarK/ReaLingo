<script setup lang="ts">
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../core/i18n";
import { REPO } from "../core/update";

const props = defineProps<{ version: string }>();
const EMAIL = "nosugark@qq.com";
const error = ref("");
const links = computed(() => [
  {
    label: "GitHub", title: `${t("aboutRepo")} · noSugarK/ReaLingo`, url: REPO, github: true,
    path: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z",
  },
  { label: t("aboutAuthor"), title: `${t("aboutAuthor")} · noSugarK`, url: "https://github.com/noSugarK", path: "M20 21v-2a7 7 0 0 0-14 0v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" },
  { label: t("aboutIssues"), title: t("aboutIssuesLink"), url: `${REPO}/issues`, path: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" },
  { label: t("aboutEmail"), title: EMAIL, url: `mailto:${EMAIL}?subject=${encodeURIComponent(`ReaLingo v${props.version} feedback`)}`, path: "M3 5h18v14H3V5Zm0 1 9 7 9-7" },
  { label: t("aboutLicense"), title: "MIT License", url: `${REPO}/blob/main/LICENSE`, path: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h6" },
]);

async function open(url: string) {
  error.value = "";
  try {
    await invoke("plugin:opener|open_url", { url });
  } catch {
    error.value = url.startsWith("mailto:") ? `${t("aboutEmailFailed")} ${EMAIL}` : t("aboutOpenFailed");
  }
}
</script>

<template>
  <div>
    <nav class="links" :aria-label="t('about')">
      <button v-for="link in links" :key="link.url" type="button" :title="link.title" :aria-label="link.title" @click="open(link.url)">
        <svg width="20" height="20" :viewBox="link.github ? '0 0 16 16' : '0 0 24 24'" :fill="link.github ? 'currentColor' : 'none'" :stroke="link.github ? 'none' : 'currentColor'" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="link.path" />
        </svg>
        <span>{{ link.label }}</span>
      </button>
    </nav>
    <p v-if="error" class="error" role="status">{{ error }}</p>
  </div>
</template>

<style scoped>
.links { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.links button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; min-width: 0; min-height: 58px; padding: 8px 2px; border-radius: 10px; color: var(--ink-2); }
.links button:hover { background: var(--shade); color: var(--ink); }
.links button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.links button span { font-size: 11px; line-height: 1.4; }
.error { margin: 8px 0 0; color: var(--danger); font-size: 12px; line-height: 1.5; user-select: text; overflow-wrap: anywhere; }
</style>
