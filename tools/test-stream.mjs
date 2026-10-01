// Exercise the real stream reducer with mocked Tauri transport, without a desktop window.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

globalThis.window = { clearTimeout, setTimeout };
globalThis.__events = new Map();
globalThis.__calls = [];
globalThis.__settings = {
  mode: "transcribe", transcriptionLang: "auto", sourceLang: "en",
  targetLang: "zh", model: "qwen3.5-livetranslate-flash-realtime", history: false,
};
const result = await build({
  entryPoints: ["src/stream.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "mock-tauri", setup(b) {
    b.onResolve({ filter: /^@tauri-apps\// }, args => ({ path: args.path, namespace: "mock" }));
    b.onResolve({ filter: /^\.\/store$/ }, () => ({ path: "store", namespace: "mock" }));
    b.onResolve({ filter: /^\.\/i18n$/ }, () => ({ path: "i18n", namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents:
      args.path === "store" ? "export const settings = globalThis.__settings;" :
      args.path === "i18n" ? "export const t = key => key;" :
      args.path.includes("/event") ? "export async function listen(name, fn) { globalThis.__events.set(name, fn); }" :
      args.path.includes("plugin-dialog") ? "export async function save() { return null; }" :
      "export async function invoke(name, args) { globalThis.__calls.push({name, args}); }",
    }));
  } }],
});
const directory = await mkdtemp(join(tmpdir(), "realingo-stream-"));
try {
  const path = join(directory, "stream.mjs");
  await writeFile(path, result.outputFiles[0].text);
  const stream = await import(pathToFileURL(path));
  const send = e => globalThis.__events.get("rt://event")({ payload: {
    text: "", stash: "", lang: "", id: "", done: false, ...e,
  } });
  send({ kind: "mode", text: "transcribe" });
  send({ kind: "source", id: "a", text: "Hello", stash: " world", lang: "en" });
  assert.equal(stream.current.source, "Hello");
  assert.equal(stream.current.sourceStash, " world");
  assert.equal(stream.detectedLang.value, "en");
  assert.equal(stream.lines.value.length, 0);
  // Later speech may arrive while the previous utterance is still being finalized.
  send({ kind: "source", id: "b", text: "你好", lang: "zh" });
  send({ kind: "source", id: "a", text: "Hello world.", lang: "en", done: true });
  assert.equal(stream.current.source, "你好");
  send({ kind: "source", id: "b", text: "你好，这是中文。", lang: "zh", done: true });
  assert.deepEqual(stream.lines.value.map(l => [l.source, l.target]), [
    ["Hello world.", ""], ["你好，这是中文。", ""],
  ]);
  assert.equal(stream.exportTxt(), "Hello world.\n\n你好，这是中文。");
  assert.match(stream.exportSrt(), /你好，这是中文。\n$/);
  assert.equal(stream.current.source, "");

  // Stopping must retain the input turn until its final ASR response arrives.
  send({ kind: "status", text: "connected" });
  send({ kind: "source", id: "c", text: "最后" });
  await stream.stop();
  assert.equal(stream.status.value, "stopping");
  assert.equal(stream.isRunning(), true);
  send({ kind: "source", id: "c", text: "最后一句。", done: true });
  send({ kind: "status", text: "closed" });
  assert.equal(stream.lines.value.length, 3);
  assert.equal(stream.lines.value[2].source, "最后一句。");
  assert.equal(stream.isRunning(), false);

  // Translation continues pairing assistant ids with input ids, including late ASR.
  send({ kind: "mode", text: "translate" });
  send({ kind: "link", text: "in1", id: "out1" });
  send({ kind: "target", id: "out1", text: "你好。", done: true });
  send({ kind: "link", text: "in2", id: "out2" });
  send({ kind: "source", id: "in1", text: "Hello.", done: true });
  send({ kind: "target", id: "out2", text: "再见。", done: true });
  send({ kind: "source", id: "in2", text: "Goodbye.", done: true });
  assert.equal(stream.exportTxt(), "Hello.\n你好。\n\nGoodbye.\n再见。");
  assert.equal(stream.lines.value.length, 2);

  globalThis.__settings.mode = "transcribe";
  globalThis.__settings.history = true;
  await stream.start({ kind: "file", path: "synthetic.wav" });
  const meta = globalThis.__calls.find(c => c.name === "history_open").args.meta;
  assert.equal(meta.mode, "transcribe");
  assert.equal(meta.source, "auto");
  assert.equal(meta.target, "");
  assert.equal(meta.model, "qwen3-asr-flash-realtime");
  send({ kind: "source", id: "history-turn", text: "Recorded original.", done: true });
  const entry = globalThis.__calls.find(c => c.name === "history_append").args.entry;
  assert.equal(entry.source, "Recorded original.");
  assert.equal(entry.target, "");
  console.log("PASS: standalone ASR, overlapping turns, final text after stop, translation pairing, TXT/SRT, history metadata");
} finally {
  await rm(directory, { recursive: true, force: true });
}
