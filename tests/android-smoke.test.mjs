import assert from 'node:assert/strict';
import test from 'node:test';
import { targetBounds, appCrashLines, overlayFrame, overlayLocked, liveNotification, keyboardVisible, dismissKeyboard, editorFocused, scrollDirection, launcherAnrClose } from '../scripts/smoke-android.mjs';
import { decode } from '../scripts/png.mjs';

test('output picker taps the clickable accessible label even when the selected value is absent', () => {
  // API 35 WebView exposes the aria-label, not the selected option, in UIAutomator.
  const xml = '<node text="Play through" class="android.widget.TextView" clickable="false" bounds="[91,900][456,950]" />' +
    '<node text="Play through" class="android.view.View" clickable="true" bounds="[485,879][968,971]" />';
  assert.equal(targetBounds(xml, ['Follow system']), null);
  assert.deepEqual(targetBounds(xml, ['Play through', '播放到']), [727, 925]);
});

test('output picker finds the actual view when WebView exposes its value instead of its label', () => {
  const xml = '<node text="Play through" class="android.widget.TextView" clickable="false" bounds="[91,900][456,950]" />' +
    '<node text="Follow system" class="android.view.View" clickable="true" bounds="[485,879][968,971]" />';
  assert.deepEqual(targetBounds(xml, ['Play through', '播放到'], 'android.view.View'), [727, 925]);
  assert.deepEqual(targetBounds(xml.replace('text="Follow system"', 'text="Play through"'), ['Play through', '播放到'], 'android.view.View'), [727, 925]);
});

test('an explicitly unnamed editor selector requires exactly one visible field', () => {
  // API 35 omits the history search aria-label and placeholder from its XML.
  const field = '<node NAF="true" text="" class="android.widget.EditText" focused="true" bounds="[147,391][1008,488]" />';
  assert.deepEqual(targetBounds(field, [], 'android.widget.EditText'), [578, 440]);
  assert.equal(editorFocused(field, []), true);
  assert.equal(targetBounds(field + field, [], 'android.widget.EditText'), null);
  assert.equal(targetBounds(field.replace('[147,391][1008,488]', '[0,0][0,0]'), [], 'android.widget.EditText'), null);
  assert.equal(targetBounds(field, ['Search this session…'], 'android.widget.EditText'), null);
});

test('keyboard dismissal waits through delayed opening and closing before scrolling', async () => {
  const visible = 'Window #7 Window{e9d9f26 u0 InputMethod}:\n mViewVisibility=0x0 mHasSurface=true isOnScreen=true\n';
  const states = ['', '', visible, visible, '', '', ''];
  let reads = 0, backs = 0;
  await dismissKeyboard(() => states[reads++] ?? '', () => { backs++; }, async () => {});
  assert.equal(backs, 1, 'Back is sent once; a closing keyboard must not navigate the page');
  assert.equal(reads, states.length, 'wait for stable hidden snapshots');
  await assert.rejects(dismissKeyboard(() => visible, () => {}, async () => {}), /keyboard did not close/);
});

test('only the emulator launcher ANR can be dismissed; app ANRs remain failures', () => {
  const xml = '<node text="Pixel Launcher isn\'t responding" />' +
    '<node text="Close app" package="android" resource-id="android:id/aerr_close" bounds="[70,898][1010,1024]" />';
  assert.deepEqual(launcherAnrClose(xml), [540, 961]);
  assert.equal(launcherAnrClose(xml.replace('Pixel Launcher', 'ReaLingo')), null);
  assert.equal(launcherAnrClose(xml.replace('android:id/aerr_close', 'android:id/aerr_wait')), null);
  assert.equal(launcherAnrClose(xml.replace('package="android"', 'package="com.nosugark.realingo"')), null);
});

test('native overlay checks select its own surfaced window and support Android frame formats', () => {
  const dump = 'Window #0 Window{a u0 Other}:\n mHasSurface=true mFrame=[0,0][1080,1920]\n' +
    'Window #1 Window{b u0 ReaLingo subtitles}:\n mHasSurface=true\n Frames: parent=[0,0][1080,1920] frame=[64,1200][1016,1600]\n';
  assert.deepEqual(overlayFrame(dump), [64, 1200, 1016, 1600]);
  assert.deepEqual(overlayFrame(dump.replace('frame=[64', 'mFrame=[64')), [64, 1200, 1016, 1600]);
  assert.equal(overlayFrame(dump.replaceAll('mHasSurface=true', 'mHasSurface=false')), null);
  assert.equal(overlayFrame('Window #0 Window{a u0 Other}: mHasSurface=true mFrame=[0,0][1080,1920]'), null);
});

test('lock assertions inspect the surfaced overlay flags rather than another window', () => {
  const dump = 'Window #0 Window{a u0 Other}:\n mHasSurface=true NOT_TOUCHABLE\n' +
    'Window #1 Window{b u0 ReaLingo subtitles}:\n mHasSurface=true\n fl=NOT_FOCUSABLE NOT_TOUCHABLE\n';
  assert.equal(overlayLocked(dump), true);
  assert.equal(overlayLocked(dump.replace('fl=NOT_FOCUSABLE NOT_TOUCHABLE', 'fl=NOT_FOCUSABLE')), false);
  assert.equal(overlayLocked(dump.replaceAll('mHasSurface=true', 'mHasSurface=false')), false);
});

test('notification assertions select this app live service notification', () => {
  const other = 'NotificationRecord(a: pkg=com.other user=UserHandle{0} id=73)\n actions={ "Sub off" }\n';
  const own = 'NotificationRecord(b: pkg=com.nosugark.realingo user=UserHandle{0} id=73)\n actions={ "Sub on" }\n';
  const extra = 'NotificationRecord(c: pkg=com.nosugark.realingo user=UserHandle{0} id=74)\n';
  assert.equal(liveNotification(other + own + extra, 'com.nosugark.realingo'), own);
  assert.equal(liveNotification(other, 'com.nosugark.realingo'), '');
});

test('keyboard dismissal requires the current visible IME window, not stale input-method history', () => {
  const visible = 'Window #0 Window{a u0 Other}:\n mHasSurface=true isOnScreen=true\n' +
    'Window #1 Window{b u0 InputMethod}:\n mViewVisibility=0x0\n mHasSurface=true\n isOnScreen=true\n';
  assert.equal(keyboardVisible(visible), true);
  assert.equal(keyboardVisible(visible.replace('mViewVisibility=0x0', 'mViewVisibility=0x8')), false);
  assert.equal(keyboardVisible(visible.replaceAll('isOnScreen=true', 'isOnScreen=false')), false);
  assert.equal(keyboardVisible(visible.replaceAll('mHasSurface=true', 'mHasSurface=false')), false);
  assert.equal(keyboardVisible('mInputShown=true isInputViewShown=true'), false);
});

test('typing waits for the requested editor rather than a different focused field', () => {
  const xml = '<node text="API Key" class="android.widget.TextView" bounds="[0,20][100,60]" />' +
    '<node text="" class="android.widget.EditText" focused="true" bounds="[0,60][200,120]" />' +
    '<node text="Custom URL" class="android.widget.TextView" bounds="[0,140][100,180]" />' +
    '<node text="" class="android.widget.EditText" focused="false" bounds="[0,180][200,240]" />';
  assert.equal(editorFocused(xml, ['API Key']), true);
  assert.equal(editorFocused(xml, ['Custom URL']), false);
  assert.equal(editorFocused(xml.replaceAll('focused="true"', 'focused="false"'), ['API Key']), false);
});

test('clipped fields behind the fixed toolbar are scrolled into the usable viewport before tapping', () => {
  assert.equal(scrollDirection([529, 78], 1920, 'down'), 'up');
  assert.equal(scrollDirection([529, 900], 1920, 'down'), null);
  assert.equal(scrollDirection([529, 1850], 1920, 'up'), 'down');
  assert.equal(scrollDirection(null, 1920, 'up'), 'up');
});

test('UI navigation locates visible English and Chinese controls by text or accessibility label', () => {
  const xml = '<hierarchy><node text="" content-desc="Settings" bounds="[20,30][60,70]" />' +
    '<node text="权限中心" content-desc="" bounds="[10,100][210,140]" /></hierarchy>';
  assert.deepEqual(targetBounds(xml, ['Settings', '设置']), [40, 50]);
  assert.deepEqual(targetBounds(xml, ['Permission center', '权限中心']), [110, 120]);
  assert.equal(targetBounds(xml, ['Missing']), null);
  assert.deepEqual(targetBounds('<node text="Start recording or casting with ReaLingo?" bounds="[0,100][900,250]" />' +
    '<node text="Start" bounds="[700,1200][1000,1300]" />', ['Start']), [850, 1250]);
  assert.deepEqual(targetBounds('<node text="Share your screen with ReaLingo?" bounds="[0,100][900,250]" />' +
    '<node text="Share screen" bounds="[700,1200][1000,1300]" />', ['Share screen']), [850, 1250]);
  assert.deepEqual(targetBounds('<node text="Hotwords" class="android.widget.TextView" bounds="[0,0][80,30]" />' +
    '<node text="" content-desc="" class="android.widget.EditText" bounds="[0,40][200,140]" />',
    ['Hotwords'], 'android.widget.EditText'), [100, 90]);
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
