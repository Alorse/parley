import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlayer } from '../public/audio-player.js';

// #27: the mic stays closed until Parley's voice has been heard out of the
// speaker. msUntilHeard() is that measure; only the AudioContext clock and
// latency matter, so a plain object stands in for the context.

function playerAt({ currentTime, outputLatency = 0, baseLatency = 0, queuedUntil }) {
  const player = new AudioPlayer();
  player.ctx = /** @type {any} */ ({ currentTime, outputLatency, baseLatency });
  player.nextStartTime = queuedUntil;
  return player;
}

test('msUntilHeard is 0 before anything has played', () => {
  assert.equal(new AudioPlayer().msUntilHeard(250), 0);
});

test("msUntilHeard counts the queued audio, the device's output latency and the tail", () => {
  const player = playerAt({ currentTime: 10, outputLatency: 0.25, queuedUntil: 12 });
  assert.equal(Math.round(player.msUntilHeard()), 2250);
  assert.equal(Math.round(player.msUntilHeard(250)), 2500);
});

test('msUntilHeard falls back to baseLatency where outputLatency is not reported', () => {
  const player = playerAt({ currentTime: 10, baseLatency: 0.01, queuedUntil: 10.5 });
  assert.equal(Math.round(player.msUntilHeard()), 510);
});

test('msUntilHeard reaches 0 once the audio and the tail have been heard', () => {
  const player = playerAt({ currentTime: 13, outputLatency: 0.25, queuedUntil: 12 });
  assert.equal(player.msUntilHeard(250), 0);
});

test('after a flush only the latency and the tail are left', async () => {
  const player = playerAt({ currentTime: 10, outputLatency: 0.25, queuedUntil: 14 });
  await player.flush();
  assert.equal(Math.round(player.msUntilHeard(250)), 500);
});

// #24: the tutor's audio arrives as binary frames of PCM16 at 24 kHz.
test('enqueuePcm16 plays a binary frame back to back after the queued audio', async () => {
  const started = [];
  const ctx = {
    state: 'running',
    currentTime: 5,
    sampleRate: 24000,
    createBuffer: (channels, length, rate) => {
      const data = new Float32Array(length);
      return { duration: length / rate, copyToChannel: (src) => data.set(src), data };
    },
    createBufferSource: () => ({
      connect() {},
      start(at) {
        started.push({ at, samples: [...this.buffer.data] });
      },
    }),
  };
  const player = new AudioPlayer();
  player.ctx = /** @type {any} */ (ctx);
  player.nextStartTime = 6;
  await player.enqueuePcm16(new Int16Array([16384, -16384, 0]).buffer);
  await player.enqueuePcm16(new Int16Array([8192, 8192]).buffer);
  assert.deepEqual(started, [
    { at: 6, samples: [0.5, -0.5, 0] },
    { at: 6 + 3 / 24000, samples: [0.25, 0.25] },
  ]);
});
