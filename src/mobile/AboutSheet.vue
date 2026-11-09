<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import Sheet from "./Sheet.vue";
import { check, checkUpdate, openHome } from "../core/update";
import { isMobile } from "../core/platform";
import { t } from "../core/i18n";
import appIcon from "../../brand/app-icon.png";
import AboutLinks from "../shared/AboutLinks.vue";

defineEmits<{ close: [] }>();

const version = ref("");
onMounted(async () => {
  version.value = await getVersion();
  if (check.value.state === "idle") void checkUpdate();
});

const platform = () => (isMobile.value ? t("platformAndroid") : "desktop");
</script>

<template>
  <Sheet @close="$emit('close')">
    <div class="hero">
      <img class="mark" :src="appIcon" alt="ReaLingo" />
      <div>
        <div class="nm">{{ t("appTitle") }}</div>
        <div class="sub">v{{ version }} · {{ platform() }}</div>
      </div>
    </div>

    <p class="tag">{{ t("aboutTagline") }}</p>

    <div class="rows">
      <button class="rowbtn" :disabled="check.state === 'checking'" @click="checkUpdate">
        <span class="rt"><b>{{ t("updCheck") }}</b></span>
        <span class="rv">
          {{ check.state === "checking" ? t("updChecking") : check.state === "found" ? t("updFound") + " " + check.tag : check.state === "latest" ? t("updLatest") : "" }}
        </span>
      </button>
      <button v-if="check.state === 'found'" class="rowbtn primary" @click="openHome">
        <span class="rt"><b>{{ t("updNewVersion") }} {{ check.tag }} ↗</b></span>
      </button>
    </div>

    <AboutLinks :version="version" />

    <p class="note">{{ t("aboutNote") }}</p>
  </Sheet>
</template>

<style scoped>
.hero { display: flex; align-items: center; gap: 13px; }
.mark { width: 54px; height: 54px; border-radius: 15px; object-fit: contain; }
.nm { font-size: 19px; font-weight: 730; letter-spacing: -0.022em; }
.sub { font-size: 12px; color: var(--ink-3); font-weight: 600; margin-top: 2px; }
.tag { margin: 0; font-size: 13px; line-height: 1.65; color: var(--ink-2); }
.rows {
  border-radius: 16px; padding: 0 14px;
  background: var(--shade); box-shadow: inset 0 0 0 1px var(--hairline);
}
.rowbtn { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 50px; padding: 6px 0; text-align: left; color: var(--ink); }
.rowbtn + .rowbtn { box-shadow: inset 0 1px 0 var(--hairline); }
.rowbtn:disabled { opacity: 0.6; }
.rowbtn .rt { flex: 1; min-width: 0; }
.rowbtn .rt b { display: block; font-size: 14px; font-weight: 600; }
.rowbtn .rt small { display: block; margin-top: 2px; font-size: 11.5px; color: var(--ink-3); line-height: 1.45; }
.rowbtn .rv { font-size: 12.5px; color: var(--ink-3); font-weight: 600; }
.rowbtn.primary .rt b { color: var(--accent); font-weight: 720; }
.note { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--ink-3); text-align: center; }
</style>
