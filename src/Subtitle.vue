<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { emitTo, listen } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { initSettings, settings, type SubtitleStyle } from "./store";
import { current, lines } from "./stream";
import { t } from "./i18n";

const style = ref<SubtitleStyle>(settings.sub);
const barEl = ref<HTMLElement | null>(null);

onMounted(async () => {
  // Before the await: a failure loading settings must not also cost us the height fit.
  if (barEl.value) new ResizeObserver(() => void fitHeight()).observe(barEl.value);
  // Read-only mirror: the main window owns persistence, this one just follows it.
  await initSettings(false);
  style.value = settings.sub;
});

/** Keeps a one-line plate grabbable when the overlay is unlocked and otherwise idle. */
const MIN_H = 110;

/**
 * The window has a fixed height, so a long sentence simply overflows its top edge and the
 * start of the line is lost — the window boundary clips it, and no amount of CSS inside
 * can bring it back. Grow the window to the text instead, pinning the bottom edge so the
 * bar stays where the user parked it and only the top climbs.
 *
 * This does mean a height the user set by dragging is overridden on the next sentence.
 * Width is left alone, which is the dimension that actually decides how the text wraps.
 */
let fitting = false;
async function fitHeight() {
  const el = barEl.value;
  if (fitting || !el) return;
  fitting = true;
  try {
    const w = getCurrentWindow();
    const factor = await w.scaleFactor();
    const pos = (await w.outerPosition()).toLogical(factor);
    const size = (await w.outerSize()).toLogical(factor);
    // .wrap's padding, which sits outside the measured bar.
    const want = Math.min(
      Math.max(Math.ceil(el.scrollHeight) + 16, MIN_H),
      Math.round(screen.availHeight * 0.6)
    );
    // Sub-pixel churn would fire a window call on every frame of the live transcript.
    if (Math.abs(want - size.height) < 2) return;
    await w.setSize(new LogicalSize(size.width, want));
    await w.setPosition(new LogicalPosition(pos.x, pos.y + size.height - want));
  } finally {
    fitting = false;
  }
}

// Font size changes the text height without changing the line count, so the observer alone
// can miss it on the frame the new size lands.
watch(() => [style.value.fontSize, style.value.grow], () => void fitHeight());

/**
 * Ticker mode: a line that still fits stays centred like everywhere else in the overlay;
 * one that has outgrown the plate switches to left-aligned and is scrolled to its end, so
 * what falls off the left is only what was already spoken.
 *
 * The run's own width decides it, not `scrollWidth`: while the text is centred the part
 * hanging off the left is not counted as scrollable overflow, so `scrollWidth` alone
 * cannot tell "fits" from "overflows by a little".
 */
function tail() {
  if (style.value.grow) return;
  barEl.value?.querySelectorAll("p").forEach((p) => {
    const run = p.querySelector<HTMLElement>(".run");
    const over = !!run && run.offsetWidth > p.clientWidth;
    p.classList.toggle("over", over);
    if (over) p.scrollLeft = p.scrollWidth;
  });
}

void listen<SubtitleStyle>("sub://style", ({ payload }) => {
  style.value = payload;
});

/**
 * Right-click menu, for tweaking the overlay without going back to the main window.
 *
 * Only reachable while the overlay is unlocked — click-through means the window never sees
 * a mouse event at all, which is the whole point of it. The ghost text says where to undo.
 *
 * The overlay only mirrors the settings; the main window owns and persists them, so a pick
 * is sent there and comes back through the usual `sub://style` broadcast.
 */
async function openMenu() {
  const pick = <K extends keyof SubtitleStyle>(text: string, key: K, value: SubtitleStyle[K]) =>
    CheckMenuItem.new({
      text,
      checked: style.value[key] === value,
      action: () => void emitTo("main", "sub://patch", { [key]: value }),
    });
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });

  const menu = await Menu.new({
    items: await Promise.all([
      pick(t("subBoth"), "mode", "both"),
      pick(t("subTarget"), "mode", "target"),
      pick(t("subSource"), "mode", "source"),
      sep(),
      pick(t("alignLeft"), "align", "left"),
      pick(t("alignCenter"), "align", "center"),
      pick(t("alignRight"), "align", "right"),
      sep(),
      pick(t("subGrow"), "grow", true),
      pick(t("subTicker"), "grow", false),
      sep(),
      pick(t("subLockShort"), "locked", true),
      MenuItem.new({
        text: t("subHide"),
        action: () => void emitTo("main", "sub://patch", { show: false }),
      }),
    ]),
  });
  await menu.popup();
}

const last = computed(() => lines.value[lines.value.length - 1]);
const live = computed(() => !!(current.source || current.target || current.sourceStash || current.targetStash));
const src = computed(() => (live.value ? current.source : last.value?.source ?? ""));
const tgt = computed(() => (live.value ? current.target : last.value?.target ?? ""));
const srcStash = computed(() => (live.value ? current.sourceStash : ""));
const tgtStash = computed(() => (live.value ? current.targetStash : ""));

// The height observer only sees the plate grow downwards; a line growing sideways has to
// be chased separately, after the DOM has the new text.
watch(
  [src, tgt, srcStash, tgtStash, () => style.value.grow, () => style.value.fontSize, () => style.value.align],
  () => nextTick(tail)
);

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
    textAlign: style.value.align,
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
  <div class="wrap" :class="{ locked: style.locked, idle: empty }" @contextmenu.prevent="openMenu">
    <div
      ref="barEl"
      class="bar"
      :class="{ ticker: !style.grow }"
      :style="barStyle"
      :data-tauri-drag-region="style.locked ? undefined : true"
    >
      <p v-if="showSource" class="src" :style="{ color: style.srcColor, textShadow: outline }">
        <span class="run">{{ src }}<span class="stash">{{ srcStash }}</span></span>
      </p>
      <p v-if="showTarget" class="tgt" :style="{ color: style.color, textShadow: outline }">
        <span class="run">{{ tgt }}<span class="stash">{{ tgtStash }}</span></span>
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

/* One line per row; `tail()` decides alignment — centred while it fits, then scrolled to
   the end once it does not. */
.bar.ticker p { overflow: hidden; }
.bar.ticker p.over { text-align: left; }
.bar.ticker .run { display: inline-block; white-space: nowrap; }

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
