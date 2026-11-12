import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { readFileSync } from 'node:fs';
import { vueScript } from './helpers/vue-script.mjs';

test('the subtitle switch reflects native visibility and keeps permission requests unchecked', async () => {
  const native = { granted: false, visible: false };
  const settings = { sub: { show: true, mode: 'both', srcSize: 19, tgtSize: 30, opacity: .5, mobileWidth: 88, align: 'center' } };
  const state = vueScript(new URL('../src/mobile/OverlaySheet.vue', import.meta.url), {
    native, settings, t: key => key, defineEmits: () => {}, resetOverlayPosition: () => {},
  }, ['MODES', 'ALIGNS', 'SWITCHES', 'native', 'settings', 't', 'resetOverlayPosition']);
  const template = readFileSync(new URL('../src/mobile/OverlaySheet.vue', import.meta.url), 'utf8').match(/<template>([\s\S]*?)<\/template>/)[1];
  const Sheet = { setup: (_, { slots }) => () => h('div', slots.default?.()) };
  const render = () => renderToString(createSSRApp({ components: { Sheet }, setup: () => state, render: compile(template) }));
  let html = await render();
  assert.match(html, /class="m-master" role="switch" aria-checked="false"/);
  assert.match(html, /overlayAuthorize/);
  assert.doesNotMatch(html, /fullscreenSub/);
  native.granted = true; native.visible = true;
  html = await render();
  assert.match(html, /class="m-master on" role="switch" aria-checked="true"/);
  assert.match(html, /subShow/);
  native.visible = false;
  html = await render();
  assert.match(html, /aria-checked="false"/);
});
