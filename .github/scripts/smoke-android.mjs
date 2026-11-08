// Run against an already booted emulator or USB device. A successful install/build is
// insufficient: require the rendered phone UI, then test navigation and lifecycle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function targetBounds(xml, labels) {
  for (const node of xml.matchAll(/<node\b[^>]*>/g)) {
    const text = node[0].match(/\btext="([^"]*)"/)?.[1];
    const desc = node[0].match(/\bcontent-desc="([^"]*)"/)?.[1];
    // Android accessibility may merge a button's title and subtitle into one node.
    const matches = (value) => labels.some((label) => value === label || value?.startsWith(`${label} `) || value?.startsWith(`${label}\n`));
    if (!matches(text) && !matches(desc)) continue;
    const bounds = node[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    if (x2 > x1 && y2 > y1) return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
  }
  return null;
}

export function appCrashLines(log, pids) {
  // Java FATAL EXCEPTION and libc Fatal signal records carry the crashing process PID.
  // The emulator's UiAutomation helper can crash independently during an early dump.
  const ids = new Set([...pids].map(String));
  return log.split('\n').filter((line) => ids.has(line.match(/^\S+\s+\S+\s+(\d+)\s+\d+\s+[A-Z]\s/)?.[1])).join('\n');
}

export function overlayFrame(dump) {
  const section = dump.split(/(?=Window #\d+ Window\{)/).find((part) =>
    /^Window #\d+ Window\{[^\n]*ReaLingo subtitles/.test(part));
  if (!section || !section.includes('mHasSurface=true')) return null;
  const frame = section.match(/(?:mFrame=|\bframe=)\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!frame) return null;
  const [, x1, y1, x2, y2] = frame.map(Number);
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

export async function smokeAndroid(apk, packageId = 'com.nosugark.realingo.debug') {
  assert.ok(apk, 'usage: node .github/scripts/smoke-android.mjs APK [package-id]');
  const output = process.env.ANDROID_SMOKE_OUTPUT ?? 'android-smoke';
  mkdirSync(output, { recursive: true });
  const adb = (...args) => execFileSync('adb', args.map(String), { encoding: 'utf8', timeout: 30000 });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const component = `${packageId}/com.nosugark.realingo.MainActivity`;
  let lastXml = '';
  const appPids = new Set();
  const ui = () => {
    adb('shell', 'uiautomator', 'dump', '/sdcard/realingo-smoke.xml');
    lastXml = adb('shell', 'cat', '/sdcard/realingo-smoke.xml');
    return lastXml;
  };
  const waitFor = async (labels) => {
    for (let i = 0; i < 20; i++) {
      const pids = adb('shell', 'pidof', packageId).trim();
      assert.ok(pids, 'the app process died');
      for (const pid of pids.split(/\s+/)) appPids.add(pid);
      let xml;
      try { xml = ui(); } catch { await sleep(500); continue; }
      const bounds = targetBounds(xml, labels);
      if (bounds) return bounds;
      await sleep(500);
    }
    throw new Error(`phone UI did not render ${labels.join(' / ')}`);
  };
  const tap = async (labels) => adb('shell', 'input', 'tap', ...await waitFor(labels));
  const overlay = async () => {
    for (let i = 0; i < 30; i++) {
      const frame = overlayFrame(adb('shell', 'dumpsys', 'window', 'windows'));
      if (frame) return frame;
      await sleep(250);
    }
    throw new Error('native subtitle overlay did not acquire a visible surface');
  };
  const scrollTo = async (labels) => {
    const size = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)/);
    const width = Number(size?.[1] ?? 1080), height = Number(size?.[2] ?? 1920);
    for (let i = 0; i < 8; i++) {
      const bounds = targetBounds(ui(), labels);
      if (bounds) return bounds;
      adb('shell', 'input', 'swipe', Math.round(width / 2), Math.round(height * .78), Math.round(width / 2), Math.round(height * .35), 350);
      await sleep(400);
    }
    throw new Error(`Could not scroll to ${labels.join(' / ')}`);
  };
  const screenshot = (name) => writeFileSync(join(output, `${name}.png`),
    execFileSync('adb', ['exec-out', 'screencap', '-p'], { timeout: 30000 }));
  const saveLog = (name, args) => {
    const fd = openSync(join(output, name), 'w');
    try {
      execFileSync('adb', args, { stdio: ['ignore', fd, fd], timeout: 30000 });
    } catch (e) {
      console.error(`Could not collect ${name}: ${e.message}`);
    } finally { closeSync(fd); }
  };
  try {
    adb('wait-for-device');
    adb('install', '-r', apk);
    adb('shell', 'pm', 'clear', packageId);
    // Some old system images cannot clear all buffers. Failure to clear diagnostics
    // must not prevent exercising the app itself.
    try { adb('logcat', '-b', 'crash', '-c'); } catch {}
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
    await waitFor(['MIT', 'License MIT', '许可 MIT']);
    screenshot('about');
    await tap(['Close', '关闭']);
    await tap(['Settings', '设置']);
    await scrollTo(['Permission center', '权限中心']);
    screenshot('settings');
    await tap(['Permission center', '权限中心']);
    await waitFor(['Back', '返回']);
    screenshot('permissions');
    await tap(['Back', '返回']);
    adb('shell', 'input', 'tap', ...await scrollTo(['Hotwords', '热词']));
    adb('shell', 'input', 'text', 'AI=Artificial%sIntelligence');
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(400);
    assert.match(ui(), /AI=Artificial Intelligence/, 'phone hotwords remain editable');
    screenshot('hotwords-settings');
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
    await tap(['Audio source', '音频来源']);
    await tap(['Test microphone', '测试麦克风']);
    await waitFor(['Microphone ready: audio received', '麦克风可用，已读取到音频']);
    screenshot('microphone-capture');
    await tap(['Close', '关闭']);
    await tap(['Subtitle overlay', '字幕窗']);
    await tap(['Authorize overlay', '授权悬浮窗']);
    await sleep(1000);
    assert.match(adb('shell', 'dumpsys', 'activity', 'activities'), /Settings|settings/, 'overlay authorization opens Android settings');
    adb('shell', 'appops', 'set', packageId, 'SYSTEM_ALERT_WINDOW', 'allow');
    adb('shell', 'am', 'start', '-W', '-n', component);
    // Returning from authorization opens the requested overlay automatically.
    // UIAutomator dumps only the focused window; this intentionally non-focusable
    // native overlay is verified through WindowManager and real input instead.
    await overlay();
    screenshot('floating-subtitles');
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    const [x1, y1, x2, y2] = await overlay();
    const density = Number(adb('shell', 'wm', 'density').match(/(?:Override|Physical) density: (\d+)/)?.[1] ?? 420) / 160;
    const ox = Math.round(x1 + 60 * density), oy = Math.round(y1 + 24 * density);
    adb('shell', 'input', 'swipe', ox, oy, ox, Math.max(100, oy - 150), 500);
    const moved = await overlay();
    assert.ok(moved[1] < y1, 'the native title bar moves the overlay');
    const gx = Math.round(moved[2] - 30 * density), gy = Math.round(moved[3] - 20 * density);
    adb('shell', 'input', 'swipe', gx, gy, gx - 120, gy, 500);
    const resized = await overlay();
    assert.ok(resized[2] - resized[0] < x2 - x1, 'the native resize handle changes the width');
    screenshot('floating-on-home');
    adb('shell', 'input', 'tap', Math.round(resized[2] - 32 * density), Math.round(resized[1] + 24 * density));
    await sleep(500);
    assert.equal(overlayFrame(adb('shell', 'dumpsys', 'window', 'windows')), null, 'the native close button removes the surface');
    adb('shell', 'am', 'start', '-W', '-n', component);
    await tap(['Close', '关闭']);
    await tap(['Audio source', '音频来源']);
    await tap(['System audio', '系统声音']);
    await tap(['Test system audio', '测试系统声音']);
    await tap(['Cancel', '取消']);
    await waitFor(['Test system audio', '测试系统声音']);
    await tap(['Test system audio', '测试系统声音']);
    await tap(['Start now', '立即开始', 'Start recording', '开始录制', 'Start sharing', '开始共享']);
    await waitFor(['System audio ready: audio received', '系统声音可用，已读取到音频']);
    screenshot('system-audio-capture');
    await tap(['Close', '关闭']);
    adb('shell', 'pm', 'revoke', packageId, 'android.permission.RECORD_AUDIO');
    adb('shell', 'am', 'start', '-W', '-n', component);
    await waitFor(['Start', '开始翻译']);
    const crashes = adb('logcat', '-v', 'threadtime', '-b', 'crash', '-d');
    assert.doesNotMatch(appCrashLines(crashes, appPids), /FATAL EXCEPTION|Fatal signal|Abort message/);
    console.log('Android smoke passed: launches, navigation, microphone capture, native floating subtitles on Home, system capture consent/cancellation, permission revocation');
  } finally {
    writeFileSync(join(output, 'last-ui.xml'), lastXml);
    // Diagnostics must not exhaust Node's buffered subprocess output or mask the
    // original assertion. Save crash evidence first, then the unbounded full log.
    saveLog('crash.txt', ['logcat', '-b', 'crash', '-d']);
    saveLog('logcat.txt', ['logcat', '-d']);
    saveLog('windows.txt', ['shell', 'dumpsys', 'window', 'windows']);
    try { screenshot('last-screen'); } catch (e) { console.error(e.message); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeAndroid(...process.argv.slice(2));
}
