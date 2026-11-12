import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { reactive, watch } from 'vue';

const source = readFileSync(new URL('../src/mobile/MobileApp.vue', import.meta.url), 'utf8');
const handler = source.match(/async function handleNotificationCommand\(\) \{[\s\S]*?^\}/m)[0];

test('notification commands start/stop once, toggle subtitles and unlock without stopping', async () => {
  let command = '', running = false;
  const calls = [], settings = { sub: { locked: true } };
  const handle = runInNewContext(handler + '; handleNotificationCommand', {
    droid: { takeNotificationCommand: () => { const next = command; command = ''; return next; } },
    settings, isRunning: () => running,
    start: async () => { calls.push('start'); running = true; },
    stop: async () => { calls.push('stop'); running = false; },
    toggleOverlay: async () => calls.push('subtitles'),
  });
  command = 'stop'; await handle(); assert.deepEqual(calls, []);
  command = 'start'; await handle(); await handle(); assert.deepEqual(calls, ['start']);
  command = 'subtitles'; await handle(); assert.equal(running, true);
  command = 'unlock'; await handle(); assert.equal(settings.sub.locked, false);
  command = 'stop'; await handle(); assert.equal(running, false);
  assert.deepEqual(calls, ['start', 'subtitles', 'stop']);
});

test('a native lock followed by notification unlock in the same tick sends both explicit commands', () => {
  const settings = reactive({ sub: { locked: false } }), calls = [];
  const subscription = source.split('\n').find(line => line.startsWith('watch(() => settings.sub.locked,'));
  const stop = runInNewContext(subscription, { watch, settings, droid: { setOverlayLocked: locked => calls.push(locked) } });
  try {
    settings.sub.locked = true;
    settings.sub.locked = false;
    assert.deepEqual(calls, [false, true, false]);
  } finally { stop(); }
});
