<script setup lang="ts">
import { computed, ref, watch, toRaw } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { activeKey, keyringOk, REGION_ID, setActiveKey, settings, type Protocol, type Region } from "../store";
import { isRunning } from "../stream";
import { PRESETS, PROTOCOLS, type Vendor } from "../languages";
import { t } from "../i18n";
import Picker from "./Picker.vue";
import Sheet from "./Sheet.vue";

defineEmits<{ close: [] }>();

const endpoint = ref("");
// An explicit source list, not watchEffect: the call awaits before touching anything else,
// so only what is read synchronously is tracked — and a field missing from that list makes
// the preview silently lag one change behind.
watch(
  () => [settings.protocol, settings.url, settings.region, settings.workspaceId, settings.model],
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

const vendor = computed(() => PROTOCOLS[settings.protocol].vendor);
/** Region, workspace, hotwords and the Model Studio links only mean something for Qwen. */
const isQwen = computed(() => vendor.value === "qwen");

const presets = computed(() =>
  PRESETS[settings.protocol].map((p) => ({ value: p.id, label: p.name, note: `${p.langs} ${t("langsUnit")}` }))
);
const CUSTOM = "\0custom";
const modelOptions = computed(() => [...presets.value, { value: CUSTOM, label: t("modelCustom") }]);
// Its own flag rather than "model is not a preset": typing a preset's name into the custom
// field must not snap the picker back and take the field away mid-edit.
const customModel = ref(!presets.value.some((p) => p.value === settings.model));
const modelPick = computed({
  get: () => (customModel.value ? CUSTOM : settings.model),
  set: (v: string) => {
    customModel.value = v === CUSTOM;
    if (v !== CUSTOM) settings.model = v;
  },
});

const apiKey = computed({ get: activeKey, set: setActiveKey });

/**
 * A model belongs to one protocol and a URL to one vendor (the two Qwens share an endpoint),
 * so each is put away on the way out and brought back on return: a round trip through
 * another protocol no longer loses a custom model or proxy address.
 */
function pickProtocol(p: Protocol) {
  const from = settings.protocol;
  if (p === from) return;
  settings.savedModels[from] = settings.model;
  settings.savedUrls[PROTOCOLS[from].vendor] = settings.url;
  settings.protocol = p;
  settings.model = settings.savedModels[p] ?? PRESETS[p][0].id;
  settings.url = settings.savedUrls[PROTOCOLS[p].vendor] ?? "";
  customModel.value = !PRESETS[p].some((x) => x.id === settings.model);
}

// A dropdown, not a segmented row: the list grows with every protocol added.
const protocolOptions = computed(() => [
  { value: "qwen35", label: t("protocolQwen35"), note: t("vendorQwen") },
  { value: "qwen38", label: t("protocolQwen38"), note: t("vendorQwen") },
  { value: "openai", label: t("protocolOpenai") },
  { value: "gemini", label: t("protocolGemini"), note: "Google" },
  { value: "volc", label: t("protocolVolc"), note: t("vendorVolc") },
]);
const protocolPick = computed({
  get: () => settings.protocol as string,
  set: (v: string) => pickProtocol(v as Protocol),
});

/** Model Studio console pages are per region; the region id is part of the path. */
const consoleUrl = (page: string) => `https://bailian.console.aliyun.com/${REGION_ID[settings.region]}/${page}`;
const keyConsole = computed(
  () =>
    ({
      qwen: consoleUrl("model/settings/api-key"),
      openai: "https://platform.openai.com/api-keys",
      gemini: "https://aistudio.google.com/apikey",
      volc: "https://console.volcengine.com/speech/new/setting/apikeys",
    })[vendor.value]
);
const KEY_LABEL = { qwen: "apiKeyGet", openai: "apiKeyGetOpenai", gemini: "apiKeyGetGemini", volc: "apiKeyGetVolc" } as const;
/** Where a vendor's key has to be switched on before it works: Volcengine's needs the model
 *  enabled by hand, on a page of its own. */
const ACTIVATE: Partial<Record<Vendor, string>> = { volc: "https://console.volcengine.com/speech/new/setting/activate" };
const activateUrl = computed(() => ACTIVATE[vendor.value]);
const keyConsoleLabel = computed(() => t(KEY_LABEL[vendor.value]));
// The opener plugin, not an <a href>: a plain link navigates the app's own webview away.
const openUrl = (url: string) => invoke("plugin:opener|open_url", { url });

// A dropdown even with two entries: more regions will come once they carry the models.
const regionOptions = computed(() => [
  { value: "beijing", label: t("regionBJ") },
  { value: "singapore", label: t("regionSG") },
]);
const regionPick = computed({
  get: () => settings.region as string,
  set: (v: string) => (settings.region = v as Region),
});

/** Starts open when something in it is already set, so a configured override is never hidden. */
const advancedOpen = !!settings.url;
</script>

<template>
  <Sheet :title="t('settings')" @close="$emit('close')">
    <section class="group">
      <h3>{{ t("groupConn") }}</h3>

      <div class="field">
        <span class="label">{{ t("protocol") }}</span>
        <Picker v-model="protocolPick" :options="protocolOptions" :disabled="isRunning()" />
        <small v-if="isQwen">{{ t("protocolHint") }}</small>
      </div>

      <label class="field">
        <span class="label">{{ t("apiKey") }}</span>
        <input v-model="apiKey" type="password" placeholder="sk-..." spellcheck="false" />
        <small>
          {{ keyringOk ? t("apiKeyHint") : t("apiKeyPlain") }}
          <button class="link" @click.prevent="openUrl(keyConsole)">
            {{ keyConsoleLabel }} ↗
          </button>
          <button v-if="activateUrl" class="link" @click.prevent="openUrl(activateUrl)">
            {{ t("volcActivate") }} ↗
          </button>
        </small>
      </label>

      <div class="field">
        <span class="label">{{ t("model") }}</span>
        <Picker v-model="modelPick" :options="modelOptions" :disabled="isRunning()" />
        <input
          v-if="customModel"
          v-model.trim="settings.model"
          type="text"
          :placeholder="t('modelCustomPh')"
          :disabled="isRunning()"
          spellcheck="false"
        />
        <!-- Regions carry different model lists; worth checking before blaming the app. -->
        <small v-if="isQwen">
          <button class="link" @click.prevent="openUrl(consoleUrl('model/market'))">{{ t("modelsLink") }} ↗</button>
        </small>
      </div>

      <div v-if="isQwen" class="field">
        <span class="label">{{ t("region") }}</span>
        <Picker v-model="regionPick" :options="regionOptions" :disabled="isRunning()" />
      </div>

      <label v-if="isQwen" class="field">
        <span class="label">{{ t("workspace") }}</span>
        <!-- Beijing workspace IDs start with "llm-", every other region's with "ws-". -->
        <input
          v-model.trim="settings.workspaceId"
          type="text"
          :placeholder="settings.region === 'beijing' ? 'llm-xxxxxxxx' : 'ws-xxxxxxxx'"
          :disabled="isRunning()"
          spellcheck="false"
        />
        <small>
          {{ t("workspaceHint") }}
          <button class="link" @click.prevent="openUrl(consoleUrl('settings/workspace'))">{{ t("workspaceManage") }} ↗</button>
        </small>
      </label>
    </section>

    <!-- Hotwords are the group's only item, so its name rides on the title line. -->
    <section v-if="isQwen" class="group">
      <h3>{{ t("groupTranslate") }} <span class="sub">{{ t("hotwords") }}</span></h3>
      <textarea
        v-model="hotwordText"
        :aria-label="t('hotwords')"
        :disabled="isRunning()"
        rows="4"
        spellcheck="false"
        placeholder="人工智能=Artificial Intelligence"
      ></textarea>
      <small class="hint">
        {{ t("hotwordsHint") }}
        <template v-if="hotwordCount"> · {{ hotwordCount }} {{ t("hotwordsInUse") }}</template>
      </small>
    </section>

    <!-- Native <details>: the open/closed state and keyboard handling come for free. -->
    <details class="group" :open="advancedOpen">
      <summary>{{ t("groupAdvanced") }}</summary>
      <div class="group-body">
        <label class="field">
          <span class="label">{{ t("url") }}</span>
          <input v-model.trim="settings.url" type="text" placeholder="wss://..." :disabled="isRunning()" spellcheck="false" />
          <small>{{ PROTOCOLS[settings.protocol].urlAsIs ? t("urlHintAsIs") : t("urlHint") }}</small>
        </label>

        <div class="field">
          <span class="label">{{ t("endpoint") }}</span>
          <code class="endpoint">{{ endpoint }}</code>
        </div>
      </div>
    </details>
  </Sheet>
</template>

<style scoped>
.group { display: flex; flex-direction: column; gap: 14px; }
.group + .group { padding-top: 16px; border-top: 1px solid var(--hairline); }
/* A step above the field labels, or the group titles read as just another field. */
.group > h3, .group > summary { margin: 0; font-size: 13px; font-weight: 700; color: var(--ink); }
summary { cursor: pointer; list-style-position: inside; }
/* <details> does not hand flex layout to its content, so the body spaces itself. */
.group-body { display: flex; flex-direction: column; gap: 14px; }

.group > h3 .sub { margin-left: 6px; font-weight: 500; color: var(--ink-3); }

/* Label left, control right, everything else (custom-model input, hint) under the control —
   one row per setting instead of a label line plus a full-width control line. */
.field {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  column-gap: 12px;
  row-gap: 6px;
}
.field > :not(.label) { grid-column: 2; }
textarea {
  font-family: "SF Mono", "Cascadia Code", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.field small, .hint { font-size: 11.5px; line-height: 1.5; color: var(--ink-3); }
.group > .hint { margin-top: -6px; }

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

</style>
