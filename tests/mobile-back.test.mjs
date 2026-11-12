import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const vue = readFileSync(new URL('../src/mobile/MobileApp.vue', import.meta.url), 'utf8');
const kotlin = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8');
// Run the real Vue handler and the exact JS dispatched by the native callback.
const handler = vue.match(/function onAndroidBack\(event: Event\) \{[\s\S]*?^\}/m)[0];
const dispatch = kotlin.match(/"(window\.dispatchEvent\(new Event\('realingo:back'[^\n]+)"/)[1];
const compiled = ts.transpile(handler);

function screen(page, drawer = null, guideOpen = false, mode = 'normal') {
  const state = Object.fromEntries(Object.entries({ page, drawer, guideOpen, mode })
    .map(([key, value]) => [key, { value }]));
  const window = new EventTarget();
  const onBack = runInNewContext(`${compiled}; onAndroidBack`, state);
  window.addEventListener('realingo:back', onBack);
  return { state, back: () => runInNewContext(dispatch, { window, Event }) };
}

test('back closes one layer at a time before navigating and finally allows system exit', () => {
  for (const page of ['history', 'perms']) {
    const view = screen(page, 'overlay', true);
    assert.equal(view.back(), false);
    assert.equal(view.state.guideOpen.value, false);
    assert.equal(view.state.drawer.value, 'overlay');
    assert.equal(view.state.page.value, page);
    assert.equal(view.back(), false);
    assert.equal(view.state.drawer.value, null);
    assert.equal(view.state.page.value, page);
    assert.equal(view.back(), false);
    assert.equal(view.state.page.value, 'settings');
    assert.equal(view.back(), false);
    assert.equal(view.state.page.value, 'home');
    assert.equal(view.back(), true);
  }
});

test('home sheets and full-screen subtitles consume back before the system does', () => {
  for (const drawer of ['src', 'lang', 'speak', 'model', 'about', 'uilang', 'overlay', 'diagnostics']) {
    const view = screen('home', drawer, false, 'big');
    assert.equal(view.back(), false);
    assert.equal(view.state.drawer.value, null);
    assert.equal(view.state.mode.value, 'big');
    assert.equal(view.back(), false);
    assert.equal(view.state.mode.value, 'normal');
    assert.equal(view.back(), true);
  }
});

test('back listener is removed on unmount; native fallback cannot call itself', () => {
  assert.match(vue, /window.addEventListener\("realingo:back", onAndroidBack\)/);
  assert.match(vue, /window.removeEventListener\("realingo:back", onAndroidBack\)/);
  assert.match(kotlin, /onBackPressedDispatcher.addCallback\(this, object : OnBackPressedCallback\(true\)/);
  assert.match(kotlin, /isEnabled = false\s+try \{\s+onBackPressedDispatcher.onBackPressed\(\)\s+\} finally \{\s+isEnabled = true/);
});

test('unhandled home back backgrounds the root task without destroying its native runtime', () => {
  // The result branch uses syntax common to Kotlin and JS, so execute the real branch.
  const fallback = kotlin.match(/if \(result != "false"\) \{[\s\S]*?^ {20}\}/m)[0];
  for (const isTaskRoot of [true, false]) {
    const calls = [];
    const state = { result: 'true', isTaskRoot, isEnabled: true,
      moveTaskToBack: value => { calls.push(['background', value]); return true; },
      onBackPressedDispatcher: { onBackPressed: () => calls.push(['default']) },
    };
    runInNewContext(fallback, state);
    assert.deepEqual(calls, isTaskRoot ? [['background', true]] : [['default']]);
    assert.equal(state.isEnabled, true);
    calls.length = 0;
    state.result = 'false';
    runInNewContext(fallback, state);
    assert.deepEqual(calls, [], 'a handled sheet/page back must never background the app');
  }
});
