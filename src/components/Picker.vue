<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { t } from "../i18n";

export type PickerOption = {
  value: string;
  label: string;
  /** Trailing muted text — a language code, a device kind, … */
  note?: string;
  /** Extra text the search box matches on, e.g. the same name in the other UI language. */
  keywords?: string;
};

const props = defineProps<{
  modelValue: string;
  options: PickerOption[];
  /** Shown when nothing is selected, or when the list is empty. */
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);
const query = ref("");
const box = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const popStyle = ref<Record<string, string>>({});

const MAX_POP_H = 300;
/** A handful of audio devices needs no search box; 60+ languages very much does. */
const SEARCH_FROM = 10;

const searchable = computed(() => props.options.length > SEARCH_FROM);
const label = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.placeholder ?? ""
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) =>
    `${o.value} ${o.label} ${o.note ?? ""} ${o.keywords ?? ""}`.toLowerCase().includes(q)
  );
});

/**
 * The popup is teleported to <body> and positioned by hand. It has to be: every card is a
 * `.glass` (own stacking context) inside a scrolling sidebar, so an in-flow popup gets both
 * clipped by the scroller and painted under the card below it, whatever its z-index.
 */
function place() {
  const r = box.value?.getBoundingClientRect();
  if (!r) return;
  const below = window.innerHeight - r.bottom;
  const flipUp = below < MAX_POP_H && r.top > below;
  popStyle.value = {
    left: `${r.left}px`,
    width: `${r.width}px`,
    ...(flipUp
      ? { bottom: `${window.innerHeight - r.top + 6}px` }
      : { top: `${r.bottom + 6}px` }),
  };
}

function onPointerDown(e: PointerEvent) {
  const target = e.target as Node;
  if (!box.value?.contains(target) && !pop.value?.contains(target)) open.value = false;
}

/**
 * Keep the popup glued to its trigger while things move — never close on scroll.
 *
 * The picker lives in a scrolling sidebar, and the browser scrolls a freshly focused
 * trigger into view. A close-on-scroll handler therefore shot the popup down in the very
 * frame it opened, which looked like the dropdown refusing to open at all; one pixel of
 * scroll anywhere on the page was enough. Closing is left to an outside click or Esc.
 */
function bind(on: boolean) {
  const fn = on ? window.addEventListener : window.removeEventListener;
  const doc = on ? document.addEventListener : document.removeEventListener;
  doc.call(document, "pointerdown", onPointerDown as EventListener, true);
  fn.call(window, "resize", place);
  // Capture, so scrolls inside any nested scroller reach us too.
  fn.call(window, "scroll", place, true);
}

watch(open, async (v) => {
  bind(v);
  if (!v) return;
  query.value = "";
  place();
  await nextTick();
  place();
  if (searchable.value) search.value?.focus();
});

onBeforeUnmount(() => bind(false));

function pick(value: string) {
  emit("update:modelValue", value);
  open.value = false;
}
</script>

<template>
  <div ref="box" class="pk">
    <button class="pk-trigger" :disabled="disabled" @click="open = !open">
      <span class="pk-value" :class="{ dim: !label || modelValue === '' }">{{ label }}</span>
      <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="pop" class="pk-pop" :style="popStyle">
        <input
          v-if="searchable"
          ref="search"
          v-model="query"
          type="search"
          class="pk-search"
          :placeholder="t('search')"
          @keydown.esc="open = false"
          @keydown.enter="filtered[0] && pick(filtered[0].value)"
        />
        <div class="pk-list">
          <button
            v-for="o in filtered"
            :key="o.value"
            class="pk-opt"
            :class="{ on: o.value === modelValue }"
            @click="pick(o.value)"
          >
            <span>{{ o.label }}</span>
            <span v-if="o.note" class="pk-note">{{ o.note }}</span>
          </button>
          <div v-if="!filtered.length" class="pk-none">{{ placeholder || "—" }}</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pk { position: relative; }

.pk-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 38px;
  padding: 0 12px;
  font-size: 13.5px;
  font-weight: 600;
  border-radius: var(--r-md);
  background: var(--shade);
  border: 1px solid var(--hairline);
  transition: border-color 0.2s, background 0.2s var(--ease);
}
.pk-trigger:hover:not(:disabled) { background: var(--glass-2); }
.pk-trigger:disabled { opacity: 0.45; cursor: not-allowed; }
.pk-trigger svg { color: var(--ink-3); flex: none; }
.pk-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk-value.dim { color: var(--ink-3); font-weight: 500; }
</style>

<!-- Teleported to <body>, so the popup cannot be scoped to this component. -->
<style>
.pk-pop {
  /* Deliberately NOT `.glass`: that utility sets `position: relative` at the same
     specificity as this rule, and because main.ts imports App.vue (which injects component
     styles) before glass.css, it won.  The popup then laid out in flow at the end of <body>
     — present in the DOM, ~300px below the fold, which read as "the dropdown won't open".
     It carries its own plate styles below, so the utility buys nothing here. */
  position: fixed;
  /* Above the settings scrim (100) — a picker inside that sheet must not open behind it. */
  z-index: 120;
  padding: 8px;
  border-radius: var(--r-md);
  background: var(--glass);
  backdrop-filter: blur(34px) saturate(185%);
  box-shadow: 0 20px 44px -14px rgba(10, 16, 40, 0.5), inset 0 1px 0 var(--glass-hi);
  animation: pk-pop-in 0.18s var(--ease);
}
@keyframes pk-pop-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
}

.pk-pop .pk-search { height: 32px; margin-bottom: 6px; }
.pk-pop .pk-search::-webkit-search-cancel-button { display: none; }

.pk-pop .pk-list {
  max-height: 244px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.pk-pop .pk-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 13px;
  text-align: left;
  transition: background 0.14s;
}
.pk-pop .pk-opt > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk-pop .pk-opt:hover { background: var(--shade); }
.pk-pop .pk-opt.on { background: var(--accent); color: #fff; }
.pk-pop .pk-opt.on .pk-note { color: rgba(255, 255, 255, 0.7); }
.pk-pop .pk-note { flex: none; font-size: 11px; color: var(--ink-3); font-variant: small-caps; }
.pk-pop .pk-none { padding: 14px; text-align: center; color: var(--ink-3); font-size: 13px; }
</style>
