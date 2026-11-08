// Local CI peer for the real APK's WebSocket path. No API keys or remote service calls.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

function frame(opcode, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = bytes.length < 126 ? bytes.length : 126;
  if (bytes.length >= 126) header.writeUInt16BE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
}

// UIAutomator uses blocking adb calls. Keep the simulated remote server on its
// own event loop so those calls cannot create fake network/setup timeouts.
export async function startSessionPeer(port = 0) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { port } });
  const pending = new Map();
  let serial = 0;
  let failure;
  const fail = error => { failure = error; for (const call of pending.values()) call.reject(error); pending.clear(); };
  worker.on('error', fail);
  worker.on('exit', code => fail(new Error(`CI session peer exited (${code})`)));
  worker.on('message', ({ id, value, error }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (error) call.reject(new Error(error)); else call.resolve(value);
  });
  const call = (action, value) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++serial;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, value });
  });
  const url = await call('ready');
  return { url, setMode: value => call('mode', value), snapshot: () => call('snapshot'),
    close: async () => { await call('close'); await worker.terminate(); } };
}

if (!isMainThread) {
  const peer = await startSessionServer(workerData.port);
  parentPort.on('message', async ({ id, action, value }) => {
    try {
      let result;
      if (action === 'ready') result = peer.url;
      else if (action === 'mode') peer.setMode(value);
      else if (action === 'snapshot') result = peer.snapshot();
      else if (action === 'close') await peer.close();
      else throw new Error('invalid CI peer operation');
      parentPort.postMessage({ id, value: result });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}

export async function startSessionServer(port = 0) {
  const sockets = new Set();
  const sessions = [];
  let mode = 'normal';
  const server = createServer((_req, res) => { res.end('ReaLingo CI session peer'); });
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket);
    const state = { mode, updates: 0, audioBytes: 0, finished: false, error: '' };
    sessions.push(state);
    let pending = Buffer.alloc(0), translated = false, heartbeat;
    const send = value => socket.write(frame(1, JSON.stringify(value)));
    send({ type: 'session.created' });
    function message(value) {
      if (value.type === 'session.update') {
        state.updates++;
        if (state.mode === 'reject') send({ type: 'error', error: { message: 'CI setup rejection' } });
        else if (state.mode !== 'stall') send({ type: 'session.updated' });
      } else if (value.type === 'input_audio_buffer.append') {
        state.audioBytes += Buffer.from(value.audio, 'base64').length;
        if (!translated) {
          translated = true;
          send({ type: 'conversation.item.created', item: { id: 'ci-answer', type: 'message', role: 'assistant' }, previous_item_id: 'ci-input' });
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ci-input', transcript: '安卓语音链路测试', language: 'zh' });
          send({ type: 'response.text.done', item_id: 'ci-answer', text: 'Android session verified.' });
        }
      } else if (value.type === 'session.finish') {
        state.finished = true;
        if (state.mode === 'linger') heartbeat = setInterval(() => { if (!socket.destroyed) socket.write(frame(9, '')); }, 100);
        else send({ type: 'session.finished' });
      }
    }
    function consume(chunk) {
      pending = Buffer.concat([pending, chunk]);
      try {
        for (;;) {
          if (pending.length < 2) return;
          const opcode = pending[0] & 15;
          if (!(pending[0] & 128) || (pending[0] & 112) || !(pending[1] & 128)) throw new Error('unsupported client frame');
          let length = pending[1] & 127, offset = 2;
          if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
          else if (length === 127) {
            if (pending.length < 10) return;
            const large = pending.readBigUInt64BE(2);
            if (large > 1_048_576n) throw new Error('client frame exceeds CI limit');
            length = Number(large); offset = 10;
          }
          if (length > 1_048_576) throw new Error('client frame exceeds CI limit');
          if (pending.length < offset + 4 + length) return;
          const mask = pending.subarray(offset, offset + 4);
          const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          pending = pending.subarray(offset + 4 + length);
          if (opcode === 1) message(JSON.parse(payload.toString()));
          else if (opcode === 8) { socket.end(frame(8, payload)); return; }
          else if (opcode === 9) socket.write(frame(10, payload));
          else if (opcode !== 10) throw new Error('unexpected opcode');
        }
      } catch (error) { state.error = error.message; socket.destroy(); }
    }
    socket.on('data', consume);
    socket.on('error', error => { state.error = error.message; });
    socket.on('close', () => { clearInterval(heartbeat); sockets.delete(socket); });
    if (head.length) consume(head);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `ws://127.0.0.1:${server.address().port}/`,
    setMode(value) { if (!['normal', 'stall', 'reject', 'linger'].includes(value)) throw new Error('invalid CI scenario'); mode = value; },
    snapshot: () => structuredClone(sessions),
    close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); },
  };
}
