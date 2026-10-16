<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import Slider from "./Slider.vue";
import { t } from "../i18n";
import { STREAM_SIZE } from "../store";

/** The two rows of the translation stream, sized independently. */
const props = defineProps<{ src: number; tgt: number }>();
const emit = defineEmits<{ "update:src": [number]; "update:tgt": [number] }>();

const open = ref(false);
const box = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const popStyle = ref<Record<string, string>>({});

/** Fixed so the popup can be placed before it has been laid out. */
const POP_W = 226;
const POP_H = 110;

/**
 * Teleported to <body> and placed by hand, for the same reason as Picker: the stream card
 * is a `.glass` of its own inside a flex column, so an in-flow panel would be painted
 * under the card and clipped by it.
 */
function place() {
  const r = box.value?.getBoundingClientRect();
  if (!r) return;
  const below = window.innerHeight - r.bottom;
  const flipUp = below < POP_H && r.top > below;
  popStyle.value = {
    // Right-aligned to the trigger, then kept inside the viewport.
    left: `${Math.max(8, Math.min(r.right - POP_W, window.innerWidth - POP_W - 8))}px`,
    width: `${POP_W}px`,
    ...(flipUp
      ? { bottom: `${window.innerHeight - r.top + 6}px` }
      : { top: `${r.bottom + 6}px` }),
  };
}

function onPointerDown(e: PointerEvent) {
  const target = e.target as Node;
  if (!box.value?.contains(target) && !pop.value?.contains(target)) open.value = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}

/** Capture-phase pointerdown, so a click anywhere else closes the panel. */
function bind(on: boolean) {
  const fn = on ? window.addEventListener : window.removeEventListener;
  const doc = on ? document.addEventListener : document.removeEventListener;
  doc.call(document, "pointerdown", onPointerDown as EventListener, true);
  fn.call(window, "keydown", onKey as EventListener);
  fn.call(window, "resize", place);
}

watch(open, async (v) => {
  bind(v);
  if (!v) return;
  place();
  await nextTick();
  place();
});

onBeforeUnmount(() => bind(false));

const SIZE_PROPS = { min: STREAM_SIZE.min, max: STREAM_SIZE.max, step: 1 } as const;
</script>

<template>
  <div ref="box" class="fs">
    <button
      class="chip fs-btn"
      :class="{ on: open }"
      :title="t('streamFont')"
      :aria-label="t('streamFont')"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="fs-aa">Aa</span>
      <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="pop" class="fs-pop" :style="popStyle">
        <div class="fs-row">
          <span class="fs-label">{{ t("streamSrc") }}</span>
          <Slider v-bind="SIZE_PROPS" :model-value="props.src" unit="px" @update:model-value="emit('update:src', $event)" />
        </div>
        <div class="fs-row">
          <span class="fs-label">{{ t("streamTgt") }}</span>
          <Slider v-bind="SIZE_PROPS" :model-value="props.tgt" unit="px" @update:model-value="emit('update:tgt', $event)" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.fs { display: flex; }

.fs-btn { display: flex; align-items: center; gap: 5px; padding: 0 8px; font-size: 13px; }
/* Stays legible while the panel is open, the way the active chip reads. */
.fs-btn.on { background: var(--accent); color: #fff; }
.fs-aa { font-weight: 700; letter-spacing: -0.02em; }
</style>

<!-- Teleported to <body>, so the panel cannot be scoped to this component. -->
<style>
.fs-pop {
  /* Not `.glass`: that utility's `position: relative` wins the cascade here (see Picker). */
  position: fixed;
  z-index: 120;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--r-md);
  background: var(--glass);
  backdrop-filter: blur(34px) saturate(185%);
  -webkit-backdrop-filter: blur(34px) saturate(185%);
  box-shadow: 0 20px 44px -14px rgba(10, 16, 40, 0.5), inset 0 1px 0 var(--glass-hi);
  animation: fs-pop-in 0.18s var(--ease);
}
@keyframes fs-pop-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
}

.fs-pop .fs-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.fs-pop .fs-label { flex: none; font-size: 12px; font-weight: 600; color: var(--ink-2); }
</style>
