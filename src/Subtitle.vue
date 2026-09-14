<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { initSettings, settings, type SubtitleStyle } from "./store";
import { current, lines } from "./stream";
import { t } from "./i18n";

const style = ref<SubtitleStyle>(settings.sub);

onMounted(async () => {
  // Read-only mirror: the main window owns persistence, this one just follows it.
  await initSettings(false);
  style.value = settings.sub;
});

void listen<SubtitleStyle>("sub://style", ({ payload }) => {
  style.value = payload;
});

const last = computed(() => lines.value[lines.value.length - 1]);
const live = computed(() => !!(current.source || current.target || current.sourceStash || current.targetStash));
const src = computed(() => (live.value ? current.source : last.value?.source ?? ""));
const tgt = computed(() => (live.value ? current.target : last.value?.target ?? ""));
const srcStash = computed(() => (live.value ? current.sourceStash : ""));
const tgtStash = computed(() => (live.value ? current.targetStash : ""));

const showSource = computed(() => style.value.mode !== "target" && !!(src.value || srcStash.value));
const showTarget = computed(() => style.value.mode !== "source" && !!(tgt.value || tgtStash.value));
const empty = computed(() => !showSource.value && !showTarget.value);
// At 0% the plate must vanish completely — a backdrop blur with no tint is still a
// visible frosted rectangle over video, which defeats the point of the slider.
const barStyle = computed(() => {
  // With nothing to show, the overlay must not sit on the screen as a dark slab — an idle
  // subtitle window should obscure nothing.
  const a = empty.value ? 0 : style.value.opacity;
  return {
    background: a < 0.02 ? "transparent" : `rgba(6, 8, 14, ${a})`,
    backdropFilter: a < 0.02 ? "none" : "blur(10px)",
    fontSize: `${style.value.fontSize}px`,
  };
});

// An 8-way shadow reads as a crisp outline and, unlike -webkit-text-stroke, does not eat
// into the glyph — it has to stay legible over arbitrary video.
const outline = computed(() =>
  style.value.outline
    ? "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 10px rgba(0,0,0,.85)"
    : "0 2px 10px rgba(0,0,0,.6)"
);
</script>

<template>
  <div class="wrap" :class="{ locked: style.locked, idle: empty }">
    <div
      class="bar"
      :style="barStyle"
      :data-tauri-drag-region="style.locked ? undefined : true"
    >
      <p v-if="showSource" class="src" :style="{ color: style.srcColor, textShadow: outline }">
        {{ src }}<span class="stash">{{ srcStash }}</span>
      </p>
      <p v-if="showTarget" class="tgt" :style="{ color: style.color, textShadow: outline }">
        {{ tgt }}<span class="stash">{{ tgtStash }}</span>
      </p>
      <p v-if="empty" class="ghost">{{ style.locked ? t("subLocked") : t("subTitle") }}</p>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  display: flex;
  align-items: flex-end;
  padding: 8px;
}

/* While interactive the window intercepts clicks across its whole rect, transparent parts
   included — so make that rect visible instead of leaving an invisible dead zone. */
.wrap:not(.locked) {
  background: rgba(10, 132, 255, 0.07);
  outline: 1.5px dashed rgba(10, 132, 255, 0.55);
  outline-offset: -2px;
  border-radius: 12px;
}

.bar {
  width: 100%;
  padding: 14px 26px;
  border-radius: 18px;
  text-align: center;
  transition: background 0.2s;
}

/* Unlocked: show where the window is and that it can be dragged. */
.wrap:not(.locked) .bar {
  outline: 1.5px dashed rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
  cursor: grab;
}
.wrap:not(.locked) .bar:active { cursor: grabbing; }

/* Tauri starts a window drag only when the mousedown target itself carries
   data-tauri-drag-region. Letting pointer events fall through the text makes the whole
   plate draggable instead of just its padding. */
p { margin: 0; line-height: 1.4; word-break: break-word; pointer-events: none; }

.src { font-size: 0.62em; font-weight: 500; margin-bottom: 0.2em; opacity: 0.92; }
.tgt { font-size: 1em; font-weight: 700; letter-spacing: -0.01em; }

/* Unconfirmed tail — still readable over video, but clearly provisional. */
.stash { opacity: 0.55; }

.ghost {
  font-size: 0.5em;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.45);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
}
.wrap.idle .ghost { opacity: 0.75; }
.wrap.idle.locked .ghost { opacity: 0.3; }
</style>
