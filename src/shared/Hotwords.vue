<script setup lang="ts">
import { ref, watch } from "vue";
import { settings } from "../core/store";
import { isRunning } from "../core/stream";
import { t } from "../core/i18n";
import { parseHotwords } from "../core/hotwords";
// Keep incomplete lines while typing; serializing the map would move the caret.
const text = ref(Object.entries(settings.hotwords).map(([k, v]) => `${k}=${v}`).join("\n"));
watch(text, (value) => { settings.hotwords = parseHotwords(value); });
</script>
<template>
  <label class="hotwords">
    <b>{{ t("hotwords") }}</b>
    <textarea v-model="text" :aria-label="t('hotwords')" :disabled="isRunning()" rows="4" spellcheck="false" placeholder="人工智能=Artificial Intelligence" />
    <small>{{ t("hotwordsHint") }} · {{ Object.keys(settings.hotwords).length }} {{ t("hotwordsInUse") }}</small>
  </label>
</template>
<style scoped>
.hotwords { display: flex; flex-direction: column; gap: 8px; }
textarea { width: 100%; box-sizing: border-box; min-height: 100px; padding: 12px; resize: vertical; border: 1px solid var(--hairline); border-radius: 12px; color: var(--ink); background: var(--shade); font: inherit; font-size: 16px; }
small { color: var(--ink-3); font-size: 12px; line-height: 1.5; }
</style>
