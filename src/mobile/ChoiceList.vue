<script setup lang="ts">
import { useId } from "vue";

defineProps<{
  label: string;
  value: string;
  options: { value: string; label: string; description?: string; suffix?: string }[];
  disabled?: boolean;
  empty?: string;
}>();
defineEmits<{ select: [value: string] }>();
const group = useId();
</script>

<template>
  <div class="choices" role="radiogroup" :aria-label="label">
    <label v-for="option in options" :key="option.value" class="choice" :class="{ selected: value === option.value, disabled }">
      <input type="radio" :name="group" :value="option.value" :checked="value === option.value" :disabled="disabled" @change="$emit('select', option.value)" />
      <span class="name"><b>{{ option.label }}</b><small v-if="option.description">{{ option.description }}</small></span>
      <span v-if="option.suffix" class="suffix">{{ option.suffix }}</span>
      <svg class="check" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>
    </label>
    <p v-if="!options.length && empty" class="empty" role="status">{{ empty }}</p>
  </div>
</template>

<style scoped>
.choices { border-radius: 15px; background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline); }
.choice { position: relative; display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 8px 16px; cursor: pointer; color: var(--ink); }
.choice + .choice { border-top: 1px solid var(--hairline); }
.choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.choice:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 10px; }
.name { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.name b { flex: 0 1 auto; min-width: 0; font-size: 15px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name small { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suffix { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, monospace; }
.check { flex: none; visibility: hidden; color: var(--accent); }
.selected .check { visibility: visible; }
.selected b { color: var(--accent); font-weight: 680; }
.disabled { opacity: .5; cursor: default; }
.empty { margin: 0; padding: 14px; text-align: center; color: var(--ink-2); font-size: 13.5px; }
</style>
