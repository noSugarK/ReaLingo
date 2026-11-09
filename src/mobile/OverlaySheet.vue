<script setup lang="ts">
import Sheet from "./Sheet.vue";
import { settings } from "../core/store";
import { t } from "../core/i18n";
import { native, resetOverlayPosition } from "./native";
defineEmits<{ close: []; toggle: []; fullscreen: [] }>();
</script>

<template>
  <Sheet :title="t('subTitle')" @close="$emit('close')">
    <p>{{ t('overlayHint') }}</p>
    <button @click="$emit('toggle')">{{ native.visible ? t('subHide') : native.granted ? t('subShow') : t('overlayAuthorize') }}</button>
    <label>{{ t('subMode') }}<select v-model="settings.sub.mode"><option value="both">{{ t('subBoth') }}</option><option value="source">{{ t('subSource') }}</option><option value="target">{{ t('subTarget') }}</option></select></label>
    <label>{{ t('subSrcSize') }} · {{ settings.sub.srcSize }}<input v-model.number="settings.sub.srcSize" type="range" min="12" max="72" /></label>
    <label>{{ t('subTgtSize') }} · {{ settings.sub.tgtSize }}<input v-model.number="settings.sub.tgtSize" type="range" min="12" max="72" /></label>
    <label>{{ t('overlayWidth') }} · {{ settings.sub.mobileWidth }}%<input v-model.number="settings.sub.mobileWidth" type="range" min="40" max="100" /></label>
    <label>{{ t('subOpacity') }}<input v-model.number="settings.sub.opacity" type="range" min="0" max="1" step="0.05" /></label>
    <label>{{ t('subSrcColor') }}<input v-model="settings.sub.srcColor" type="color" /></label>
    <label>{{ t('subColor') }}<input v-model="settings.sub.color" type="color" /></label>
    <label>{{ t('subAlign') }}<select v-model="settings.sub.align"><option value="left">{{ t('alignLeft') }}</option><option value="center">{{ t('alignCenter') }}</option><option value="right">{{ t('alignRight') }}</option></select></label>
    <label>{{ t('subGrow') }}<input v-model="settings.sub.grow" type="checkbox" /></label>
    <label>{{ t('subOutline') }}<input v-model="settings.sub.outline" type="checkbox" /></label>
    <label>{{ t('subLock') }}<input v-model="settings.sub.locked" type="checkbox" /></label>
    <button @click="resetOverlayPosition">{{ t('overlayReset') }}</button>
    <button @click="$emit('fullscreen')">{{ t('fullscreenSub') }}</button>
  </Sheet>
</template>

<style scoped>
label { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; }
input[type=range] { width: 48%; }
button, select { padding: 10px; border-radius: 12px; background: var(--shade); color: var(--ink); font: inherit; }
p { color: var(--ink-3); font-size: 12px; line-height: 1.5; }
</style>
