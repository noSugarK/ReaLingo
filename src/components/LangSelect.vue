<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { LANGUAGES, langName } from "../languages";
import { locale, t } from "../i18n";

const props = defineProps<{ modelValue: string; allowAuto?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);
const query = ref("");
const box = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);

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

watch(open, async (v) => {
  if (!v) return;
  query.value = "";
  await nextTick();
  search.value?.focus();
});

function pick(code: string) {
  emit("update:modelValue", code);
  open.value = false;
}

function onBlur(e: FocusEvent) {
  if (!box.value?.contains(e.relatedTarget as Node)) open.value = false;
}
</script>

<template>
  <div ref="box" class="ls" @focusout="onBlur">
    <button class="ls-trigger" :disabled="disabled" @click="open = !open">
      <span class="ls-value">{{ langName(modelValue, locale) }}</span>
      <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <div v-if="open" class="ls-pop glass">
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

.ls-pop {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  padding: 8px;
  border-radius: var(--r-md);
  animation: pop 0.18s var(--ease);
}
@keyframes pop {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
}

.ls-search { height: 32px; margin-bottom: 6px; }
.ls-search::-webkit-search-cancel-button { display: none; }

.ls-list { max-height: 244px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }

.ls-opt {
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
.ls-opt:hover { background: var(--shade); }
.ls-opt.on { background: var(--accent); color: #fff; }
.ls-opt.on .ls-code { color: rgba(255, 255, 255, 0.7); }
.ls-code { font-size: 11px; color: var(--ink-3); font-variant: small-caps; }
.ls-none { padding: 14px; text-align: center; color: var(--ink-3); font-size: 13px; }
</style>
