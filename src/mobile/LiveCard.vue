<script setup lang="ts">
import { computed } from "vue";
import { current, isRunning, session } from "../core/session";
import { settings } from "../core/store";
import { t } from "../core/i18n";

/** Whether the live sentence has anything on either side of the pair. */
const hasLive = computed(() => !!(current.source || current.sourceStash || current.target || current.targetStash));
</script>

<template>
  <!-- The live sentence pinned under the history gets its own emphasis card (the native
     port's pattern): the transcript rows run cardless above, the "now" carries the weight. -->
  <article
    v-if="hasLive || isRunning()"
    class="livecard glass"
    :style="{ '--mobile-src-size': settings.stream.srcSize + 'px', '--mobile-tgt-size': settings.stream.tgtSize + 'px' }"
  >
    <template v-if="hasLive">
      <p v-if="current.source || current.sourceStash" class="src">
        {{ current.source }}<span class="stash">{{ current.sourceStash }}</span>
      </p>
      <p class="tgt">
        {{ current.target }}<span class="stash">{{ current.targetStash }}</span><span class="caret" />
      </p>
    </template>
    <!-- Running but nothing said yet: reuse the status copy instead of inventing one. -->
    <p v-else class="wait">{{ t(session.statusKey.value) }}</p>
  </article>
</template>

<style scoped>
.livecard {
  flex: none;
  border-radius: 20px;
  padding: 12px 14px;
}
.src { margin: 0 0 4px; font-size: var(--mobile-src-size, 13px); line-height: 1.55; color: var(--ink-3); user-select: text; }
.tgt {
  margin: 0;
  font-size: var(--mobile-tgt-size, 20px);
  line-height: 1.5;
  font-weight: 680;
  letter-spacing: -0.012em;
  color: var(--accent);
  user-select: text;
}
.stash { opacity: 0.42; font-weight: 500; }
.wait { margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink-3); }
.caret {
  display: inline-block;
  width: 2px; height: 1em; margin-left: 3px;
  vertical-align: -0.13em;
  border-radius: 1px;
  background: currentColor;
  animation: blink 1.05s steps(2) infinite;
}
@keyframes blink { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
</style>
