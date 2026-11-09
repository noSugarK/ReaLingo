<script setup lang="ts">
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Sheet from "./Sheet.vue";
import { session } from "../core/session";
import { caps } from "../core/platform";
import { perms, askMic } from "./perms";
import { isRunning } from "../core/stream";
import { toast } from "./toasts";
import { t } from "../core/i18n";
import Icon from "./Icon.vue";
import { native, beginCapture, stopCapture } from "./native";

defineEmits<{ close: [] }>();

const source = session.sourceKind;
const fileName = session.fileName;
const level = session.level;
const testing = ref(false);
const testError = ref("");
const testResult = ref("");
async function testMic() {
  if (testing.value || isRunning()) return;
  testing.value = true;
  testError.value = "";
  testResult.value = "";
  try {
    if (perms.mic !== "granted" && await askMic() !== "granted") return;
    await session.refreshDevices();
    const system = source.value === "system";
    if (!await beginCapture(system ? "system" : "mic")) return;
    const id = await invoke<string | null>("default_device", { loopback: system });
    if (!id) throw new Error(t("noDevice"));
    const samples = await invoke<number>("probe_audio", { id });
    testResult.value = samples > 0 ? t(system ? "systemTestOk" : "micTestOk") : t("micTestEmpty");
    toast(testResult.value);
  } catch (e) { testError.value = String(e); toast(testError.value); }
  finally { stopCapture(); testing.value = false; }
}

const canSystem = computed(() => caps.value.loopback && native.systemSupported);

const micBadge = computed(() =>
  perms.mic === "granted"
    ? { text: t("pmGranted"), cls: "g" }
    : perms.mic === "permanent"
      ? { text: t("pmPermanent"), cls: "r" }
      : null
);
</script>

<template>
  <Sheet :title="t('srcTitle')" @close="!testing && $emit('close')">
    <p class="hint">{{ t('srcHintSwitch') }}</p>

    <div class="cards">
      <button class="srccard" :class="{ on: source === 'mic' }" @click="source = 'mic'">
        <span class="ic mic">
          <Icon name="mic" />
        </span>
        <span class="tx">
          <b>{{ t('srcMic') }} <em v-if="micBadge" class="badge" :class="micBadge.cls">{{ micBadge.text }}</em></b>
          <small>{{ t('srcMicSub') }}</small>
        </span>
      </button>

      <button class="srccard" :class="{ on: source === 'system' }" :disabled="!canSystem" @click="canSystem && (source = 'system')">
        <span class="ic sys">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.5 6.5 8H3v8h3.5L11 19.5z"/><path d="M15 8.6a4.6 4.6 0 0 1 0 6.8"/></svg>
        </span>
        <span class="tx">
          <b>{{ t('srcSystem') }} <em v-if="!canSystem" class="badge y">{{ t('needAuth') }}</em></b>
          <small>{{ canSystem ? t('systemAudioHint') : t('systemAudioAndroid10') }}</small>
        </span>
      </button>

      <button class="srccard" :class="{ on: source === 'file' }" @click="source = 'file'">
        <span class="ic file">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H14l5 5v10.5A2.5 2.5 0 0 1 16.5 21h-10A2.5 2.5 0 0 1 4 18.5z"/><path d="M13.5 3.2V8.5H19"/></svg>
        </span>
        <span class="tx">
          <b>{{ t('srcFile') }}</b>
          <small>{{ fileName || t('srcFileSub') }}</small>
        </span>
      </button>
    </div>

    <button v-if="source !== 'file'" class="test-mic" :disabled="testing || isRunning()" @click="testMic">{{ testing ? t("micTesting") : t(source === 'system' ? "systemTest" : "micTest") }}</button>
    <p v-if="testError" role="alert" class="test-error">{{ testError }}</p>
    <p v-if="testResult" role="status">{{ testResult }}</p>

    <div class="grp">
      <span class="glabel">{{ t('level') }}</span>
      <div class="meter"><i :style="{ transform: `scaleX(${Math.min(1, level * 1.6)})` }" /></div>
    </div>
  </Sheet>
</template>

<style scoped>
.test-mic { padding: 12px; border-radius: 14px; background: var(--accent); color: white; font: inherit; font-weight: 650; }
.test-mic:disabled { opacity: 0.5; }
.test-error { color: var(--danger); overflow-wrap: anywhere; }
.cards { display: flex; flex-direction: column; gap: 10px; }
.srccard {
  width: 100%;
  text-align: left;
  border-radius: 20px;
  padding: 14px 15px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  background: var(--shade);
  box-shadow: inset 0 0 0 1px var(--hairline);
  transition: all 0.2s var(--ease);
}
.srccard.on { background: rgba(10, 132, 255, 0.14); box-shadow: inset 0 0 0 1.6px var(--accent); }
.srccard:disabled { opacity: 0.55; cursor: default; }
.ic { width: 36px; height: 36px; flex: none; border-radius: 11px; display: grid; place-items: center; }
.ic.mic { background: var(--accent); color: #fff; }
.ic.sys { background: rgba(191, 90, 242, 0.16); color: var(--accent-2); }
.ic.file { background: rgba(48, 209, 88, 0.14); color: var(--ok); }
.tx { flex: 1; min-width: 0; }
.srccard b { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; letter-spacing: -0.015em; color: var(--ink); }
.srccard small { display: block; margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--ink-2); }
.badge { font-style: normal; font-size: 10px; font-weight: 800; padding: 2.5px 8px; border-radius: 999px; }
.badge.g { color: var(--ok); background: rgba(48, 209, 88, 0.16); }
.badge.r { color: var(--danger); background: rgba(255, 69, 58, 0.18); }
.badge.y { color: #b7791f; background: rgba(255, 214, 10, 0.16); }
.grp { margin-top: 4px; }
.glabel { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 9px; }
.meter { height: 6px; border-radius: 3px; background: var(--shade); overflow: hidden; }
.meter > i { display: block; height: 100%; width: 100%; background: linear-gradient(90deg, var(--ok), #ffd60a 70%, var(--danger)); transform-origin: left; transform: scaleX(0); transition: transform 0.08s linear; }
.hint { margin: 0; font-size: 12px; line-height: 1.55; color: var(--ink-3); }
</style>
