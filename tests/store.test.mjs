import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { nextTick } from 'vue';

let saved;
let secure = false;
const persisted = [];
globalThis.__settingsTest = {
  load: async () => ({ get: async () => saved, set: async (_key, value) => persisted.push(value) }),
  invoke: async (cmd) => cmd === 'platform' ? { keyring: secure } : '',
};
globalThis.localStorage = { getItem: () => null };
globalThis.document = { documentElement: { dataset: {} } };
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener: () => {} }), setTimeout, clearTimeout };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tauri-apps/plugin-store') return { url: 'settings-test:store', shortCircuit: true };
    if (specifier === '@tauri-apps/api/core') return { url: 'settings-test:core', shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(url)) return next(url.href);
    }
    return next(specifier);
  },
  load(url, context, next) {
    if (url === 'settings-test:store') return { format: 'module', shortCircuit: true, source: 'export const load = globalThis.__settingsTest.load;' };
    if (url === 'settings-test:core') return { format: 'module', shortCircuit: true, source: 'export const invoke = globalThis.__settingsTest.invoke;' };
    return next(url, context);
  },
});
let seq = 0;
const fresh = () => import(`../src/core/store.ts?test=${++seq}`);

test('Android retains a user key in its settings fallback and saves edits', async () => {
  secure = false;
  saved = { apiKey: 'existing-key', keepScreenOn: false };
  const store = await fresh();
  await store.initSettings();
  assert.equal(store.activeKey(), 'existing-key');
  assert.equal(store.settings.keepScreenOn, false);
  store.setActiveKey('updated-key');
  await nextTick();
  assert.equal(persisted.at(-1).apiKey, 'updated-key');
});

test('credentials remain separate when the phone switches vendors', async () => {
  saved = undefined;
  const store = await fresh();
  store.setActiveKey('qwen-key');
  store.switchProtocol('openai');
  assert.equal(store.activeKey(), '');
  store.setActiveKey('openai-key');
  store.switchProtocol('qwen35');
  assert.equal(store.activeKey(), 'qwen-key');
  store.switchProtocol('openai');
  assert.equal(store.activeKey(), 'openai-key');
});

test('custom models and proxy URLs survive a round trip between providers', async () => {
  const store = await fresh();
  store.settings.model = 'custom-qwen';
  store.settings.url = 'wss://proxy.example';
  assert.equal(store.switchProtocol('openai'), true);
  store.settings.model = 'custom-openai';
  store.switchProtocol('qwen38');
  assert.equal(store.settings.model, 'custom-qwen');
  assert.equal(store.settings.url, 'wss://proxy.example');
  assert.equal(store.switchProtocol('qwen38'), false);
});

test('old subtitle settings migrate without discarding explicit choices', async () => {
  secure = false;
  saved = { sub: { fontSize: 40, locked: false }, stream: { srcSize: 999, tgtSize: 'bad' } };
  const store = await fresh();
  await store.initSettings(false);
  assert.equal(store.settings.sub.srcSize, 25);
  assert.equal(store.settings.sub.tgtSize, 40);
  assert.equal(store.settings.sub.locked, false);
  assert.equal(store.settings.sub.mobileWidth, 88);
  assert.equal(store.settings.sub.fontSize, undefined);
  assert.equal(store.settings.stream.srcSize, 32);
  assert.equal(store.settings.stream.tgtSize, 16);
});

test('phone hotwords, workspace and subtitle controls persist together', async () => {
  secure = false;
  saved = { hotwords: { 人工智能: 'AI' }, workspaceId: 'llm-example', sub: { mobileWidth: 72, locked: true } };
  const store = await fresh();
  await store.initSettings();
  assert.deepEqual(store.settings.hotwords, { 人工智能: 'AI' });
  assert.equal(store.settings.workspaceId, 'llm-example');
  assert.equal(store.settings.sub.mobileWidth, 72);
  store.settings.hotwords = { 实时翻译: 'Live translation' };
  await nextTick();
  assert.deepEqual(persisted.at(-1).hotwords, { 实时翻译: 'Live translation' });
});

test('where a credential store exists persisted settings never contain API keys', async () => {
  secure = true;
  saved = undefined;
  const store = await fresh();
  await store.initSettings();
  store.setActiveKey('must-not-persist');
  await nextTick();
  assert.equal(persisted.at(-1).apiKey, '');
  assert.equal(store.activeKey(), 'must-not-persist');
});
