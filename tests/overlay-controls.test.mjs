import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const kotlin = readFileSync(new URL('../src-tauri/android/SubtitleService.kt', import.meta.url), 'utf8');

test('closing a running overlay updates the notification before checking whether to stop', () => {
  // This listener body uses statements shared by Kotlin and JS; run it, not a copy.
  const close = kotlin.match(/close.setOnClickListener \{([^}]+)\}/)[1];
  const calls = [];
  const state = { visible: true, notificationVisible: true,
    render: () => calls.push('render'),
    refreshForeground: () => { state.notificationVisible = state.visible; calls.push('notification'); },
    stopIfIdle: () => calls.push('idle'),
  };
  runInNewContext(close, state);
  assert.equal(state.visible, false);
  assert.equal(state.notificationVisible, false, 'notification must now offer Sub on');
  assert.deepEqual(calls, ['render', 'notification', 'idle']);
});

test('text refreshes preserve native lock authority; only an explicit lock command changes it', () => {
  const update = kotlin.match(/fun update\(json: String\) \{([\s\S]*?)\n        \}/)[1];
  assert.match(update, /next.put\("locked", data.optBoolean\("locked"\)\)/);
  assert.match(kotlin, /fun setLocked\(locked: Boolean\)/);
});
