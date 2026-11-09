// The perms.ts state machine against a fake window.ReaLingoAndroid — the exact four
// states the design names (unset/granted/denied/permanent), the invoke fallback, the
// polling for the system dialog, and the SAF pick loop. Node's own type stripping runs
// the .ts; the hooks replace vue and the tauri core so nothing real loads.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Swapped per case before each fresh import: the module snapshots the bridge at load.
let bridge = null;
globalThis.window = { get ReaLingoAndroid() { return bridge; } };

let invokeLog = [];
let invokeImpl = async () => { throw new Error('no such command'); };

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'vue') return { url: 'test:vue', shortCircuit: true };
    if (specifier === '@tauri-apps/api/core') return { url: 'test:tauri-core', shortCircuit: true };
    return next(specifier);
  },
  load(url, _context, next) {
    if (url === 'test:vue') return { format: 'module', shortCircuit: true, source: 'export const reactive = (o) => o;' };
    if (url === 'test:tauri-core') return { format: 'module', shortCircuit: true, source: 'export const invoke = (cmd, args) => globalThis.__invoke(cmd, args);' };
    return next(url);
  },
});
globalThis.__invoke = (cmd, args) => { invokeLog.push(cmd); return invokeImpl(cmd, args); };

let case_ = 0;
function fresh() {
  // A query busts the module cache so each case gets its own snapshot of the bridge
  // and its own `asked` flag from the (shared) localStorage stub.
  return import(`../src/mobile/perms.ts?case=${++case_}`);
}

function status({ granted, rationale }) {
  return () => JSON.stringify({ granted, rationale });
}

test('bridge states map to the four design states', async () => {
  bridge = { micStatus: status({ granted: true, rationale: false }), notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'Pixel 8' };
  const { perms, refreshPerms } = await fresh();
  await refreshPerms();
  assert.equal(perms.mic, 'granted');
  assert.equal(perms.deviceName, 'Pixel 8');

  store.clear();
  bridge = { micStatus: status({ granted: false, rationale: true }), notifEnabled: () => false, batteryIgnored: () => false, deviceName: () => 'X' };
  const m2 = await fresh();
  await m2.refreshPerms();
  assert.equal(m2.perms.mic, 'denied'); // asked flag unset, rationale true

  store.clear();
  store.set('micAsked', '1');
  bridge = { micStatus: status({ granted: false, rationale: false }), notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'X' };
  const m3 = await fresh();
  await m3.refreshPerms();
  assert.equal(m3.perms.mic, 'permanent');
  assert.deepEqual(m3.pendingList(), ['mic']);
});

test('first-ever prompt reads unset, not permanent', async () => {
  store.clear();
  bridge = { micStatus: status({ granted: false, rationale: false }), notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'X' };
  const m = await fresh();
  await m.refreshPerms();
  assert.equal(m.perms.mic, 'unset');
  assert.deepEqual(m.pendingList(), []); // the OS dialog owns this case, no alarm
});

test('no bridge, no commands: permissive defaults, no throw', async () => {
  bridge = null;
  invokeImpl = async () => { throw new Error('no such command'); };
  const m = await fresh();
  await m.refreshPerms();
  assert.equal(m.perms.mic, 'unset');
  assert.equal(m.perms.notif, true);
  assert.equal(m.perms.battery, true);
});

test('legacy invoke fallback answers when the bridge is absent', async () => {
  bridge = null;
  invokeImpl = async (cmd) => {
    if (cmd === 'perm_status') return { granted: true, rationale: false };
    if (cmd === 'notif_enabled' || cmd === 'battery_ignored') return true;
    if (cmd === 'device_name') return 'macOS';
    throw new Error(cmd);
  };
  const m = await fresh();
  await m.refreshPerms();
  assert.equal(m.perms.mic, 'granted');
  assert.equal(m.perms.deviceName, 'macOS');
  assert.ok(invokeLog.includes('perm_status'));
});

test('askMic fires the bridge dialog and polls until the answer moves', async () => {
  store.clear();
  let asked = false;
  bridge = {
    requestMic: () => { asked = true; },
    micStatus: () => JSON.stringify({ granted: asked, rationale: false }),
    notifEnabled: () => true,
    batteryIgnored: () => true,
    deviceName: () => 'X',
  };
  const m = await fresh();
  await m.refreshPerms();
  assert.equal(m.perms.mic, 'unset');
  const state = await m.askMic();
  assert.ok(asked, 'the system dialog was fired through the bridge');
  assert.equal(state, 'granted');
  assert.equal(localStorage.getItem('micAsked'), '1');
});

test('pickAudio walks the one-slot state machine', async () => {
  const seq = ['{"state":"busy"}', '{"state":"busy"}', '{"state":"picked","path":"/data/user/0/com.nosugark.realingo/cache/picked-a.m4a"}'];
  bridge = { pickAudioFile: () => {}, pickResult: () => seq.shift() ?? '{"state":"idle"}' };
  const m = await fresh();
  assert.equal(await m.pickAudio(), '/data/user/0/com.nosugark.realingo/cache/picked-a.m4a');

  bridge = { pickAudioFile: () => {}, pickResult: () => '{"state":"cancelled"}' };
  const m2 = await fresh();
  assert.equal(await m2.pickAudio(), null);

  bridge = null;
  const m3 = await fresh();
  assert.equal(await m3.pickAudio(), null); // desktop: no bridge, caller falls to the dialog plugin
});

test('an open system prompt cannot be mistaken for permanent denial', async () => {
  store.clear();
  let polling = 0;
  bridge = {
    requestMic: () => {},
    micStatus: () => {
      polling++;
      return JSON.stringify({ granted: polling > 4, rationale: false, requesting: polling <= 4 });
    },
    notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'vivo X300',
  };
  const m = await fresh();
  assert.equal(await m.askMic(), 'granted');
  assert.deepEqual(m.pendingList(), []);
});

test('a prompt left open past the poll window keeps the start intent for resume', async (t) => {
  store.clear();
  bridge = {
    requestMic: () => {},
    micStatus: () => JSON.stringify({ granted: false, rationale: false, requesting: true }),
    notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'X',
  };
  const m = await fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asks = [m.askMic(true), m.askMic()];
  for (let i = 0; i < 61; i++) { await new Promise(setImmediate); t.mock.timers.tick(500); }
  await Promise.all(asks);
  assert.equal(m.perms.pendingStart, true);
  m.perms.pendingStart = false;
  const centre = m.askMic();
  for (let i = 0; i < 61; i++) { await new Promise(setImmediate); t.mock.timers.tick(500); }
  await centre;
  assert.equal(m.perms.pendingStart, false, 'asking from the permission centre never auto-starts');
});

test('a completed repeated denial returns promptly even when the state is unchanged', async () => {
  store.clear();
  bridge = {
    requestMic: () => {},
    micStatus: () => JSON.stringify({ granted: false, rationale: true, requesting: false }),
    notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'X',
  };
  const m = await fresh();
  await m.refreshPerms();
  assert.equal(await m.askMic(), 'denied');
});

test('returning from settings refreshes revoked permissions and battery status', async () => {
  store.clear();
  bridge = {
    micStatus: status({ granted: true, rationale: false }),
    notifEnabled: () => true, batteryIgnored: () => true, deviceName: () => 'X',
  };
  const m = await fresh();
  await m.refreshPerms();
  store.set('micAsked', '1');
  bridge.micStatus = status({ granted: false, rationale: true });
  bridge.batteryIgnored = () => false;
  await m.refreshPerms();
  assert.equal(m.perms.mic, 'denied');
  assert.deepEqual(m.pendingList(), ['battery']);
});
