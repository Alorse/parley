import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// public/audio-capture.js drives browser-only APIs (getUserMedia,
// AudioContext, AudioWorkletNode). Minimal fakes are enough to check the
// lifecycle rules of #18: one pipeline at a time, and off really means off.

class FakeTrack {
  constructor() {
    this.readyState = 'live';
  }
  stop() {
    this.readyState = 'ended';
  }
}

const opened = { streams: [], contexts: [] };
let pendingMic = [];
let failWorklet = false;

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.closed = false;
    this.audioWorklet = {
      addModule: async () => {
        if (failWorklet) throw new Error('no worklet');
      },
    };
    opened.contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return { fftSize: 0, frequencyBinCount: 4, getByteTimeDomainData() {} };
  }
  close() {
    this.closed = true;
  }
}

class FakeWorkletNode {
  constructor() {
    this.port = { onmessage: null };
  }
  disconnect() {}
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia() {
        const d = defer();
        pendingMic.push(d);
        return d.promise.then(() => {
          const stream = { tracks: [new FakeTrack()], getTracks() { return this.tracks; } };
          opened.streams.push(stream);
          return stream;
        });
      },
    },
  },
});
globalThis.window = /** @type {any} */ ({ AudioContext: FakeAudioContext });
globalThis.AudioWorkletNode = /** @type {any} */ (FakeWorkletNode);

const { AudioCapture } = await import('../public/audio-capture.js');

const liveTracks = () => opened.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;
const grantMic = () => pendingMic.splice(0).forEach((d) => d.resolve());

beforeEach(() => {
  opened.streams = [];
  opened.contexts = [];
  pendingMic = [];
});

test('#18 a second start while the mic is opening joins it instead of opening a second mic', async () => {
  const cap = new AudioCapture();
  const a = cap.start(() => {});
  const b = cap.start(() => {});
  assert.equal(pendingMic.length, 1, 'getUserMedia was asked twice');
  grantMic();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(await cap.start(() => {}), true, 'a start on an open mic reuses it');
  assert.equal(opened.streams.length, 1);
  assert.equal(liveTracks(), 1);
  cap.stop();
  assert.equal(liveTracks(), 0);
});

test('#18 a stop while the mic is still opening releases it once it opens', async () => {
  const cap = new AudioCapture();
  const starting = cap.start(() => {});
  cap.stop();
  grantMic();
  assert.equal(await starting, false, 'start reports the mic did not stay open');
  assert.equal(liveTracks(), 0, 'the late-arriving mic track was left recording');
  assert.equal(cap.stream, null);
});

test('#18 a start after a cancelled one opens exactly one new mic', async () => {
  const cap = new AudioCapture();
  const first = cap.start(() => {});
  cap.stop();
  const second = cap.start(() => {});
  grantMic();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(liveTracks(), 1);
  cap.stop();
  assert.equal(liveTracks(), 0);
  assert.ok(opened.contexts.every((c) => c.closed), 'every AudioContext is closed');
});

test('#18 a failed open releases what it had acquired', async () => {
  failWorklet = true;
  try {
    const cap = new AudioCapture();
    const starting = cap.start(() => {});
    grantMic();
    await assert.rejects(starting, /no worklet/);
    assert.equal(liveTracks(), 0, 'the mic track was left recording after a failed open');
    assert.ok(opened.contexts[0].closed);
    failWorklet = false;
    assert.equal(await startGranted(cap), true, 'the next start opens a fresh mic');
    cap.stop();
  } finally {
    failWorklet = false;
  }
});

function startGranted(cap) {
  const p = cap.start(() => {});
  grantMic();
  return p;
}
