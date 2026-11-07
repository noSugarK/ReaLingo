<script setup lang="ts">
import { computed, ref } from "vue";
import Sheet from "./Sheet.vue";
import { session } from "../session";
import { settings } from "../store";
import { t } from "../i18n";

defineEmits<{ close: [] }>();

const query = ref("");

/** Only languages the current API/model supports — the same repaired list the desktop
 *  pickers share (session.targetLangOptions), searched rather than dropdowned because 60
 *  entries do not fit a thumb. The table's order is already by usefulness. */
const targetOpts = computed(() => session.targetLangOptions.value);
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return targetOpts.value;
  return targetOpts.value.filter((o) => `${o.label} ${o.value} ${o.keywords ?? ""}`.toLowerCase().includes(q));
});

/** Quick chips for the five most-picked targets, shown while the search box is empty. */
const QUICK = ["en", "ja", "ko", "fr", "de"];
const chips = computed(() => targetOpts.value.filter((o) => QUICK.includes(o.value)).slice(0, 5));

function pickTarget(code: string) {
  if (settings.targetLang === code) return;
  // Collision rule (design): the source side yields. Detect-able protocols fall back to
  // auto; `named` ones (Doubao) must swap to the other hub language instead.
  if (settings.sourceLang === code) {
    settings.sourceLang = session.sourceMode.value === "named" ? (code === "zh" ? "en" : "zh") : "auto";
  }
  settings.targetLang = code;
}

function pickSource(code: string) {
  if (settings.sourceLang === code) return;
  if (code !== "auto" && settings.targetLang === code) settings.targetLang = code === "zh" ? "en" : "zh";
  settings.sourceLang = code;
}

/** Source chips: one row, default auto. Only when manual selection exists at all — on
 *  detect-only APIs the language card shows the fixed value, nothing to pick here. */
const srcChips = computed(() => session.sourceLangOptions.value);
const showSrc = computed(() => session.sourceMode.value !== "detected");
</script>

<template>
  <Sheet :title="t('langTitle')" @close="$emit('close')">
    <section>
      <span class="glabel">{{ t('gTarget') }}</span>
      <div class="field">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--ink-3)" stroke-width="1.7" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.6 10.6 3 3"/></svg>
        <input v-model="query" type="search" :placeholder="t('tgtSearchPh')" spellcheck="false" autocomplete="off">
      </div>

      <div v-if="!query" class="chips">
        <button v-for="o in chips" :key="o.value" class="chipm" :class="{ on: settings.targetLang === o.value }" @click="pickTarget(o.value)">
          {{ o.label }}
        </button>
      </div>

      <div class="list">
        <button v-for="o in filtered" :key="o.value" class="langrow" :class="{ on: settings.targetLang === o.value }" @click="pickTarget(o.value)">
          <span class="nm">{{ o.label }}</span>
          <span class="code">{{ o.value }}</span>
          <svg class="ck" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>
        </button>
        <p v-if="!filtered.length" class="none">{{ t('langNoMatch') }}</p>
      </div>
      <p class="hintx">{{ query ? (filtered.length + ' ' + t('langsUnit')) : t('langCount') }}</p>
    </section>

    <section v-if="showSrc">
      <span class="glabel">{{ t('gSource') }}</span>
      <div class="chips">
        <button v-for="o in srcChips" :key="o.value" class="chipm" :class="{ on: settings.sourceLang === o.value }" @click="pickSource(o.value)">
          {{ o.label }}
        </button>
      </div>
      <p class="hintx">{{ t('srcHintPhone') }}</p>
    </section>
  </Sheet>
</template>

<style scoped>
section { display: flex; flex-direction: column; }
.glabel { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 9px; }
.field {
  width: 100%; height: 42px; padding: 0 14px; border-radius: 13px;
  background: var(--shade); border: 1px solid var(--hairline);
  display: flex; align-items: center; gap: 9px; color: var(--ink); font-size: 14px;
}
.field input { flex: 1; border: 0; background: none; outline: none; font-family: inherit; font-size: 14px; color: var(--ink); min-width: 0; }
.field input::placeholder { color: var(--ink-3); }
.chips { margin-top: 9px; display: flex; gap: 7px; flex-wrap: wrap; }
.chipm {
  height: 32px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 999px;
  font-size: 12.5px; font-weight: 650; color: var(--ink-2);
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
}
.chipm.on { background: var(--accent); color: #fff; box-shadow: none; }
.list {
  margin-top: 9px; border-radius: 15px; padding: 2px 0;
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
  max-height: 230px; overflow-y: auto;
}
.langrow {
  width: 100%; display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 14px;
  color: var(--ink); font-size: 14.5px;
}
.langrow + .langrow { box-shadow: inset 0 1px 0 var(--hairline); }
.langrow .nm { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.langrow .code { font-size: 11px; color: var(--ink-3); font-weight: 600; font-family: ui-monospace, monospace; }
.langrow .ck { margin-left: 2px; color: var(--accent); display: none; }
.langrow.on .ck { display: block; }
.langrow.on { font-weight: 650; }
.none { padding: 14px; margin: 0; text-align: center; color: var(--ink-3); font-size: 13px; }
.hintx { margin: 8px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--ink-3); }
</style>
