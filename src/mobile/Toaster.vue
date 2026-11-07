<script setup lang="ts">
import { dismiss, toasts } from "./toasts";
</script>

<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="m in toasts" :key="m.id" class="toast glass-thin">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--warn)" stroke-width="1.8" stroke-linecap="round" style="flex: none">
            <circle cx="8" cy="8" r="6.6" /><path d="M8 4.8v4M8 10.9v.1" />
          </svg>
          <span>{{ m.text }}</span>
          <button v-if="m.action" @click="m.action.run(); dismiss(m.id)">{{ m.action.label }}</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
/* Top-right stack, auto-dismissing after 3 s — the design's rule for every transient
   notice, so nothing on screen ever eats a tap the user meant for the stream. */
.toasts {
  position: fixed;
  top: calc(54px + env(safe-area-inset-top));
  right: 14px;
  left: 56px;
  z-index: 140;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 11px 14px;
  border-radius: 16px;
  background: rgba(11, 13, 19, 0.92);
  box-shadow: 0 14px 34px -12px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.toast span { font-size: 12px; line-height: 1.45; color: rgba(255, 255, 255, 0.84); font-weight: 560; }
.toast button {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 11.5px;
  font-weight: 680;
  pointer-events: auto;
}
.toast-enter-active, .toast-leave-active { transition: all 0.3s var(--ease); }
.toast-enter-from { opacity: 0; transform: translateX(14px); }
.toast-leave-to { opacity: 0; transform: translateX(14px); }
</style>
