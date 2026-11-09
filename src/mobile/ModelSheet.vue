<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Sheet from "./Sheet.vue";
import { settings, switchProtocol, type Protocol } from "../core/store";
import { PRESETS, modelName } from "../core/languages";
import { t, tf } from "../core/i18n";
import { toast } from "./toasts";
import { VENDOR_LOGO } from "../shared/vendorLogos";

const props = defineProps<{ running: boolean }>();
const emit = defineEmits<{ close: []; restart: [] }>();

/** Card list, the same explicit shape the desktop settings sheet uses (protocolOptions):
 *  names via i18n keys, counts and preset ids via PRESETS. No vendor branching here. */
const cards = computed(() =>
  ([
    ["qwen35", t("protocolQwen35"), t("vendorQwen")],
    ["qwen38", t("protocolQwen38"), t("vendorQwen")],
    ["openai", t("protocolOpenai"), "OpenAI"],
    ["gemini", t("protocolGemini"), "Google"],
    ["volc", t("protocolVolc"), t("vendorVolc")],
  ] as [Protocol, string, string][]).map(([id, name, vendor]) => ({
    id,
    name,
    vendor,
    langs: PRESETS[id][0].langs,
    model: PRESETS[id][0].id,
  }))
);

/** The custom ID field seeds with the live model only when it is not a preset — otherwise
 *  the placeholder ("use the preset above") is the honest description of the state. */
const customDraft = ref(PRESETS[settings.protocol].some((x) => x.id === settings.model) ? "" : settings.model);

function pick(p: Protocol) {
  if (!switchProtocol(p)) return;
  customDraft.value = "";
  emit("close");
  // The design's rule: a wire-format change cannot hot-swap a live session.
  if (props.running) toast(tf("restartNeeded"), { label: t("restartNow"), run: () => emit("restart") });
  else toast(tf("ifaceSwitched", { p: modelName(p, PRESETS[p][0].id) }));
}

/** The custom ID is live text: typing applies, clearing returns to the protocol preset. */
watch(customDraft, (v) => {
  settings.model = v.trim() || PRESETS[settings.protocol][0].id;
});
</script>

<template>
  <Sheet :title="t('protocol') + ' · ' + t('model')" @close="$emit('close')">
    <p class="hintx">{{ t('ifaceDrawerHint') }}</p>

    <div class="cards">
      <button v-for="c in cards" :key="c.id" class="srccard" :class="{ on: settings.protocol === c.id }" @click="pick(c.id)">
        <span class="ic">
          <img class="vendor-logo" :class="{ 'logo-mono': VENDOR_LOGO[c.id].mono }" :src="VENDOR_LOGO[c.id].src" alt="" width="22" height="22">
        </span>
        <span class="tx">
          <b>{{ c.name }} <em class="badge">{{ c.vendor }}</em></b>
          <small>{{ c.langs }} {{ t("langsUnit") }} · {{ settings.protocol === c.id ? settings.model : c.model }}</small>
        </span>
        <svg v-if="settings.protocol === c.id" class="ck" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>
      </button>
    </div>

    <div class="grp">
      <span class="glabel">{{ t('customModelId') }}</span>
      <div class="field"><input v-model="customDraft" type="text" :placeholder="t('modelCustomPh')" spellcheck="false"></div>
      <p class="hintx">{{ t('customModelHint') }}</p>
    </div>
  </Sheet>
</template>

<style scoped>
.cards { display: flex; flex-direction: column; gap: 9px; }
.srccard {
  width: 100%; text-align: left; border-radius: 20px; padding: 14px 15px;
  display: flex; gap: 12px; align-items: flex-start;
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
  transition: all 0.2s var(--ease);
}
.srccard.on { background: rgba(10, 132, 255, 0.14); box-shadow: inset 0 0 0 1.6px var(--accent); }
/* The mark keeps its own colours, so the tile stays neutral and selection shows on the card. */
.ic { width: 38px; height: 38px; flex: none; border-radius: 12px; display: grid; place-items: center; background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--hairline); }
:root[data-theme="dark"] .ic { background: rgba(255, 255, 255, 0.08); }
.tx { flex: 1; min-width: 0; }
.srccard b { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: var(--ink); }
.srccard small { display: block; margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--ink-2); }
.srccard small.mono { font-family: ui-monospace, monospace; font-size: 11px; color: var(--ink-3); word-break: break-all; }
.badge { font-style: normal; font-size: 10px; font-weight: 800; padding: 2.5px 8px; border-radius: 999px; color: var(--ink-3); background: var(--glass); }
.ck { flex: none; margin-top: 9px; }
.grp { margin-top: 2px; }
.glabel { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 9px; }
.field {
  width: 100%; height: 42px; padding: 0 14px; border-radius: 13px;
  background: var(--shade); border: 1px solid var(--hairline);
  display: flex; align-items: center; color: var(--ink); font-size: 14px;
}
.field input { flex: 1; border: 0; background: none; outline: none; font-family: inherit; font-size: 14px; color: var(--ink); min-width: 0; }
.field input::placeholder { color: var(--ink-3); }
.hintx { margin: 8px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--ink-3); }
</style>
