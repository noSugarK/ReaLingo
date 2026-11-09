<script setup lang="ts">
import Sheet from "./Sheet.vue";
import { settings } from "../core/store";
import { locale, t, type Locale } from "../core/i18n";

defineEmits<{ close: [] }>();

const options: { value: "system" | Locale; label: () => string }[] = [
  { value: "system", label: () => t("uiSystem") },
  { value: "zh", label: () => "简体中文" },
  { value: "en", label: () => "English" },
];

function pick(v: "system" | Locale) {
  settings.uiLang = v;
}
</script>

<template>
  <Sheet :title="t('uiLang')" @close="$emit('close')">
    <p class="hintx">{{ t('uiLangHint') }}</p>
    <div class="list">
      <button v-for="o in options" :key="o.value" class="langrow" :class="{ on: settings.uiLang === o.value }" @click="pick(o.value)">
        <span class="nm">
          {{ o.label() }}
          <small v-if="o.value === 'system'" class="det">{{ t('uiDetected').replace('{l}', locale === 'zh' ? '中文' : 'English') }}</small>
        </span>
        <svg class="ck" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>
      </button>
    </div>
  </Sheet>
</template>

<style scoped>
.hintx { margin: -6px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--ink-3); }
.list {
  border-radius: 16px; padding: 2px 0;
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
}
.langrow {
  width: 100%; display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 14px;
  color: var(--ink); font-size: 14.5px; text-align: left;
}
.langrow + .langrow { box-shadow: inset 0 1px 0 var(--hairline); }
.langrow .nm { flex: 1; }
.langrow .det { display: block; font-size: 11px; color: var(--ink-3); margin-top: 2px; }
.langrow .ck { color: var(--accent); display: none; }
.langrow.on .ck { display: block; }
.langrow.on { font-weight: 650; }
</style>
