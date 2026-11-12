<script setup lang="ts">
import { computed } from "vue";
import Sheet from "./Sheet.vue";
import ChoiceList from "./ChoiceList.vue";
import { settings } from "../core/store";
import { t, type Locale } from "../core/i18n";

defineEmits<{ close: [] }>();

const options = computed(() => [
  { value: "system", label: t("uiSystem"), description: t("uiDetected").replace("{l}", navigator.language.startsWith("zh") ? "中文" : "English") },
  { value: "zh", label: "简体中文" },
  { value: "en", label: "English" },
]);

function pick(v: "system" | Locale) {
  settings.uiLang = v;
}
</script>

<template>
  <Sheet :title="t('uiLang')" @close="$emit('close')">
    <p class="hintx">{{ t('uiLangHint') }}</p>
    <ChoiceList :label="t('uiLang')" :value="settings.uiLang" :options="options" @select="pick($event as 'system' | Locale)" />
  </Sheet>
</template>

<style scoped>
.hintx { margin: -6px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--ink-3); }
</style>
