import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// public/live-client.js over a fake browser WebSocket: audio travels as
// binary frames both ways (#24), control messages as JSON.

const sockets = [];

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.binaryType = 'blob';
    this.sent = [];
    sockets.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  receive(data) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

globalThis.WebSocket = /** @type {any} */ (FakeWebSocket);
globalThis.location = /** @type {any} */ ({ protocol: 'https:', host: 'parley.test' });

const { LiveClient } = await import('../public/live-client.js');

beforeEach(() => {
  sockets.length = 0;
});

async function connected() {
  const client = new LiveClient();
  const connecting = client.connect({ level: 'B1' });
  sockets[0].open();
  await connecting;
  return { client, ws: sockets[0] };
}

test('#24 the start announces binary audio, and the socket takes binary frames as ArrayBuffers', async () => {
  const { ws } = await connected();
  assert.equal(ws.url, 'wss://parley.test/live');
  assert.equal(ws.binaryType, 'arraybuffer');
  const start = JSON.parse(ws.sent[0]);
  assert.equal(start.type, 'start');
  assert.equal(start.binary, true);
});

test('#24 a mic chunk is sent as the PCM buffer itself', async () => {
  const { client, ws } = await connected();
  const pcm = new Int16Array([1, 2, 3]).buffer;
  client.sendAudio(pcm);
  assert.equal(ws.sent[1], pcm);
});

test('#24 a binary frame from the server is tutor audio; text frames are JSON messages', async () => {
  const { client, ws } = await connected();
  const got = [];
  client.addEventListener('message', (e) => got.push(/** @type {CustomEvent} */ (e).detail));
  const pcm = new Int16Array([4, 5]).buffer;
  ws.receive(pcm);
  ws.receive(JSON.stringify({ type: 'state', value: 'speaking' }));
  ws.receive('not json');
  assert.deepEqual(got, [{ type: 'audio', data: pcm }, { type: 'state', value: 'speaking' }]);
  assert.equal(got[0].data, pcm);
});

test('nothing is sent once the socket is closed', async () => {
  const { client, ws } = await connected();
  ws.readyState = 3;
  client.sendAudio(new ArrayBuffer(4));
  client.sendText('hi');
  assert.equal(ws.sent.length, 1);
});
