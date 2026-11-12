import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { computed, ref } from 'vue';

globalThis.__outputsTest = { computed, ref };
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/mobile/outputs.ts') && ['vue', '@tauri-apps/api/core', '../core/i18n'].includes(specifier)) {
      return { url: 'outputs-test:' + specifier, shortCircuit: true };
    }
    return next(specifier);
  },
  load(url, context, next) {
    const source = {
      'outputs-test:vue': 'export const { computed, ref } = globalThis.__outputsTest; export const onMounted = fn => globalThis.__outputsTest.mounts.push(fn); export const onUnmounted = fn => globalThis.__outputsTest.unmounts.push(fn);',
      'outputs-test:@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__outputsTest.invoke(...args);',
      'outputs-test:../core/i18n': 'export const t = key => key;',
    }[url];
    return source ? { format: 'module', source, shortCircuit: true } : next(url, context);
  },
});

let serial = 0;
const settle = () => new Promise(setImmediate);
async function fresh(t, invoke) {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  Object.assign(globalThis.__outputsTest, { invoke, mounts: [], unmounts: [] });
  const module = await import(`../src/mobile/outputs.ts?test=${++serial}`);
  const state = module.useOutputDevices();
  t.after(() => globalThis.__outputsTest.unmounts.forEach(fn => fn()));
  return { ...module, ...state };
}
const speaker = { value: 'speaker', name: 'Phone', kind: 'speaker' };
const buds = { value: 'device|AAudio:12', name: 'Buds A', kind: 'bluetooth' };
const usb = { value: 'device|AAudio:13', name: 'USB DAC', kind: 'usb' };

test('system routing is always first and connected Bluetooth/USB outputs keep their names', async t => {
  const state = await fresh(t, async cmd => { assert.equal(cmd, 'output_devices'); return [speaker, buds, usb]; });
  await state.refresh();
  assert.deepEqual(state.options.value.map(option => option.value), ['', 'speaker', buds.value, usb.value]);
  assert.equal(state.outputName('', state.devices.value), 'outAuto');
  assert.equal(state.outputName(buds.value, state.devices.value), 'Buds A');
  assert.equal(state.outputName('speaker', state.devices.value), 'outSpeaker');
  assert.equal(state.selectedOutput('headphones', state.devices.value), buds.value);
});

test('hotplug and resume refresh the list; disconnected choices remain identifiable', async t => {
  let devices = [speaker, buds], calls = 0;
  const state = await fresh(t, async () => { calls++; return devices; });
  globalThis.__outputsTest.mounts.forEach(fn => fn()); await settle();
  devices = [speaker]; window.dispatchEvent(new Event('realingo:outputs')); await settle();
  assert.equal(state.devices.value.length, 1);
  assert.equal(state.outputName(buds.value, state.devices.value), 'outputMissingShort');
  devices = [speaker, usb]; document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(state.devices.value[1].name, 'USB DAC');
  assert.equal(calls, 3);
});

test('failed enumeration keeps system routing available and can recover', async t => {
  let fail = true;
  const state = await fresh(t, async () => { if (fail) throw new Error('no devices'); return [buds]; });
  await state.refresh();
  assert.equal(state.failed.value, true);
  assert.deepEqual(state.options.value, [{ value: '', label: 'outAuto' }]);
  fail = false; await state.refresh();
  assert.equal(state.failed.value, false);
  assert.equal(state.devices.value[0].name, 'Buds A');
});

test('stale enumeration and late unmount results cannot overwrite newer devices', async t => {
  const replies = [];
  const state = await fresh(t, () => new Promise(resolve => replies.push(resolve)));
  const old = state.refresh(), latest = state.refresh();
  replies[1]([usb]); await latest;
  replies[0]([buds]); await old;
  assert.equal(state.devices.value[0].name, 'USB DAC');
  const late = state.refresh();
  globalThis.__outputsTest.unmounts.forEach(fn => fn());
  replies[2]([buds]); await late;
  assert.equal(state.devices.value[0].name, 'USB DAC');
});
