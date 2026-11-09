import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

let bridge;
globalThis.__nativeBridge = () => bridge;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vue') return { url: 'test:vue', shortCircuit: true };
    if (specifier === './perms' && context.parentURL.includes('/mobile/native.ts')) return { url: 'test:bridge?' + context.parentURL.split('?')[1], shortCircuit: true };
    if (specifier === '../core/i18n' && context.parentURL.includes('/mobile/native.ts')) return { url: 'test:i18n', shortCircuit: true };
    return next(specifier);
  },
  load(url, context, next) {
    const source = {
      'test:vue': 'export const reactive = x => x;',
      'test:bridge': 'export const droid = globalThis.__nativeBridge();',
      'test:i18n': 'export const t = x => x;',
    }[url.split('?')[0]];
    return source ? { format: 'module', source, shortCircuit: true } : next(url);
  },
});
let serial = 0;
function fresh(value) { bridge = value; return import(`../src/mobile/native.ts?case=${++serial}`); }
function fake(state) {
  return { overlayStatus: () => JSON.stringify(state), systemAudioSupported: () => true,
    startCapture: kind => Object.assign(state, { captureKind: kind, ready: true }),
    stopCapture: () => Object.assign(state, { captureKind: '', ready: false }),
    requestSystemAudio: () => Object.assign(state, { captureKind: 'system', ready: true, systemState: 'ready' }),
    showOverlay: visible => Object.assign(state, { visible, ready: true }),
  };
}
test('native capture waits for readiness and preserves system consent cancellation', async () => {
  const state = { granted: true, visible: false };
  const b = fake(state), m = await fresh(b);
  assert.equal(await m.beginCapture('mic'), true);
  m.stopCapture(); m.refreshNative(); assert.equal(m.native.ready, false);
  assert.equal(await m.beginCapture('system'), true);
  b.requestSystemAudio = () => Object.assign(state, { systemState: 'cancelled' });
  assert.equal(await m.beginCapture('system'), false);
  await m.showOverlay(true); assert.equal(m.native.visible, true);
  await m.showOverlay(false); assert.equal(m.native.visible, false);
});
test('capture failures clean up the native recorder and unsupported systems fail clearly', async () => {
  const state = { error: 'recorder failed' }; const b = fake(state);
  let stopped = false; b.stopCapture = () => { stopped = true; };
  const m = await fresh(b);
  await assert.rejects(m.beginCapture('mic'), /recorder failed/); assert.equal(stopped, true);
  m.native.systemSupported = false;
  await assert.rejects(m.beginCapture('system'), /systemAudioAndroid10/);
});
test('missing native bridge is an explicit error rather than a silent recording', async () => {
  const m = await fresh(null);
  await assert.rejects(m.beginCapture('mic'), /nativeUnavailable/);
});
