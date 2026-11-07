// Run against an already booted emulator or USB device. A successful install/build is
// insufficient: require the rendered phone UI, then test navigation and lifecycle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function targetBounds(xml, labels) {
  for (const node of xml.matchAll(/<node\b[^>]*>/g)) {
    const text = node[0].match(/\btext="([^"]*)"/)?.[1];
    const desc = node[0].match(/\bcontent-desc="([^"]*)"/)?.[1];
    if (!labels.includes(text) && !labels.includes(desc)) continue;
    const bounds = node[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    if (x2 > x1 && y2 > y1) return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
  }
  return null;
}

export async function smokeAndroid(apk, packageId = 'com.nosugark.realingo.debug') {
  assert.ok(apk, 'usage: node .github/scripts/smoke-android.mjs APK [package-id]');
  const output = process.env.ANDROID_SMOKE_OUTPUT ?? 'android-smoke';
  mkdirSync(output, { recursive: true });
  const adb = (...args) => execFileSync('adb', args.map(String), { encoding: 'utf8', timeout: 30000 });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const component = `${packageId}/com.nosugark.realingo.MainActivity`;
  let lastXml = '';
  const ui = () => {
    adb('shell', 'uiautomator', 'dump', '/sdcard/realingo-smoke.xml');
    lastXml = adb('shell', 'cat', '/sdcard/realingo-smoke.xml');
    return lastXml;
  };
  const waitFor = async (labels) => {
    for (let i = 0; i < 20; i++) {
      assert.ok(adb('shell', 'pidof', packageId).trim(), 'the app process died');
      const bounds = targetBounds(ui(), labels);
      if (bounds) return bounds;
      await sleep(500);
    }
    throw new Error(`phone UI did not render ${labels.join(' / ')}`);
  };
  const tap = async (labels) => adb('shell', 'input', 'tap', ...await waitFor(labels));
  const screenshot = (name) => writeFileSync(join(output, `${name}.png`),
    execFileSync('adb', ['exec-out', 'screencap', '-p'], { timeout: 30000 }));
  try {
    adb('wait-for-device');
    adb('install', '-r', apk);
    adb('shell', 'pm', 'clear', packageId);
    adb('logcat', '-c');
    for (let launch = 0; launch < 2; launch++) {
      adb('shell', 'am', 'force-stop', packageId);
      assert.doesNotMatch(adb('shell', 'am', 'start', '-W', '-n', component), /Error:|Exception/);
      await waitFor(['Start', '开始翻译']);
      await sleep(3000);
      await waitFor(['Settings', '设置']);
    }
    assert.match(lastXml, /android.webkit.WebView/, 'the native Activity alone is not a rendered app');
    screenshot('home');
    await tap(['About', '关于']);
    await waitFor(['MIT']);
    screenshot('about');
    await tap(['Close', '关闭']);
    await tap(['Settings', '设置']);
    await waitFor(['Permission center', '权限中心']);
    screenshot('settings');
    await tap(['Permission center', '权限中心']);
    await waitFor(['Back', '返回']);
    screenshot('permissions');
    await tap(['Back', '返回']);
    await tap(['Back', '返回']);
    await waitFor(['Start', '开始翻译']);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(1000);
    adb('shell', 'am', 'start', '-W', '-n', component);
    await waitFor(['Start', '开始翻译']);
    // Runtime revocation forces a fresh process. Starting after a grant/revoke must
    // remain possible even though the device list and permission state changed.
    adb('shell', 'pm', 'grant', packageId, 'android.permission.RECORD_AUDIO');
    adb('shell', 'am', 'force-stop', packageId);
    adb('shell', 'am', 'start', '-W', '-n', component);
    await waitFor(['Start', '开始翻译']);
    adb('shell', 'pm', 'revoke', packageId, 'android.permission.RECORD_AUDIO');
    adb('shell', 'am', 'start', '-W', '-n', component);
    await waitFor(['Start', '开始翻译']);
    const crashes = adb('logcat', '-b', 'crash', '-d');
    assert.doesNotMatch(crashes, /FATAL EXCEPTION|Fatal signal|Abort message/);
    console.log('Android smoke passed: cold launches, rendered UI, navigation, resume, microphone grant/revoke');
  } finally {
    writeFileSync(join(output, 'last-ui.xml'), lastXml);
    writeFileSync(join(output, 'logcat.txt'), adb('logcat', '-d'));
    writeFileSync(join(output, 'crash.txt'), adb('logcat', '-b', 'crash', '-d'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeAndroid(...process.argv.slice(2));
}
