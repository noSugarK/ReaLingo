import assert from 'node:assert/strict';
import test from 'node:test';
import { targetBounds, appCrashLines } from '../.github/scripts/smoke-android.mjs';
import { decode } from '../tools/png.mjs';

test('UI navigation locates visible English and Chinese controls by text or accessibility label', () => {
  const xml = '<hierarchy><node text="" content-desc="Settings" bounds="[20,30][60,70]" />' +
    '<node text="权限中心" content-desc="" bounds="[10,100][210,140]" /></hierarchy>';
  assert.deepEqual(targetBounds(xml, ['Settings', '设置']), [40, 50]);
  assert.deepEqual(targetBounds(xml, ['Permission center', '权限中心']), [110, 120]);
  assert.equal(targetBounds(xml, ['Missing']), null);
});

test('hidden or malformed controls never become taps at the origin', () => {
  const xml = '<node text="Start" bounds="[0,0][0,0]" /><node text="Start" />';
  assert.equal(targetBounds(xml, ['Start']), null);
});

test('a button title remains navigable when Android merges its subtitle into the label', () => {
  const xml = '<node text="Permission center Microphone · notifications · battery All ready" bounds="[10,20][210,80]" />';
  assert.deepEqual(targetBounds(xml, ['Permission center']), [110, 50]);
  assert.equal(targetBounds('<node text="Background" bounds="[0,0][100,100]" />', ['Back']), null);
});

test('launcher artwork is valid PNG at every Android density', () => {
  for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const icon = decode(new URL(`../src-tauri/icons/android/mipmap-${density}/${name}.png`, import.meta.url));
      assert.equal(icon.w, size);
      assert.equal(icon.h, size);
      assert.ok(icon.rgba.some((channel, i) => i % 4 === 3 && channel > 0), 'artwork must not be transparent');
    }
  }
});

test('crashes from the app are detected across cold starts, independently of UiAutomation', () => {
  const log = '11-07 18:00:36.676 3344 3357 E AndroidRuntime: FATAL EXCEPTION: UiAutomation\n' +
    '11-07 18:00:40.123 2000 2001 F libc: Fatal signal 6 (SIGABRT)\n' +
    '11-07 18:00:41.123 3000 3000 E AndroidRuntime: FATAL EXCEPTION: main';
  assert.equal(appCrashLines(log, new Set(['4000'])), '');
  const app = appCrashLines(log, new Set(['2000', '3000']));
  assert.match(app, /Fatal signal/);
  assert.match(app, /FATAL EXCEPTION: main/);
  assert.doesNotMatch(app, /UiAutomation/);
});
