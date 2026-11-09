import assert from 'node:assert/strict';
import test from 'node:test';
import { targetBounds, appCrashLines, overlayFrame, keyboardVisible, editorFocused, scrollDirection, launcherAnrClose } from '../scripts/smoke-android.mjs';
import { decode } from '../scripts/png.mjs';

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
