<script setup lang="ts">
import { computed, ref, watch, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { keyringOk, settings, type Region, type Theme } from "../store";
import { isRunning } from "../stream";
import { MODEL_LEGACY, MODEL_NEW } from "../languages";
import { locale, setLocale, t, type Locale } from "../i18n";
import Picker from "./Picker.vue";
import Sheet from "./Sheet.vue";

defineEmits<{ close: [] }>();

const endpoint = ref("");
// An explicit source list, not watchEffect: the call awaits before touching anything else,
// so only what is read synchronously is tracked — and a field missing from that list makes
// the preview silently lag one change behind.
watch(
  () => [settings.region, settings.workspaceId, settings.model],
  async () => {
    endpoint.value = await invoke<string>("endpoint_url", { settings: toRaw(settings) });
  },
  { immediate: true }
);

/** The service asks for no more than this many; anything past it is dropped on parse. */
const MAX_HOTWORDS = 1000;

// A plain ref seeded once, not a two-way computed: re-serialising the map on every
// keystroke would rewrite the textarea mid-word (a line is unparseable until the "=" is
// typed) and throw the caret to the end. Text flows down on open, up on edit.
const hotwordText = ref(
  Object.entries(settings.hotwords)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
);
watch(hotwordText, (text) => {
  const entries = text
    .split("\n")
    .map((line) => {
      const i = line.indexOf("=");
      return i < 1 ? null : ([line.slice(0, i).trim(), line.slice(i + 1).trim()] as const);
    })
    .filter((e): e is readonly [string, string] => !!e && !!e[0] && !!e[1]);
  settings.hotwords = Object.fromEntries(entries.slice(0, MAX_HOTWORDS));
});
const hotwordCount = computed(() => Object.keys(settings.hotwords).length);

const modelOptions = computed(() => [
  { value: MODEL_NEW, label: t("modelNew"), note: "60" },
  { value: MODEL_LEGACY, label: t("modelLegacy"), note: "18" },
]);

/** The console page differs per region, and the intl one is English-only. */
const keyConsole = computed(() =>
  settings.region === "singapore"
    ? "https://bailian.console.alibabacloud.com/?tab=model#/api-key"
    : "https://bailian.console.aliyun.com/?tab=model#/api-key"
);
// The opener plugin, not an <a href>: a plain link navigates the app's own webview away.
const openConsole = () => invoke("plugin:opener|open_url", { url: keyConsole.value });

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
  <Sheet :title="t('settings')" @close="$emit('close')">
        <label class="field">
          <span class="label">{{ t("apiKey") }}</span>
          <input v-model="settings.apiKey" type="password" placeholder="sk-..." spellcheck="false" />
          <small>
            {{ keyringOk ? t("apiKeyHint") : t("apiKeyPlain") }}
            <button class="link" @click.prevent="openConsole">{{ t("apiKeyGet") }} ↗</button>
          </small>
        </label>

        <div class="field">
          <span class="label">{{ t("model") }}</span>
          <Picker v-model="settings.model" :options="modelOptions" />
          <small>{{ t("modelHint") }}</small>
        </div>

        <label class="field">
          <span class="label">{{ t("hotwords") }}</span>
          <textarea
            v-model="hotwordText"
            :disabled="isRunning()"
            rows="4"
            spellcheck="false"
            placeholder="人工智能=Artificial Intelligence"
          ></textarea>
          <small>
            {{ t("hotwordsHint") }}
            <template v-if="hotwordCount"> · {{ hotwordCount }} {{ t("hotwordsInUse") }}</template>
          </small>
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
  </Sheet>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 7px; }
textarea {
  font-family: "SF Mono", "Cascadia Code", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
}

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

.link {
  padding: 0;
  font: inherit;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.link:hover { filter: brightness(1.15); }

hr { border: none; border-top: 1px solid var(--hairline); margin: 0; }
</style>
