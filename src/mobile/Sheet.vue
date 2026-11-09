<script setup lang="ts">
import { t } from "../core/i18n";
defineProps<{ title?: string }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <div class="sheet-bg" @click.self="$emit('close')">
      <section class="sheet glass m-sheet" role="dialog" :aria-label="title">
        <div class="grab" />
        <button class="sheet-close" :aria-label="t('close')" @click="$emit('close')"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m3.5 3.5 9 9m0-9-9 9"/></svg></button>
        <h3 v-if="title">{{ title }}</h3>
        <div class="sheet-body"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Bottom sheet, the phone's counterpart of the desktop's centred modal. Same glass plate,
   but it rises from the thumb's edge and closes on the scrim or a drag down the page. */
.sheet-bg {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(6, 8, 14, 0.55);
  display: flex;
  align-items: flex-end;
  animation: fade 0.24s var(--ease);
}
@keyframes fade { from { opacity: 0; } }

.sheet {
  position: relative;
  width: 100%;
  max-height: 84%;
  overflow-y: auto;
  border-radius: 32px 32px 0 0;
  padding: 10px 20px calc(26px + env(safe-area-inset-bottom));
  animation: rise 0.32s var(--ease);
}
.sheet-close { position: absolute; top: 10px; right: 12px; width: 36px; height: 36px; border-radius: 50%; background: var(--shade); color: var(--ink-2); display: grid; place-items: center; }
@keyframes rise { from { transform: translateY(6%); opacity: 0.6; } }

.grab {
  width: 38px; height: 5px; margin: 0 auto 16px;
  border-radius: 999px;
  background: var(--ink);
  opacity: 0.2;
}
.sheet h3 { margin: 0; font-size: 19px; font-weight: 720; letter-spacing: -0.02em; }
.sheet-body { display: flex; flex-direction: column; gap: 18px; padding-top: 16px; }
</style>
