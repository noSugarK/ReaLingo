<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Sheet from "./Sheet.vue";
import { session } from "../core/session";
import { settings, type OutputKind } from "../core/store";
import { isRunning } from "../core/stream";
import { t } from "../core/i18n";

defineEmits<{ close: [] }>();

/** Speak-aloud and its voice in one place: the switch and the choice it qualifies used to
 *  live on two different screens. `speak` is read when a session starts, so both lock
 *  while one runs instead of pretending to change it. */
const running = computed(() => isRunning());
const blocked = computed(() => session.speakBlocked.value);
const on = computed(() => settings.speak && !blocked.value);

// Qwen alone has 47 voices: searched by name and by trait ("gentle", "male", accent),
// the same keywords the desktop picker matches.
const query = ref("");
const voices = computed(() => {
  const q = query.value.trim().toLowerCase();
  const all = session.voiceOptions.value;
  return q ? all.filter((v) => `${v.label} ${v.value} ${v.note ?? ""} ${v.keywords}`.toLowerCase().includes(q)) : all;
});

// Outputs present now (headphones only while connected). Empty on hosts that cannot tell
// a speaker from an earpiece, and then the row is not shown at all.
const ORDER: OutputKind[] = ["speaker", "earpiece", "headphones"];
const LABEL = { speaker: "outSpeaker", earpiece: "outEarpiece", headphones: "outHeadphones" } as const;
const kinds = ref<OutputKind[]>([]);
onMounted(async () => {
  const have = await invoke<OutputKind[]>("output_kinds").catch((): OutputKind[] => []);
  kinds.value = ORDER.filter((k) => have.includes(k));
});
const missing = computed(() => settings.output !== "" && kinds.value.length > 0 && !kinds.value.includes(settings.output));

function toggle() {
  if (running.value || blocked.value) return;
  settings.speak = !settings.speak;
}
</script>

<template>
  <Sheet :title="t('dockSpeak')" @close="$emit('close')">
    <button class="master" :class="{ on }" role="switch" :aria-checked="on" :disabled="running || !!blocked" @click="toggle">
      <span class="tx">
        <b>{{ t('speak') }}</b>
        <small>{{ blocked ? t(blocked) : running ? t('speakLocked') : t('speakNote') }}</small>
      </span>
      <span class="tog" :class="{ on }" />
    </button>

    <section v-if="kinds.length" :class="{ off: !on }">
      <div class="m-group">
        <label class="m-row m-pick">
          <span class="m-tx"><b>{{ t('outputTitle') }}</b></span>
          <select v-model="settings.output" :disabled="running">
            <option value="">{{ t('outAuto') }}</option>
            <option v-for="k in kinds" :key="k" :value="k">{{ t(LABEL[k]) }}</option>
            <!-- keep a disconnected pick visible instead of showing a blank value -->
            <option v-if="missing" :value="settings.output">{{ t(LABEL[settings.output as OutputKind]) }}</option>
          </select>
          <svg class="m-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>
        </label>
      </div>
      <p class="hint" :class="{ warn: missing }">{{ missing ? t('outputMissing') : t('outputHint') }}</p>
    </section>

    <section v-if="session.voiceList.value" :class="{ off: !on }">
      <span class="glabel">{{ t('voice') }}</span>
      <label class="m-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.6 10.6 3 3"/></svg>
        <input v-model="query" type="search" :placeholder="t('voiceSearchPh')" :aria-label="t('voice')" spellcheck="false" autocomplete="off">
      </label>
      <div class="list" role="radiogroup" :aria-label="t('voice')">
        <button
          v-for="v in voices" :key="v.value" class="vrow" role="radio"
          :aria-checked="settings.voice === v.value" :class="{ on: settings.voice === v.value }"
          :disabled="running" @click="settings.voice = v.value"
        >
          <span class="nm"><b>{{ v.label }}</b><small v-if="v.note">{{ v.note }}</small></span>
          <svg class="ck" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>
        </button>
        <p v-if="!voices.length" class="none">{{ t('voiceNoMatch') }}</p>
      </div>
    </section>
    <p v-else class="note">{{ t('voiceServer') }}</p>
  </Sheet>
</template>

<style scoped>
.master {
  display: flex; align-items: center; gap: 14px; width: 100%; padding: 15px 16px; text-align: left;
  border-radius: 18px; background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline); color: var(--ink);
  transition: background 0.25s var(--ease), box-shadow 0.25s var(--ease);
}
.master.on { background: rgba(10, 132, 255, 0.12); box-shadow: inset 0 0 0 1.2px rgba(10, 132, 255, 0.45); }
.master:disabled { cursor: default; }
.master .tx { flex: 1; min-width: 0; }
.master b { display: block; font-size: 16px; font-weight: 700; }
.master small { display: block; margin-top: 3px; font-size: 12px; line-height: 1.5; color: var(--ink-2); }
.tog { position: relative; flex: none; width: 50px; height: 30px; border-radius: 999px; background: var(--hairline); transition: background 0.25s var(--ease); }
.tog::after { content: ""; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform 0.25s var(--ease); }
.tog.on { background: var(--accent); }
.tog.on::after { transform: translateX(20px); }
.master:disabled .tog { opacity: 0.45; }

section { display: flex; flex-direction: column; transition: opacity 0.25s var(--ease); }
section.off { opacity: 0.55; }
.glabel { font-size: 12px; font-weight: 700; color: var(--ink-3); margin: 0 4px 9px; }
.list { margin-top: 10px; border-radius: 15px; background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline); }
.vrow { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 8px 16px; text-align: left; color: var(--ink); }
.vrow + .vrow { box-shadow: inset 0 1px 0 var(--hairline); }
.vrow .nm { flex: 1; min-width: 0; }
.vrow b { display: block; font-size: 15px; font-weight: 600; }
.vrow small { display: block; margin-top: 2px; font-size: 12px; color: var(--ink-3); }
.vrow .ck { flex: none; color: var(--accent); visibility: hidden; }
.vrow.on .ck { visibility: visible; }
.vrow.on b { color: var(--accent); font-weight: 700; }
.vrow:disabled { cursor: default; }
.none { margin: 0; padding: 14px; text-align: center; color: var(--ink-2); font-size: 13.5px; }
.hint { margin: 8px 4px 0; font-size: 12px; line-height: 1.55; color: var(--ink-3); }
.hint.warn { color: #b7791f; }
.note { margin: 0; padding: 14px; border-radius: 15px; background: var(--shade); text-align: center; color: var(--ink-2); font-size: 13.5px; line-height: 1.6; }
</style>
