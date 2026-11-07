import assert from 'node:assert/strict';
import test from 'node:test';
import { targetBounds } from '../.github/scripts/smoke-android.mjs';
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
