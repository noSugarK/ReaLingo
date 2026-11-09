import test from 'node:test';
import assert from 'node:assert/strict';
import { startSessionServer, startSessionPeer } from '../scripts/session-server.mjs';

async function waitUntil(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('local peer did not respond');
}

test('the Android peer runs independently of blocking UI automation and reports its session state', async t => {
  const peer = await startSessionPeer(); t.after(() => peer.close());
  await peer.setMode('normal');
  const messages = [], ws = new WebSocket(peer.url);
  ws.onmessage = event => messages.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ type: 'session.update' }));
  await waitUntil(() => messages.some(value => value.type === 'session.updated'));
  ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(3200).toString('base64') }));
  await waitUntil(() => messages.some(value => value.type === 'response.text.done'));
  const sessions = await peer.snapshot();
  assert.equal(sessions[0].audioBytes, 3200);
  assert.equal(sessions[0].mode, 'normal');
  ws.close();
});

test('the CI peer accepts real masked WebSocket frames and returns captured protocol shapes', async t => {
  const peer = await startSessionServer(); t.after(() => peer.close());
  const messages = [], ws = new WebSocket(peer.url);
  ws.onmessage = event => messages.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ type: 'session.update' }));
  await waitUntil(() => messages.some(value => value.type === 'session.updated'));
  // Cross both the normal and 64-bit-length frame headers used by real clients.
  for (const size of [3200, 70000]) ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(size).toString('base64') }));
  await waitUntil(() => peer.snapshot()[0].audioBytes === 73200);
  assert.ok(messages.some(value => value.type === 'response.text.done' && value.text === 'Android session verified.'));
  ws.send(JSON.stringify({ type: 'session.finish' }));
  await waitUntil(() => messages.some(value => value.type === 'session.finished'));
  ws.close();
  assert.equal(peer.snapshot()[0].error, '');
});

test('the peer can withhold setup acknowledgement or reject setup without sending audio', async t => {
  const peer = await startSessionServer(); t.after(() => peer.close());
  for (const mode of ['stall', 'reject']) {
    peer.setMode(mode);
    const messages = [], ws = new WebSocket(peer.url);
    ws.onmessage = event => messages.push(JSON.parse(event.data));
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ type: 'session.update' }));
    await waitUntil(() => peer.snapshot().at(-1)?.updates === 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(!messages.some(value => value.type === 'session.updated'));
    if (mode === 'reject') assert.equal(messages.find(value => value.type === 'error').error.message, 'CI setup rejection');
    ws.close();
  }
});
