// Run against an already booted emulator or USB device. A successful install/build is
// insufficient: require the rendered phone UI, then test navigation and lifecycle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSessionPeer } from './session-server.mjs';

export function targetBounds(xml, labels, className) {
  for (const partial of [false, true]) {
  let labelledField = false;
  for (const node of xml.matchAll(/<node\b[^>]*>/g)) {
    const text = node[0].match(/\btext="([^"]*)"/)?.[1];
    const desc = node[0].match(/\bcontent-desc="([^"]*)"/)?.[1];
    // Android accessibility may merge a button's title and subtitle into one node.
    const matches = (value) => labels.some((label) => value === label || (partial && (value?.startsWith(`${label} `) || value?.startsWith(`${label}\n`))));
    const named = matches(text) || matches(desc);
    const isClass = !className || node[0].includes(`class="${className}"`);
    // WebView 124 exposes a textarea's label as a preceding TextView but omits
    // its labelledBy relation from UIAutomator XML. Select that actual editor.
    if (className && !isClass) {
      if (named && !node[0].includes('bounds="[0,0][0,0]"')) labelledField = true;
      continue;
    }
    const accepted = named || labelledField;
    labelledField = false;
    if (!accepted) continue;
    const bounds = node[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    if (x2 > x1 && y2 > y1) return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
  }
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

export function keyboardVisible(dump) {
  const keyboard = dump.split(/(?=Window #\d+ Window\{)/).find(section =>
    /^Window #\d+ Window\{[^\n]*\bInputMethod\}/.test(section));
  return !!keyboard && /\bmViewVisibility=0x0\b/.test(keyboard) &&
    /\bmHasSurface=true\b/.test(keyboard) && /\bisOnScreen=true\b/.test(keyboard);
}

export function editorFocused(xml, labels) {
  const expected = targetBounds(xml, labels, 'android.widget.EditText');
  if (!expected) return false;
  return [...xml.matchAll(/<node\b[^>]*>/g)].some(([node]) => {
    if (!node.includes('class="android.widget.EditText"') || !node.includes('focused="true"')) return false;
    const value = node.match(/\btext="([^"]*)"/)?.[1] ?? '';
    return JSON.stringify(targetBounds(node, [value], 'android.widget.EditText')) === JSON.stringify(expected);
  });
}

export function scrollDirection(bounds, height, fallback) {
  if (!bounds) return fallback;
  // WebView can expose clipped editors behind the fixed toolbar or navigation bar.
  if (bounds[1] < height * .15) return 'up';
  if (bounds[1] > height * .9) return 'down';
  return null;
}

export function launcherAnrClose(xml) {
  if (!xml.includes('text="Pixel Launcher isn\'t responding"')) return null;
  const button = [...xml.matchAll(/<node\b[^>]*>/g)].find(([node]) =>
    node.includes('package="android"') && node.includes('resource-id="android:id/aerr_close"'));
  return button ? targetBounds(button[0], ['Close app']) : null;
}

export async function smokeAndroid(apk, packageId = 'com.nosugark.realingo.debug') {
  assert.ok(apk, 'usage: node scripts/smoke-android.mjs APK [package-id]');
  const output = process.env.ANDROID_SMOKE_OUTPUT ?? 'android-smoke';
  mkdirSync(output, { recursive: true });
  const adb = (...args) => execFileSync('adb', args.map(String), { encoding: 'utf8', timeout: 30000 });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const component = `${packageId}/com.nosugark.realingo.MainActivity`;
  const peer = await startSessionPeer(8766);
  let lastXml = '';
  let launcherDismissed = false;
  const appPids = new Set();
  const ui = () => {
    const result = adb('shell', 'uiautomator', 'dump', '/sdcard/realingo-smoke.xml');
    // A null root can return exit code 0 and leave the preceding XML on disk.
    // Never navigate using coordinates from that stale page.
    assert.match(result, /dumped to:/, 'UIAutomator must produce a fresh snapshot');
    lastXml = adb('shell', 'cat', '/sdcard/realingo-smoke.xml');
    const closeLauncher = launcherAnrClose(lastXml);
    if (closeLauncher && !launcherDismissed) {
      launcherDismissed = true;
      writeFileSync(join(output, 'launcher-anr.xml'), lastXml);
      screenshot('launcher-anr');
      console.warn('Dismissing the emulator Pixel Launcher ANR once; app failures remain fatal.');
      adb('shell', 'input', 'tap', ...closeLauncher);
      throw new Error('Wait for a fresh app snapshot after closing the launcher dialog');
    }
    return lastXml;
  };
  const waitFor = async (labels) => {
    for (let i = 0; i < 20; i++) {
      // Yield between blocking adb calls so worker replies and UI updates can settle.
      await sleep(100);
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
  const grantProjection = () => tap(['Start', '开始', 'Start now', '立即开始', 'Start recording', '开始录制', 'Start sharing', '开始共享', 'Share screen', '共享屏幕']);
  const overlay = async (accept = () => true, retryGesture) => {
    for (let i = 0; i < 30; i++) {
      const frame = overlayFrame(adb('shell', 'dumpsys', 'window', 'windows'));
      if (frame && accept(frame)) return frame;
      // The launcher transition can consume an injected gesture while the
      // overlay's surface is already visible. Reacquire its frame before retrying.
      if (frame && retryGesture && i % 8 === 7) retryGesture(frame);
      await sleep(250);
    }
    throw new Error('native subtitle overlay did not acquire a visible surface');
  };
  const scrollTo = async (labels, className, direction = 'down') => {
    const size = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)/);
    const width = Number(size?.[1] ?? 1080), height = Number(size?.[2] ?? 1920);
    for (let i = 0; i < 8; i++) {
      let snapshot;
      try { snapshot = ui(); } catch { await sleep(500); continue; }
      const bounds = targetBounds(snapshot, labels, className);
      const move = scrollDirection(bounds, height, direction);
      if (!move) return bounds;
      adb('shell', 'input', 'swipe', Math.round(width / 2), Math.round(height * (move === 'down' ? .78 : .35)), Math.round(width / 2), Math.round(height * (move === 'down' ? .35 : .78)), 350);
      await sleep(400);
    }
    throw new Error(`Could not scroll to ${labels.join(' / ')}`);
  };
  const screenshot = (name) => writeFileSync(join(output, `${name}.png`),
    execFileSync('adb', ['exec-out', 'screencap', '-p'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }));
  const hideKeyboard = async () => {
    if (keyboardVisible(adb('shell', 'dumpsys', 'window', 'windows'))) {
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      await sleep(400);
    }
  };
  const fill = async (labels, text, direction = 'down', replace = false) => {
    let focused = false;
    for (let i = 0; i < 4; i++) {
      adb('shell', 'input', 'tap', ...await scrollTo(labels, 'android.widget.EditText', direction));
      await sleep(500);
      try { focused = editorFocused(ui(), labels); } catch { continue; }
      if (focused) break;
    }
    assert.ok(focused, `editor did not gain focus: ${labels.join(' / ')}`);
    if (replace) {
      adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
      adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
    }
    adb('shell', 'input', 'text', text);
    await hideKeyboard();
  };
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
    adb('reverse', 'tcp:8766', 'tcp:8766');
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
    await tap(['Audio source', '音频来源']);
    await tap(['System audio', '系统声音']);
    await tap(['Test system audio', '测试系统声音']);
    await tap(['Cancel', '取消']);
    await waitFor(['Test system audio', '测试系统声音']);
    await tap(['Test system audio', '测试系统声音']);
    await grantProjection();
    await waitFor(['System audio ready: audio received', '系统声音可用，已读取到音频']);
    screenshot('system-audio-capture');
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
    await sleep(1500);
    const [x1, y1, x2, y2] = await overlay();
    const density = Number(adb('shell', 'wm', 'density').match(/(?:Override|Physical) density: (\d+)/)?.[1] ?? 420) / 160;
    const ox = Math.round(x1 + 60 * density), oy = Math.round(y1 + 24 * density);
    adb('shell', 'input', 'swipe', ox, oy, ox, Math.max(100, oy - 150), 500);
    const moved = await overlay(frame => frame[1] <= y1 - 100, frame => {
      const x = Math.round(frame[0] + 60 * density), y = Math.round(frame[1] + 24 * density);
      adb('shell', 'input', 'swipe', x, y, x, Math.max(100, y - 150), 500);
    });
    assert.ok(moved[1] < y1, 'the native title bar moves the overlay');
    const gx = Math.round(moved[2] - 30 * density), gy = Math.round(moved[3] - 20 * density);
    adb('shell', 'input', 'swipe', gx, gy, gx - 120, gy, 500);
    const resized = await overlay(frame => frame[2] - frame[0] <= x2 - x1 - 80, frame => {
      const x = Math.round(frame[2] - 30 * density), y = Math.round(frame[3] - 20 * density);
      adb('shell', 'input', 'swipe', x, y, x - 120, y, 500);
    });
    assert.ok(resized[2] - resized[0] < x2 - x1, 'the native resize handle changes the width');
    screenshot('floating-on-home');
    adb('shell', 'input', 'tap', Math.round(resized[2] - 32 * density), Math.round(resized[1] + 24 * density));
    await sleep(500);
    assert.equal(overlayFrame(adb('shell', 'dumpsys', 'window', 'windows')), null, 'the native close button removes the surface');
    adb('shell', 'am', 'start', '-W', '-n', component);
    await tap(['Close', '关闭']);
    await tap(['Settings', '设置']);
    await fill(['Hotwords', '热词'], 'AI=Artificial%sIntelligence');
    await waitFor(['AI=Artificial Intelligence']);
    assert.match(lastXml, /AI=Artificial Intelligence/, 'phone hotwords remain editable');
    screenshot('hotwords-settings');
    await tap(['Back', '返回']);
    // The capture probes alone do not prove translation works. Exercise the real
    // APK command, PCM uplink, server-event rendering and Stop against a local peer.
    await tap(['Audio source', '音频来源']);
    await tap(['Microphone', '麦克风']);
    await tap(['Close', '关闭']);
    await tap(['Settings', '设置']);
    await fill(['API Key'], 'android-ci-key', 'up');
    await tap(['Advanced', '高级']); // region / workspace / URL sit in a collapsed group
    await fill(['Custom URL', '自定义地址'], peer.url);
    screenshot('session-settings');
    await tap(['Back', '返回']);
    await waitFor(['Start', '开始翻译']);
    assert.doesNotMatch(lastXml, /text="(?:API key not set|未配置 API Key)"/, 'the fake CI API key must be configured before starting capture');
    await tap(['Start', '开始翻译']);
    await waitFor(['Android session verified.']);
    assert.ok((await peer.snapshot()).at(-1).audioBytes > 0, 'the Android microphone reaches the socket');
    screenshot('session-translated');
    await tap(['Stop', '停止']);
    await waitFor(['Start', '开始翻译']);
    assert.equal((await peer.snapshot()).at(-1).finished, true, 'Stop sends the protocol finish frame');
    await tap(['Audio source', '音频来源']);
    await tap(['System audio', '系统声音']);
    await tap(['Close', '关闭']);
    await tap(['Start', '开始翻译']);
    await grantProjection();
    await waitFor(['Android session verified.']);
    assert.ok((await peer.snapshot()).at(-1).audioBytes > 0, 'authorized playback PCM reaches the socket');
    screenshot('system-session-translated');
    await tap(['Stop', '停止']);
    await waitFor(['Start', '开始翻译']);
    await tap(['Audio source', '音频来源']);
    await tap(['Microphone', '麦克风']);
    await tap(['Close', '关闭']);
    await peer.setMode('stall');
    await tap(['Start', '开始翻译']);
    await waitFor(['Connecting…', '连接中…']);
    // UIAutomator dumps can each take several seconds. Reuse this connecting
    // snapshot so another dump cannot consume the app's 10-second setup deadline.
    const cancelBounds = targetBounds(lastXml, ['Stop', '停止']);
    assert.ok(cancelBounds, 'a connecting session exposes Stop');
    assert.doesNotMatch(lastXml, /text="Listening…"/, 'pending setup must not masquerade as listening');
    for (let i = 0; i < 50; i++) {
      const session = (await peer.snapshot()).at(-1);
      if (session?.mode === 'stall' && session.updates === 1) break;
      await sleep(100);
    }
    assert.equal((await peer.snapshot()).at(-1)?.mode, 'stall');
    assert.equal((await peer.snapshot()).at(-1)?.updates, 1, 'cancel is tested after the server receives setup');
    adb('shell', 'input', 'tap', ...cancelBounds);
    await waitFor(['Start', '开始翻译']);
    screenshot('session-cancelled');
    await peer.setMode('reject');
    await tap(['Start', '开始翻译']);
    await waitFor(['Start', '开始翻译']);
    // Older WebViews omit live-region text from UIAutomator even while rendering
    // it. Verify the persistent error through the user-facing diagnostics sheet.
    await tap(['Settings', '设置']);
    await scrollTo(['Session diagnostics', '会话诊断']);
    await tap(['Session diagnostics', '会话诊断']);
    await waitFor(['CI setup rejection']);
    screenshot('session-error');
    await tap(['Close', '关闭']);
    await tap(['Back', '返回']);
    await peer.setMode('linger');
    await tap(['Start', '开始翻译']);
    await waitFor(['Android session verified.']);
    await tap(['Stop', '停止']);
    await waitFor(['Start', '开始翻译']);
    assert.equal((await peer.snapshot()).at(-1).finished, true);
    screenshot('session-stop-deadline');
    // Plain ws:// cannot exercise Android's rustls provider. Dial the same local
    // HTTP peer via wss://: it must report a TLS protocol error, never panic and
    // leave the phone connecting forever. No trust checks are bypassed.
    await tap(['Settings', '设置']);
    await fill(['Custom URL', '自定义地址'], peer.url.replace('ws:', 'wss:'), 'up', true);
    await tap(['Back', '返回']);
    await tap(['Start', '开始翻译']);
    await waitFor(['Start', '开始翻译']);
    await tap(['Settings', '设置']);
    await scrollTo(['Session diagnostics', '会话诊断']);
    await tap(['Session diagnostics', '会话诊断']);
    await waitFor(['connect failed:']);
    assert.doesNotMatch(lastXml, /connection task panicked/);
    screenshot('session-tls-error');
    await tap(['Close', '关闭']);
    await tap(['Back', '返回']);
    adb('shell', 'pm', 'revoke', packageId, 'android.permission.RECORD_AUDIO');
    adb('shell', 'am', 'start', '-W', '-n', component);
    await waitFor(['Start', '开始翻译']);
    const crashes = adb('logcat', '-v', 'threadtime', '-b', 'crash', '-d');
    assert.doesNotMatch(appCrashLines(crashes, appPids), /FATAL EXCEPTION|Fatal signal|Abort message/);
    console.log('Android smoke passed: launches, navigation, microphone capture, native floating subtitles on Home, system capture consent/cancellation, permission revocation');
  } finally {
    writeFileSync(join(output, 'session-peer.json'), JSON.stringify(await peer.snapshot(), null, 2));
    await peer.close();
    try { adb('reverse', '--remove', 'tcp:8766'); } catch {}
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
