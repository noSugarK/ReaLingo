<script setup lang="ts">
import { computed, ref } from "vue";
import Sheet from "./Sheet.vue";
import { session } from "../core/session";
import { settings } from "../core/store";
import { t } from "../core/i18n";

const props = withDefaults(defineProps<{ side?: "source" | "target" }>(), { side: "target" });
defineEmits<{ close: [] }>();

/** One sheet, two tabs: whichever half of the language card was tapped opens its own tab,
 *  so the source side is never a row of chips buried under a 60-entry target list. */
const tab = ref(props.side);
const query = ref("");

const detectedOnly = computed(() => session.sourceMode.value === "detected");
// Only languages the current API/model supports: the same repaired lists the desktop
// pickers share. Searched rather than dropdowned because 60 entries do not fit a thumb.
const options = computed(() => (tab.value === "target" ? session.targetLangOptions.value : session.sourceLangOptions.value));
const selected = computed(() => (tab.value === "target" ? settings.targetLang : settings.sourceLang));
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return options.value;
  return options.value.filter((o) => `${o.label} ${o.value} ${"keywords" in o ? o.keywords ?? "" : ""}`.toLowerCase().includes(q));
});

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

const pick = (code: string) => (tab.value === "target" ? pickTarget(code) : pickSource(code));
function switchTab(side: "source" | "target") {
  tab.value = side;
  query.value = "";
}
</script>

<template>
  <Sheet :title="t('langTitle')" @close="$emit('close')">
    <div class="seg" role="tablist">
      <button role="tab" :aria-selected="tab === 'source'" :class="{ on: tab === 'source' }" @click="switchTab('source')">{{ t('from') }}</button>
      <button role="tab" :aria-selected="tab === 'target'" :class="{ on: tab === 'target' }" @click="switchTab('target')">{{ t('to') }}</button>
    </div>

    <p v-if="tab === 'source' && detectedOnly" class="note">{{ t('srcDetectedOnly') }}</p>
    <template v-else>
      <label class="m-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.6 10.6 3 3"/></svg>
        <input v-model="query" type="search" :placeholder="t('tgtSearchPh')" spellcheck="false" autocomplete="off">
      </label>

      <div class="list">
        <button v-for="o in filtered" :key="o.value" class="langrow" :class="{ on: selected === o.value }" @click="pick(o.value)">
          <span class="nm">{{ o.label }}</span>
          <span v-if="o.value !== 'auto'" class="code">{{ o.value }}</span>
          <svg class="ck" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>
        </button>
        <p v-if="!filtered.length" class="none">{{ t('langNoMatch') }}</p>
      </div>
      <p class="hintx">{{ tab === 'source' ? t('srcHintPhone') : t('langCount') }}</p>
    </template>
  </Sheet>
</template>

<style scoped>
.seg {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border-radius: 14px;
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
}
.seg button { height: 38px; border-radius: 10px; font-size: 14px; font-weight: 650; color: var(--ink-2); }
.seg button.on { background: var(--glass-hi); color: var(--ink); box-shadow: 0 2px 8px -3px rgba(0, 0, 0, 0.3); }
/* The list is the sheet's body, not a 230 px window inside it: the sheet scrolls, the
   search field stays in reach above it. */
.list { margin-top: -6px; border-radius: 15px; background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline); }
.langrow { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 50px; padding: 0 16px; color: var(--ink); font-size: 15px; }
.langrow + .langrow { box-shadow: inset 0 1px 0 var(--hairline); }
.langrow .nm { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.langrow .code { font-size: 11px; color: var(--ink-3); font-weight: 600; font-family: ui-monospace, monospace; }
.langrow .ck { color: var(--accent); visibility: hidden; }
.langrow.on .ck { visibility: visible; }
.langrow.on { font-weight: 680; color: var(--accent); }
.none, .note { padding: 14px; margin: 0; text-align: center; color: var(--ink-2); font-size: 13.5px; line-height: 1.6; }
.note { border-radius: 15px; background: var(--shade); }
.hintx { margin: -8px 2px 0; font-size: 12px; line-height: 1.55; color: var(--ink-3); }
</style>
