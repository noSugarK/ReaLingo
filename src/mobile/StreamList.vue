<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { settings } from "../core/store";
import type { Line } from "../core/stream";
import { current } from "../core/session";
import { t } from "../core/i18n";

const props = defineProps<{ lines: Line[]; empty?: string; big?: boolean }>();

/** Pin-to-bottom with an escape hatch (the desktop Top3 item, in phone form): stick to the
 *  newest line while the user has not scrolled away; a finger scroll up breaks the pin and
 *  a jump pill offers to re-arm it. */
const el = ref<HTMLElement | null>(null);
const pinned = ref(true);

function onScroll() {
  const s = el.value;
  if (!s) return;
  pinned.value = s.scrollHeight - s.scrollTop - s.clientHeight < 48;
}

function backToBottom() {
  pinned.value = true;
  el.value?.scrollTo({ top: el.value.scrollHeight, behavior: "smooth" });
}

watch([() => current.target, () => current.targetStash, () => props.lines.length], async () => {
  await nextTick();
  const s = el.value;
  if (s && s.scrollHeight <= s.clientHeight) pinned.value = true; // nothing left to scroll back to
  if (pinned.value) s?.scrollTo({ top: s.scrollHeight });
});
</script>

<template>
  <div ref="el" class="stream" :class="{ big }" :style="{ '--mobile-src-size': settings.stream.srcSize + 'px', '--mobile-tgt-size': settings.stream.tgtSize + 'px' }" @scroll.passive="onScroll">
    <p v-if="!lines.length && !current.target && !current.source" class="empty">{{ empty }}</p>

    <article v-for="l in lines" :key="l.id" class="line-item">
      <p v-if="l.source" class="src">{{ l.source }}</p>
      <p class="tgt">{{ l.target }}</p>
    </article>

    <article v-if="current.source || current.target || current.sourceStash || current.targetStash" class="line-item live">
      <p v-if="current.source || current.sourceStash" class="src">
        {{ current.source }}<span class="stash">{{ current.sourceStash }}</span>
      </p>
      <p class="tgt">
        {{ current.target }}<span class="stash">{{ current.targetStash }}</span><span class="caret" />
      </p>
    </article>
    <button v-if="!pinned" class="jump" :aria-label="t('backToLatest')" @click="backToBottom">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>
    </button>
  </div>
</template>

<style scoped>
.jump {
  position: sticky;
  bottom: 6px;
  flex: none;
  align-self: center;
  z-index: 3;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 8px 20px -8px rgba(10, 132, 255, 0.9);
  margin-top: -38px;
}
/* Same rows as the desktop stream (glass.css tokens), sized for a hand-held screen: the
   target line is the thing being read, so it carries the weight and the source fades. */
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 4px 16px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
/* Bottom-anchor a short list without justify-content:flex-end, which pushes the overflow of
   a long one past the scroll start where the oldest lines can't be scrolled back to. */
.stream > article:first-of-type { margin-top: auto; }
.empty {
  margin: auto;
  text-align: center;
  font-size: 14.5px;
  line-height: 1.68;
  color: var(--ink-3);
  max-width: 24ch;
}
.line-item { animation: slidein 0.35s var(--ease); }
@keyframes slidein { from { opacity: 0; transform: translateY(8px); } }
.src { margin: 0 0 4px; font-size: var(--mobile-src-size, 13px); line-height: 1.55; color: var(--ink-3); user-select: text; }
.tgt {
  margin: 0;
  font-size: var(--mobile-tgt-size, 20px);
  line-height: 1.5;
  font-weight: 620;
  letter-spacing: -0.012em;
  user-select: text;
}
.live .tgt { color: var(--accent); font-weight: 680; }
.live { padding-top: 13px; box-shadow: inset 0 1px 0 var(--hairline); }
.stash { opacity: 0.42; font-weight: 500; }
.caret {
  display: inline-block;
  width: 2px; height: 1em; margin-left: 3px;
  vertical-align: -0.13em;
  border-radius: 1px;
  background: currentColor;
  animation: blink 1.05s steps(2) infinite;
}
@keyframes blink { 50% { opacity: 0.25; } }

/* Full-screen subtitle / face-to-face: the room reads it, not the hand holding it. */
/* Centred when short, scrollable from the first line when long: auto margins, never
   justify-content, which loses the overflow above the scroll start. */
.stream.big { gap: 28px; padding: 12px 12px 24px; }
.stream.big > article:last-of-type { margin-bottom: auto; }
.stream.big .src { font-size: clamp(16px, 4.8vw, 21px); }
.stream.big .tgt { font-size: clamp(26px, 8vw, 40px); line-height: 1.3; letter-spacing: -0.02em; }
@media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
</style>
