<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { LANGUAGES, langName } from "../languages";
import { locale, t } from "../i18n";

const props = defineProps<{ modelValue: string; allowAuto?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);
const query = ref("");
const box = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const popStyle = ref<Record<string, string>>({});

const MAX_POP_H = 300;

const options = computed(() => {
  const list = LANGUAGES.map((l) => l.code);
  return props.allowAuto ? ["auto", ...list] : list;
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return options.value;
  return options.value.filter(
    (c) =>
      c.includes(q) ||
      langName(c, "zh").toLowerCase().includes(q) ||
      langName(c, "en").toLowerCase().includes(q)
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
  search.value?.focus();
});

onBeforeUnmount(() => bind(false));

function pick(code: string) {
  emit("update:modelValue", code);
  open.value = false;
}
</script>

<template>
  <div ref="box" class="ls">
    <button class="ls-trigger" :disabled="disabled" @click="open = !open">
      <span class="ls-value">{{ langName(modelValue, locale) }}</span>
      <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="pop" class="ls-pop glass" :style="popStyle">
        <input
          ref="search"
          v-model="query"
          type="search"
          class="ls-search"
          :placeholder="t('searchLang')"
          @keydown.esc="open = false"
          @keydown.enter="filtered[0] && pick(filtered[0])"
        />
        <div class="ls-list">
          <button
            v-for="code in filtered"
            :key="code"
            class="ls-opt"
            :class="{ on: code === modelValue }"
            @click="pick(code)"
          >
            <span>{{ langName(code, locale) }}</span>
            <span class="ls-code">{{ code }}</span>
          </button>
          <div v-if="!filtered.length" class="ls-none">—</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ls { position: relative; }

.ls-trigger {
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
.ls-trigger:hover:not(:disabled) { background: var(--glass-2); }
.ls-trigger:disabled { opacity: 0.45; cursor: not-allowed; }
.ls-trigger svg { color: var(--ink-3); flex: none; }
.ls-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

<!-- Teleported to <body>, so the popup cannot be scoped to this component. -->
<style>
.ls-pop {
  position: fixed;
  z-index: 80;
  padding: 8px;
  border-radius: var(--r-md);
  /* Teleported out of the glass card, so it needs its own opaque-enough plate. */
  background: var(--glass);
  backdrop-filter: blur(34px) saturate(185%);
  box-shadow: 0 20px 44px -14px rgba(10, 16, 40, 0.5), inset 0 1px 0 var(--glass-hi);
  animation: ls-pop-in 0.18s var(--ease);
}
@keyframes ls-pop-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
}

.ls-pop .ls-search { height: 32px; margin-bottom: 6px; }
.ls-pop .ls-search::-webkit-search-cancel-button { display: none; }

.ls-pop .ls-list {
  max-height: 244px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ls-pop .ls-opt {
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
.ls-pop .ls-opt:hover { background: var(--shade); }
.ls-pop .ls-opt.on { background: var(--accent); color: #fff; }
.ls-pop .ls-opt.on .ls-code { color: rgba(255, 255, 255, 0.7); }
.ls-pop .ls-code { font-size: 11px; color: var(--ink-3); font-variant: small-caps; }
.ls-pop .ls-none { padding: 14px; text-align: center; color: var(--ink-3); font-size: 13px; }
</style>
