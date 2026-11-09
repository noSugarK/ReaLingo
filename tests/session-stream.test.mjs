// Exercise the actual shared session/stream code; only OS I/O and persisted settings
// are replaced. Vue's computed refs/watchers and the language rules run unmodified.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { reactive, ref, nextTick } from 'vue';

const settings = reactive({
  protocol: 'qwen38', model: 'qwen3.8-livetranslate-flash-realtime',
  sourceLang: 'auto', targetLang: 'en', twoWay: false, speak: false,
  voice: 'Tina', savedVoices: {}, history: false,
});
const caps = ref({ os: 'android', loopback: false, keyring: false });
let key = 'test-key';
let calls = [];
let invokeImpl = async () => undefined;
const events = new Map();
globalThis.__sessionTest = { settings, caps, locale: ref('en'), activeKey: () => key,
  invoke: (cmd, args) => { calls.push({ cmd, args }); return invokeImpl(cmd, args); },
  listen: async (name, cb) => { events.set(name, cb); return () => events.delete(name); },
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = { setTimeout, clearTimeout };

registerHooks({
  resolve(specifier, context, next) {
    const name = specifier === '@tauri-apps/api/core' ? 'core'
      : specifier === '@tauri-apps/api/event' ? 'event'
      : specifier === '@tauri-apps/plugin-dialog' ? 'dialog'
      : /(?:^|\/)store(?:\.ts)?$/.test(specifier) ? 'store'
      : /(?:^|\/)platform(?:\.ts)?$/.test(specifier) ? 'platform'
      : /(?:^|\/)i18n(?:\.ts)?$/.test(specifier) ? 'i18n' : null;
    if (name) return { url: `session-test:${name}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(url)) return next(url.href);
    }
    return next(specifier);
  },
  load(url, context, next) {
    const sources = {
      core: 'export const invoke = globalThis.__sessionTest.invoke;',
      event: 'export const listen = globalThis.__sessionTest.listen;',
      dialog: 'export const save = async () => null;',
      store: 'export const { settings, activeKey } = globalThis.__sessionTest;',
      platform: 'export const { caps } = globalThis.__sessionTest;',
      i18n: 'export const { locale } = globalThis.__sessionTest; export const t = (s) => s;',
    };
    if (url.startsWith('session-test:')) return { format: 'module', shortCircuit: true, source: sources[url.split(':')[1]] };
    return next(url, context);
  },
});

const stream = await import('../src/core/stream.ts');
const { useSession } = await import('../src/core/session.ts');
const emit = (kind, values = {}) => events.get('rt://event')({ payload: { kind, text: '', id: '', stash: '', lang: '', done: false, ...values } });

test('connection and stopping stay distinct from listening and diagnostic progress resets for a new session', async () => {
  const s = useSession();
  stream.status.value = 'connecting';
  assert.equal(s.statusKey.value, 'statusConnecting');
  emit('audio', { text: '1500' });
  assert.equal(stream.audioMs.value, 1500);
  emit('audio', { text: 'NaN' });
  assert.equal(stream.audioMs.value, 1500);
  events.get('rt://raw')({ payload: { type: 'session.updated' } });
  assert.equal(stream.lastServerEvent.value, 'session.updated');
  emit('error', { text: 'server did not confirm session setup' });
  assert.match(stream.lastServerError.value, /confirm session setup/);
  emit('status', { text: 'closed' });
  assert.equal(stream.status.value, 'error');
  await stream.start({ kind: 'device', id: 'mic|default' }, false);
  assert.equal(stream.audioMs.value, 0);
  assert.equal(stream.lastServerEvent.value, '');
  assert.equal(stream.lastServerError.value, '');
  await stream.stop();
  emit('status', { text: 'connected' });
  assert.equal(stream.status.value, 'stopping');
  assert.equal(s.statusKey.value, 'statusStopping');
});

test('Android exports use the system document picker and report destination failures', async () => {
  const written = [];
  let state = { state: 'saved' };
  window.ReaLingoAndroid = {
    saveText: (name, contents) => written.push({ name, contents }),
    saveTextResult: () => JSON.stringify(state),
  };
  try {
    await stream.saveAs('srt', [{ id: 1, source: '原文', target: 'translation', at: 1000, start: 0, end: 1000 }]);
    assert.equal(written[0].name, 'translation.srt');
    assert.match(written[0].contents, /00:00:00,000 --> 00:00:01,000/);
    state = { state: 'cancelled' };
    await stream.saveAs('txt', []);
    state = { state: 'error', error: 'destination unavailable' };
    await assert.rejects(stream.saveAs('txt', []), /destination unavailable/);
  } finally { delete window.ReaLingoAndroid; }
});

test('polling recovers missed backend errors and cancellation without server events', async () => {
  await stream.start({ kind: 'device', id: 'mic|default' }, false);
  invokeImpl = async (cmd) => cmd === 'session_health' ? {
    status: 'error', phase: 'network', audioMs: 0, serverEvent: '', error: 'connect failed: TLS error',
  } : undefined;
  await stream.pollHealth();
  assert.equal(stream.status.value, 'error');
  assert.equal(stream.lastServerError.value, 'connect failed: TLS error');
  assert.equal(stream.connectionPhase.value, 'network');
  await stream.start({ kind: 'device', id: 'mic|default' }, false);
  invokeImpl = async (cmd) => cmd === 'session_health' ? {
    status: 'closed', phase: 'network', audioMs: 0, serverEvent: '', error: '',
  } : undefined;
  await stream.stop();
  assert.equal(stream.isRunning(), false);
});

test('an old health reply cannot override a replacement session', async () => {
  await stream.start({ kind: 'device', id: 'mic|default' }, false);
  let reply;
  invokeImpl = (cmd) => cmd === 'session_health' ? new Promise(resolve => { reply = resolve; }) : Promise.resolve();
  const pending = stream.pollHealth();
  await stream.start({ kind: 'device', id: 'mic|new' }, false);
  reply({ status: 'error', phase: 'network', error: 'old failure', audioMs: 0, serverEvent: '' });
  await pending;
  assert.equal(stream.status.value, 'connecting');
  assert.equal(stream.errorMsg.value, '');
});

test.beforeEach(async () => {
  key = 'test-key';
  calls = [];
  invokeImpl = async () => undefined;
  settings.history = false;
  settings.speak = false;
  settings.protocol = 'qwen38';
  settings.targetLang = 'en';
  settings.sourceLang = 'auto';
  stream.status.value = 'idle';
  await stream.start({ kind: 'device', id: 'mic|default' }, false);
  stream.status.value = 'idle';
  calls = [];
});

test('starting without a key or with a rejected permission guard never invokes capture', async () => {
  const s = useSession();
  key = '';
  assert.equal(await s.toggle(), false);
  key = 'test-key';
  assert.equal(await s.toggle(async () => false), false);
  assert.deepEqual(calls, []);
});

test('microphone selection prefers the OS default and filters output devices on Android', async () => {
  invokeImpl = async (cmd) => cmd === 'list_devices'
    ? [{ id: 'mic|one', name: 'Built-in', loopback: false }, { id: 'sys|out', name: 'Speaker', loopback: true }]
    : cmd === 'default_device' ? 'mic|one' : undefined;
  const s = useSession();
  await s.refreshDevices();
  assert.equal(s.deviceId.value, 'mic|one');
  assert.equal(s.deviceOptions.value.length, 1);
  assert.equal(s.canStart.value, true);
  await s.toggle();
  assert.deepEqual(calls.find((c) => c.cmd === 'start_stream').args.source, { kind: 'device', id: 'mic|one' });
});

test('file sessions pass the cached Android path rather than the microphone id', async () => {
  const s = useSession();
  s.sourceKind.value = 'file';
  s.filePath.value = '/data/user/0/app/cache/录音.m4a';
  await nextTick();
  assert.equal(s.fileName.value, '录音.m4a');
  await s.toggle();
  assert.deepEqual(calls.find((c) => c.cmd === 'start_stream').args.source,
    { kind: 'file', path: '/data/user/0/app/cache/录音.m4a' });
});

test('a native start failure becomes visible error state and a new run clears it', async () => {
  invokeImpl = async () => { throw new Error('microphone unavailable'); };
  await stream.start({ kind: 'device', id: 'bad' }, false);
  assert.equal(stream.status.value, 'error');
  assert.match(stream.errorMsg.value, /microphone unavailable/);
  assert.equal(stream.isRunning(), false);
  invokeImpl = async () => undefined;
  await stream.start({ kind: 'device', id: 'mic|default' }, false);
  assert.equal(stream.errorMsg.value, '');
  assert.equal(stream.status.value, 'connecting');
});

test('stop waits for server closure and toggling a live session stops capture', async () => {
  const s = useSession();
  stream.status.value = 'connected';
  await s.toggle();
  assert.equal(stream.status.value, 'stopping');
  assert.ok(calls.some((c) => c.cmd === 'stop_stream'));
  emit('status', { text: 'closed' });
  assert.equal(stream.isRunning(), false);
});

test('a late transcript patches its translation row without duplicating it', () => {
  emit('link', { id: 'answer', text: 'input' });
  emit('target', { id: 'answer', text: 'Hello', done: true, startMs: 100, endMs: 1500 });
  assert.equal(stream.lines.value.length, 1);
  emit('source', { id: 'input', text: '你好', lang: 'zh', done: true });
  assert.equal(stream.lines.value.length, 1);
  assert.equal(stream.lines.value[0].source, '你好');
  assert.equal(stream.lines.value[0].target, 'Hello');
  assert.equal(stream.detectedLang.value, 'zh');
  assert.equal(stream.current.source, '');
});

test('closing the session flushes partial text and preserves a preceding error', () => {
  emit('target', { id: 'partial', text: 'Hello', stash: ' world' });
  emit('error', { text: 'connection lost' });
  emit('status', { text: 'closed' });
  assert.equal(stream.status.value, 'error');
  assert.equal(stream.errorMsg.value, 'connection lost');
  assert.equal(stream.lines.value.length, 1);
  assert.match(stream.lines.value[0].target, /Hello/);
});

test('audio-file progress handles unknown duration and clears when finished', () => {
  emit('progress', { text: '1.5/?' });
  assert.deepEqual(stream.fileProgress.value, { sent: 1.5, total: null });
  emit('progress', { text: '3/12' });
  assert.deepEqual(stream.fileProgress.value, { sent: 3, total: 12 });
  emit('progress', { text: 'done' });
  assert.equal(stream.fileProgress.value, null);
});

test('SRT sorts audio timestamps and caps each cue at the following cue', () => {
  const rows = [{ source: '二', target: 'Two', at: 1000, start: 2000, end: 5000 },
    { source: '一', target: 'One', at: 2000, start: 500, end: 3000 }];
  assert.equal(stream.exportSrt(rows), '1\n00:00:00,500 --> 00:00:02,000\n一\nOne\n\n2\n00:00:02,000 --> 00:00:05,000\n二\nTwo\n');
  assert.equal(rows[0].target, 'Two', 'export must not reorder the UI');
});

test('old history exports use relative wall time and empty exports are valid', () => {
  assert.equal(stream.exportSrt([]), '');
  assert.equal(stream.exportTxt([]), '');
  const rows = [{ at: 100000, source: '', target: 'Hello' }];
  assert.equal(stream.exportSrt(rows), '1\n00:00:00,000 --> 00:00:03,000\nHello\n');
  assert.equal(stream.exportTxt(rows), 'Hello');
});
