<script setup lang="ts">
import { computed, nextTick } from "vue";

const props = defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step: number;
  /** Shown after the number, inside the field. */
  unit?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [number] }>();

const round = (n: number) => Math.round(n / props.step) * props.step;
const clamp = (n: number) => Math.min(props.max, Math.max(props.min, round(n)));
// Number() strips the float noise 0.01-steps would otherwise leave behind.
const text = computed(() => String(Number(props.modelValue.toFixed(4))));
const fill = computed(
  () => ((props.modelValue - props.min) / (props.max - props.min)) * 100 + "%"
);

function onDrag(e: Event) {
  emit("update:modelValue", Number((e.target as HTMLInputElement).value));
}

/**
 * The field commits on change (blur or Enter), never per keystroke: typing "1" on the way
 * to "18" would be clamped up to the minimum mid-word, and every intermediate value reaches
 * the subtitle overlay, which is watching this setting.
 *
 * The write-back is deferred — when the typed value clamps to what the model already holds,
 * Vue re-renders nothing, so the field would keep showing the rejected number.
 */
function commit(e: Event) {
  const el = e.target as HTMLInputElement;
  const n = Number(el.value);
  if (Number.isFinite(n)) emit("update:modelValue", clamp(n));
  void nextTick(() => (el.value = text.value));
}
</script>

<template>
  <div class="sl">
    <input
      class="sl-range"
      type="range"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      :style="{ '--fill': fill }"
      @input="onDrag"
    />
    <div class="sl-field">
      <input
        type="number"
        :value="text"
        :min="min"
        :max="max"
        :step="step"
        @change="commit"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <span v-if="unit" class="sl-unit">{{ unit }}</span>
    </div>
  </div>
</template>

<style scoped>
.sl { display: flex; align-items: center; gap: 10px; }

.sl-range {
  -webkit-appearance: none; appearance: none;
  flex: none;
  width: 76px; height: 20px;
  background: none;
  cursor: pointer;
}
.sl-range::-webkit-slider-runnable-track {
  height: 5px; border-radius: 3px;
  background: linear-gradient(var(--accent), var(--accent)) 0/var(--fill, 50%) 100% no-repeat,
    var(--shade);
  border: 1px solid var(--hairline);
}
.sl-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; margin-top: -5.5px;
  border-radius: 50%; background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3), 0 0 0 0.5px rgba(0, 0, 0, 0.12);
  transition: transform 0.15s var(--ease);
}
.sl-range:active::-webkit-slider-thumb { transform: scale(1.18); }

.sl-field {
  flex: none;
  display: flex; align-items: baseline; gap: 1px;
  height: 28px; padding: 0 8px;
  border-radius: 9px;
  background: var(--shade);
  border: 1px solid transparent;
  transition: border-color 0.18s;
}
.sl-field:focus-within { border-color: var(--accent); }

.sl-field input {
  width: 3.2ch;
  height: 100%;
  padding: 0;
  border: none; background: none; outline: none;
  font-family: inherit; font-size: 13px; font-weight: 600;
  color: var(--ink);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* Native spinners are tiny and differ per platform; the slider is the coarse control. */
.sl-field input::-webkit-inner-spin-button { display: none; }
.sl-unit { font-size: 11px; font-weight: 600; color: var(--ink-3); }
</style>
