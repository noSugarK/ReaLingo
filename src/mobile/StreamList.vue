<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { settings } from "../core/store";
import type { Line } from "../core/stream";
import { current } from "../core/session";

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
  if (pinned.value) el.value?.scrollTo({ top: el.value.scrollHeight });
});
</script>

<template>
  <div ref="el" class="stream" :class="{ big }" :style="{ '--mobile-src-size': settings.stream.srcSize + 'px', '--mobile-tgt-size': settings.stream.tgtSize + 'px' }" @scroll.passive="onScroll">
    <button v-if="!pinned" class="jump" @click="backToBottom">↓</button>
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
  </div>
</template>

<style scoped>
.jump {
  position: sticky;
  top: 0;
  align-self: center;
  z-index: 3;
  height: 30px;
  padding: 0 14px;
  border-radius: 999px;
  background: rgba(11, 13, 19, 0.72);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 8px 20px -8px rgba(0, 0, 0, 0.7);
  margin-bottom: -30px;
}
/* Same rows as the desktop stream (glass.css tokens), sized for a hand-held screen: the
   target line is the thing being read, so it carries the weight and the source fades. */
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 16px;
  padding: 4px 4px 16px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
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
.stream.big { justify-content: center; gap: 30px; padding: 24px; }
.stream.big .src { font-size: 21px; }
.stream.big .tgt { font-size: 40px; line-height: 1.32; letter-spacing: -0.02em; }
@media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
</style>
