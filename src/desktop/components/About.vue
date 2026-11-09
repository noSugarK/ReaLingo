<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { locale, t } from "../../core/i18n";
import { check, checkUpdate, openHome, whatsNew } from "../../core/update";
import Sheet from "../../shared/Sheet.vue";
import AboutLinks from "../../shared/AboutLinks.vue";
import mark from "../../assets/mark.png";

defineEmits<{ close: [] }>();

const version = ref("");
onMounted(async () => {
  version.value = await getVersion();
  // The startup check stays quiet when it fails; here someone is asking, so try again.
  if (check.value.state === "idle") void checkUpdate();
});

// Always via the opener plugin — an <a href> navigates the app's own webview away.
const open = (url: string) => invoke("plugin:opener|open_url", { url });

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The inline markup the release notes use. Escaped first; links only ever http(s). */
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

/**
 * Just enough Markdown for a release note — headings, bullets, paragraphs — rather than a
 * library for a dozen lines of our own text.
 */
function renderNotes(md: string): string {
  const out: string[] = [];
  let inList = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const item = /^[-*] (.*)/.exec(line);
    if (!item && inList) {
      out.push("</ul>");
      inList = false;
    }
    if (item) {
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${inline(item[1])}</li>`);
    } else if (/^#{1,4} /.test(line)) {
      out.push(`<h4>${inline(line.replace(/^#+ /, ""))}</h4>`);
    } else if (line) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

const notesHtml = computed(() => renderNotes(whatsNew(check.value.body ?? "", locale.value)));
const notesTitle = computed(() =>
  check.value.state === "found"
    ? `${t("updNewVersion")} ${check.value.tag} · ${t("updNotes")}`
    : `${check.value.tag} · ${t("updNotes")}`
);

/** Links in the notes go to the browser, never into this window. */
function onNotesClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  void open(a.href);
}
</script>

<template>
  <Sheet :title="t('about')" @close="$emit('close')">
    <div class="hero">
      <img :src="mark" alt="" draggable="false" />
      <div>
        <strong>ReaLingo</strong>
        <span class="ver">v{{ version }}</span>
        <p>{{ t("aboutTagline") }}</p>
      </div>
    </div>

    <div class="update">
      <button class="btn" :disabled="check.state === 'checking'" @click="checkUpdate">
        {{ check.state === "checking" ? t("updChecking") : t("updCheck") }}
      </button>
      <button
        v-if="check.state === 'found'"
        class="btn btn-primary"
        @click="openHome"
      >
        {{ t("updFound") }} {{ check.tag }} ↗
      </button>
      <span v-else-if="check.state === 'latest'" class="note">{{ t("updLatest") }}</span>
      <span v-else-if="check.state === 'failed'" class="note warn">{{ t("updFailed") }}</span>
    </div>

    <!-- The newer release's notes when there is one, otherwise the latest (usually this one). -->
    <section v-if="notesHtml" class="notes">
      <h3>{{ notesTitle }}</h3>
      <div class="notes-body" @click="onNotesClick" v-html="notesHtml" />
    </section>

    <hr />

    <AboutLinks :version="version" />
  </Sheet>
</template>

<style scoped>
.hero { display: flex; align-items: center; gap: 14px; }
.hero img { width: 56px; height: auto; -webkit-user-drag: none; }
.hero strong { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.hero p { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--ink-3); }

.ver {
  margin-left: 7px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px; font-weight: 700;
  color: var(--accent);
  background: rgba(10, 132, 255, 0.12);
}

.update { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.update .btn { height: 32px; padding: 0 14px; font-size: 13px; }
.note { font-size: 12px; color: var(--ink-3); }
.note.warn { color: var(--danger); }

.notes h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; }
/* Capped and scrolling: a long release must not push the links below out of the sheet. */
.notes-body {
  max-height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  background: var(--shade);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
  user-select: text;
}
/* v-html content is not scoped: reach it with :deep. */
.notes-body :deep(h4) { margin: 10px 0 4px; font-size: 12.5px; font-weight: 700; color: var(--ink); }
.notes-body :deep(h4:first-child) { margin-top: 0; }
.notes-body :deep(ul) { margin: 0; padding-left: 18px; }
.notes-body :deep(li + li) { margin-top: 3px; }
.notes-body :deep(p) { margin: 4px 0; }
.notes-body :deep(code) {
  padding: 0 4px;
  border-radius: 4px;
  font-family: "SF Mono", "Cascadia Code", ui-monospace, monospace;
  font-size: 11.5px;
  background: var(--hairline);
}
.notes-body :deep(a) { color: var(--accent); }

hr { border: none; border-top: 1px solid var(--hairline); margin: 0; }
</style>
