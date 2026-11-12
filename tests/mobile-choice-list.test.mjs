import assert from 'node:assert/strict';
import test from 'node:test';
import { computed, ref, reactive, compile, createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { readFileSync } from 'node:fs';
import { vueScript } from './helpers/vue-script.mjs';
import { filterOptions } from '../src/core/options.ts';

test('the shared list renders labelled native radios, optional notes and one selection', async () => {
  const template = readFileSync(new URL('../src/mobile/ChoiceList.vue', import.meta.url), 'utf8').match(/<template>([\s\S]*?)<\/template>/)[1];
  const state = { label: 'Voice', group: 'voices', value: 'two', disabled: false,
    options: [{ value: 'one', label: 'One', suffix: 'en' }, { value: 'two', label: 'Two', description: 'Gentle' }] };
  const html = await renderToString(createSSRApp({ setup: () => state, render: compile(template) }));
  assert.match(html, /role="radiogroup" aria-label="Voice"/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.equal((html.match(/ checked/g) ?? []).length, 1);
  assert.match(html, /value="two" checked/);
  assert.match(html, /Gentle/);
  assert.match(html, />en<\/span>/);
});

test('speech keeps voice search and its switch together with a compact output preference', () => {
  const running = ref(false), settings = reactive({ speak: false, voice: 'one', output: '' });
  const devices = ref([{ value: 'device|12', name: 'Buds', kind: 'bluetooth' }]);
  const session = { speakBlocked: ref(''), voiceOptions: ref([
    { value: 'one', label: 'One', note: '温柔', keywords: 'gentle' }, { value: 'two', label: 'Two', keywords: 'male' },
  ]) };
  const speech = vueScript(new URL('../src/mobile/SpeakSheet.vue', import.meta.url), {
    computed, ref, settings, session, filterOptions, isRunning: () => running.value, t: key => key,
    defineEmits: () => {}, selectedOutput: value => value,
    useOutputDevices: () => ({ devices, options: computed(() => [{ value: '', label: 'System' }, ...devices.value]), loading: ref(false), failed: ref(false), refresh: () => {} }),
  }, ['toggle', 'query', 'voiceChoices', 'selected', 'missing']);
  speech.toggle(); assert.equal(settings.speak, true);
  speech.query.value = ' 温柔 '; assert.equal(speech.voiceChoices.value.length, 1);
  speech.selected.value = 'device|12'; assert.equal(settings.output, 'device|12');
  devices.value = []; assert.equal(speech.missing.value, true);
  speech.selected.value = ''; assert.equal(settings.output, '');
  running.value = true; speech.toggle(); assert.equal(settings.speak, true);
});
