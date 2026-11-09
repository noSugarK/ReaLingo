<script setup lang="ts">
import Sheet from "./Sheet.vue";
import { session } from "../core/session";
import { settings } from "../core/store";
import { audioMs, lastServerEvent, lastServerError, connectionPhase } from "../core/stream";
import { t } from "../core/i18n";
defineEmits<{ close: [] }>();
</script>
<template>
  <Sheet :title="t('diagnostics')" @close="$emit('close')">
    <dl>
      <dt>{{ t('sessionState') }}</dt><dd>{{ t(session.statusKey.value) }}</dd>
      <dt>{{ t('connectionPhase') }}</dt><dd>{{ connectionPhase ? t(({ capture: 'phaseCapture', network: 'phaseNetwork', setup: 'phaseSetup' } as const)[connectionPhase as 'capture' | 'network' | 'setup']) : '—' }}</dd>
      <dt>{{ t('protocol') }}</dt><dd>{{ settings.protocol }}</dd>
      <dt>{{ t('model') }}</dt><dd>{{ settings.model }}</dd>
      <dt>{{ t('inputLevel') }}</dt><dd>{{ Math.round(session.level.value * 100) }}%</dd>
      <dt>{{ t('audioSent') }}</dt><dd>{{ (audioMs / 1000).toFixed(1) }} s</dd>
      <dt>{{ t('lastServerEvent') }}</dt><dd>{{ lastServerEvent || t('noServerEvent') }}</dd>
      <dt>{{ t('lastServerError') }}</dt><dd>{{ lastServerError || '—' }}</dd>
    </dl>
    <p>{{ t('diagnosticsHint') }}</p>
  </Sheet>
</template>
<style scoped>
dl { display: grid; grid-template-columns: auto 1fr; gap: 12px; font-size: 14px; }
dt, p { color: var(--ink-3); }
dd { margin: 0; overflow-wrap: anywhere; user-select: text; }
p { font-size: 12px; line-height: 1.5; }
</style>
