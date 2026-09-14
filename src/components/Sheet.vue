<script setup lang="ts">
import { t } from "../i18n";

defineProps<{ title: string }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="scrim" @click.self="$emit('close')">
    <div class="sheet glass">
      <header class="sheet-head">
        <h2>{{ title }}</h2>
        <button class="btn-icon" :aria-label="t('close')" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="sheet-body">
        <slot />
      </div>
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
  padding: min(40px, 4vh) 24px;
  background: rgba(8, 10, 16, 0.34);
  backdrop-filter: blur(6px);
  animation: fade 0.2s var(--ease);
}
@keyframes fade { from { opacity: 0; } }

/* min-height: 0 on both — a grid item and a flex item each default to min-height: auto,
   which overrides max-height and pushes the sheet past a short window instead of scrolling. */
.sheet {
  width: min(520px, 100%);
  max-height: 100%;
  min-height: 0;
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
  padding: 12px 20px 18px;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
</style>
