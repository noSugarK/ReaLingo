import assert from 'node:assert/strict';
import test from 'node:test';
import { ref, computed } from 'vue';
import { vueScript } from './helpers/vue-script.mjs';

test('mobile history loads, searches, exports and confirms deletion of the selected session', async () => {
  const sessions = [{ id: 'old', meta: null, count: 1 }, { id: 'new', meta: null, count: 2 }];
  const rows = { old: [{ source: 'Hello', target: '你好' }], new: [{ source: 'World', target: '世界' }, { source: 'Other', target: '其他' }] };
  const calls = [], exports = [];
  const history = vueScript(new URL('../src/shared/History.vue', import.meta.url), {
    ref, computed, onMounted: () => {}, defineProps: () => ({ mobile: true }), defineEmits: () => {},
    settings: { history: true }, caps: ref({}), locale: ref('en'), t: key => key, langName: key => key,
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'history_list') return [...sessions];
      if (cmd === 'history_read') return rows[args.id];
      if (cmd === 'history_delete') sessions.splice(sessions.findIndex(session => session.id === args.id), 1);
      if (cmd === 'history_clear') sessions.length = 0;
    },
    saveAs: async (...args) => exports.push(args),
  }, ['load', 'open', 'q', 'shown', 'saveRows', 'remove', 'clearAll', 'openId', 'sessions']);
  await history.load();
  assert.equal(history.openId.value, 'old');
  await history.open('new');
  history.q.value = ' 世界 ';
  assert.equal(history.shown.value.length, 1);
  await history.saveRows('srt');
  assert.deepEqual(exports[0], ['srt', [{ id: 0, source: 'World', target: '世界' }], 'new']);
  await history.remove('new');
  assert.equal(calls.some(([cmd]) => cmd === 'history_delete'), false);
  await history.remove('new');
  assert.equal(history.openId.value, 'old');
  await history.clearAll();
  assert.equal(history.sessions.value.length, 1);
  await history.clearAll();
  assert.equal(history.sessions.value.length, 0);
  assert.equal(history.openId.value, '');
});

test('history errors remain visible instead of looking like a successful empty load', async () => {
  const history = vueScript(new URL('../src/shared/History.vue', import.meta.url), {
    ref, computed, onMounted: () => {}, defineProps: () => ({ mobile: true }), defineEmits: () => {},
    invoke: async () => { throw new Error('history unavailable'); },
  }, ['load', 'err']);
  await history.load();
  assert.match(history.err.value, /history unavailable/);
});
