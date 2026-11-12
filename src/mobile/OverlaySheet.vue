<script setup lang="ts">
import Sheet from "./Sheet.vue";
import { settings } from "../core/store";
import { t } from "../core/i18n";
import { native, resetOverlayPosition } from "./native";
defineEmits<{ close: []; toggle: [] }>();

const MODES = [["both", "subBoth"], ["target", "subTarget"], ["source", "subSource"]] as const;
const ALIGNS = [["left", "alignLeft"], ["center", "alignCenter"], ["right", "alignRight"]] as const;
const SWITCHES = [["outline", "subOutline"], ["grow", "subGrow"], ["locked", "subLock"]] as const;
</script>

<template>
  <Sheet :title="t('subTitle')" @close="$emit('close')">
    <!-- The one thing people open this for: on or off. Everything else tunes it. -->
    <button class="m-master" :class="{ on: native.visible }" role="switch" :aria-checked="native.visible" @click="$emit('toggle')">
      <span class="tx">
        <b>{{ native.granted ? t('subShow') : t('overlayAuthorize') }}</b>
        <small>{{ t('overlayHint') }}</small>
      </span>
      <span class="m-toggle" :class="{ on: native.visible }" aria-hidden="true" />
    </button>

    <section>
      <span class="m-glabel">{{ t('subGroupText') }}</span>
      <div class="m-group">
        <label class="m-row m-pick">
          <span class="m-tx"><b>{{ t('subMode') }}</b></span>
          <select v-model="settings.sub.mode"><option v-for="[v, k] in MODES" :key="v" :value="v">{{ t(k) }}</option></select>
          <svg class="m-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>
        </label>
        <label class="m-field">
          <b>{{ t('subTgtSize') }}<output>{{ settings.sub.tgtSize }}</output></b>
          <input v-model.number="settings.sub.tgtSize" class="m-range" type="range" min="12" max="72" />
        </label>
        <label class="m-field">
          <b>{{ t('subSrcSize') }}<output>{{ settings.sub.srcSize }}</output></b>
          <input v-model.number="settings.sub.srcSize" class="m-range" type="range" min="12" max="72" />
        </label>
        <div class="m-row">
          <span class="m-tx"><b>{{ t('subColors') }}</b></span>
          <label class="m-swatch" :style="{ background: settings.sub.color }" :aria-label="t('subColor')"><input v-model="settings.sub.color" type="color" /></label>
          <label class="m-swatch" :style="{ background: settings.sub.srcColor }" :aria-label="t('subSrcColor')"><input v-model="settings.sub.srcColor" type="color" /></label>
        </div>
        <div class="m-field">
          <b>{{ t('subAlign') }}</b>
          <div class="m-seg">
            <button v-for="[v, k] in ALIGNS" :key="v" :class="{ on: settings.sub.align === v }" @click="settings.sub.align = v">{{ t(k) }}</button>
          </div>
        </div>
      </div>
    </section>

    <section>
      <span class="m-glabel">{{ t('subGroupWindow') }}</span>
      <div class="m-group">
        <label class="m-field">
          <b>{{ t('overlayWidth') }}<output>{{ settings.sub.mobileWidth }}%</output></b>
          <input v-model.number="settings.sub.mobileWidth" class="m-range" type="range" min="40" max="100" />
        </label>
        <label class="m-field">
          <b>{{ t('subOpacity') }}<output>{{ Math.round(settings.sub.opacity * 100) }}%</output></b>
          <input v-model.number="settings.sub.opacity" class="m-range" type="range" min="0" max="1" step="0.05" />
        </label>
        <button v-for="[k, label] in SWITCHES" :key="k" class="m-row" role="switch" :aria-checked="settings.sub[k]" @click="settings.sub[k] = !settings.sub[k]">
          <span class="m-tx"><b>{{ t(label) }}</b></span>
          <span class="sw" :class="{ on: settings.sub[k] }" />
        </button>
      </div>
    </section>

    <button class="m-btn reset" @click="resetOverlayPosition">{{ t('overlayReset') }}</button>
  </Sheet>
</template>

<style scoped>
section { display: flex; flex-direction: column; }
.reset { width: 100%; color: var(--ink-2); }
</style>
