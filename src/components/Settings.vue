<script setup lang="ts">
import { ref, watchEffect, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { settings, type Region, type Theme } from "../store";
import { locale, setLocale, t, type Locale } from "../i18n";

defineEmits<{ close: [] }>();

const endpoint = ref("");
watchEffect(async () => {
  // Touch the fields the URL depends on so the preview re-runs when they change.
  void [settings.region, settings.workspaceId];
  endpoint.value = await invoke<string>("endpoint_url", { settings: toRaw(settings) });
});

const regions: [Region, "regionBJ" | "regionSG"][] = [
  ["beijing", "regionBJ"],
  ["singapore", "regionSG"],
];
const themes: [Theme, "themeSystem" | "themeLight" | "themeDark"][] = [
  ["system", "themeSystem"],
  ["light", "themeLight"],
  ["dark", "themeDark"],
];
</script>

<template>
  <div class="scrim" @click.self="$emit('close')">
    <div class="sheet glass">
      <header class="sheet-head">
        <h2>{{ t("settings") }}</h2>
        <button class="btn-icon" :aria-label="t('close')" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="sheet-body">
        <label class="field">
          <span class="label">{{ t("apiKey") }}</span>
          <input v-model="settings.apiKey" type="password" placeholder="sk-..." spellcheck="false" />
          <small>{{ t("apiKeyHint") }}</small>
        </label>

        <label class="field">
          <span class="label">{{ t("region") }}</span>
          <div class="seg">
            <button
              v-for="[value, key] in regions"
              :key="value"
              :class="{ on: settings.region === value }"
              @click="settings.region = value"
            >
              {{ t(key) }}
            </button>
          </div>
        </label>

        <label class="field">
          <span class="label">{{ t("workspace") }}</span>
          <input v-model="settings.workspaceId" type="text" placeholder="llm-xxxxxxxx" spellcheck="false" />
          <small>{{ t("workspaceHint") }}</small>
        </label>

        <div class="field">
          <span class="label">{{ t("endpoint") }}</span>
          <code class="endpoint">{{ endpoint }}</code>
        </div>

        <hr />

        <label class="field">
          <span class="label">{{ t("theme") }}</span>
          <div class="seg">
            <button
              v-for="[value, key] in themes"
              :key="value"
              :class="{ on: settings.theme === value }"
              @click="settings.theme = value"
            >
              {{ t(key) }}
            </button>
          </div>
        </label>

        <label class="field">
          <span class="label">{{ t("uiLang") }}</span>
          <div class="seg">
            <button
              v-for="l in (['zh', 'en'] as Locale[])"
              :key="l"
              :class="{ on: locale === l }"
              @click="setLocale(l)"
            >
              {{ l === "zh" ? "中文" : "English" }}
            </button>
          </div>
        </label>
      </div>

      <footer class="sheet-foot">
        <button class="btn btn-primary" @click="$emit('close')">{{ t("close") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 40px 24px;
  background: rgba(8, 10, 16, 0.34);
  backdrop-filter: blur(6px);
  animation: fade 0.2s var(--ease);
}
@keyframes fade { from { opacity: 0; } }

.sheet {
  width: min(520px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-xl);
  animation: rise 0.28s var(--ease);
}
@keyframes rise { from { opacity: 0; transform: translateY(14px) scale(0.98); } }

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 6px;
}
.sheet-head h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }

.sheet-body {
  padding: 12px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.sheet-foot { padding: 8px 20px 18px; display: flex; justify-content: flex-end; }

.field { display: flex; flex-direction: column; gap: 7px; }
.field small { font-size: 11.5px; line-height: 1.5; color: var(--ink-3); }

.endpoint {
  font-family: "SF Mono", "Cascadia Code", ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  background: var(--shade);
  color: var(--ink-2);
  word-break: break-all;
  user-select: text;
}

hr { border: none; border-top: 1px solid var(--hairline); margin: 0; }
</style>
