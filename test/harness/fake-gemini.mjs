// A scriptable stand-in for the Gemini Live WebSocket, used by the
// reproduction harness (test/live-harness.test.js, scripts/repro-browser.mjs).
//
// It speaks just enough of the real protocol for Parley's server to run
// unmodified: `setup` -> `setupComplete`, a `clientContent` turn -> an audio
// reply streamed at real-time pace (like gemini-3.8-live does, measured with
// scripts/live-probe.mjs) followed by `turnComplete`, and `realtimeInput`
// audio -> recorded, with a crude energy VAD that answers once it hears
// speech followed by silence.
//
// Every reply's PCM is filled with a constant sample value unique to the
// upstream session that produced it (see sessionTag), so a listener can tell
// which session any audio chunk came from — that is how the harness detects
// two sessions' audio reaching the same browser.

import { WebSocketServer } from 'ws';

const OUTPUT_BYTES_PER_SECOND = 24000 * 2;
const INPUT_BYTES_PER_SECOND = 16000 * 2;

// Sample value used to fill session N's audio: 1000, 2000, 3000...
export function sessionTag(sessionId) {
  return sessionId * 1000;
}

// Reads the tag back out of a base64 PCM16 chunk (first sample).
export function tagOfChunk(base64) {
  const buf = Buffer.from(base64, 'base64');
  return buf.length >= 2 ? buf.readInt16LE(0) : 0;
}

function pcmChunk(bytes, value) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(value, i);
  return buf.toString('base64');
}

function rms(base64) {
  const buf = Buffer.from(base64, 'base64');
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Options are read on every event, so a test can change them between steps
 * through the returned `options` object (one fake can serve many scenarios).
 *
 * @param {object} [opts]
 * @param {number} [opts.replySeconds]      length of every spoken reply
 * @param {number} [opts.chunkBytes]        PCM bytes per audio message (15360 = 320 ms, the median measured live)
 * @param {number} [opts.pace]              1 = real time, 0 = as fast as possible
 * @param {number} [opts.firstAudioDelayMs] think time before the first audio chunk (~700 ms measured live)
 * @param {number} [opts.setupDelayMs]      delay before setupComplete
 * @param {boolean} [opts.neverCompleteSetup]
 * @param {boolean} [opts.omitTurnComplete] stream replies but never send turnComplete (seen once live)
 * @param {boolean} [opts.sendResumptionHandles] emit sessionResumptionUpdate like the real API does
 * @param {number} [opts.vadThreshold]      RMS above which a mic frame counts as speech
 */
export async function startFakeGemini(opts = {}) {
  const o = {
    replySeconds: 2,
    chunkBytes: 15360,
    pace: 1,
    firstAudioDelayMs: 0,
    setupDelayMs: 0,
    neverCompleteSetup: false,
    omitTurnComplete: false,
    sendResumptionHandles: true,
    vadThreshold: 0.02,
    ...opts,
  };

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (wss.address());

  const sessions = [];
  let nextId = 1;

  wss.on('connection', (ws) => {
    const session = {
      id: nextId++,
      ws,
      openedAt: Date.now(),
      closedAt: null,
      setup: null,
      textTurns: [],
      audioFrames: [], // { at, bytes, rms }
      replies: 0,
      replyStarts: [], // wall time of each reply's first audio chunk
      speaking: false,
      heardSpeechMs: 0,
      silenceMs: 0,
      drop(code = 1011, reason = 'Internal error encountered.') {
        ws.close(code, reason);
      },
    };
    sessions.push(session);
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    async function reply(text) {
      session.replies += 1;
      session.speaking = true;
      if (o.firstAudioDelayMs > 0) await new Promise((r) => setTimeout(r, o.firstAudioDelayMs));
      const totalBytes = Math.round((o.replySeconds * OUTPUT_BYTES_PER_SECOND) / 2) * 2;
      const chunkSeconds = o.chunkBytes / OUTPUT_BYTES_PER_SECOND;
      for (let sent = 0; sent < totalBytes && ws.readyState === ws.OPEN; sent += o.chunkBytes) {
        const bytes = Math.min(o.chunkBytes, totalBytes - sent);
        if (sent === 0) session.replyStarts.push(Date.now());
        send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmChunk(bytes, sessionTag(session.id)) } }] } } });
        if (o.pace > 0) await new Promise((r) => setTimeout(r, chunkSeconds * 1000 * o.pace));
      }
      send({ serverContent: { outputTranscription: { text } } });
      if (!o.omitTurnComplete) send({ serverContent: { turnComplete: true } });
      session.speaking = false;
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.setup) {
        session.setup = msg.setup;
        if (o.neverCompleteSetup) return;
        setTimeout(() => {
          send({ setupComplete: {} });
          if (o.sendResumptionHandles) send({ sessionResumptionUpdate: { newHandle: `handle-${session.id}`, resumable: true } });
        }, o.setupDelayMs);
        return;
      }
      if (msg.clientContent) {
        const text = msg.clientContent.turns?.[0]?.parts?.[0]?.text ?? '';
        session.textTurns.push({ at: Date.now(), role: msg.clientContent.turns?.[0]?.role, text });
        void reply(`Reply ${session.replies + 1} from session ${session.id}.`);
        return;
      }
      if (msg.realtimeInput?.audio) {
        const { data } = msg.realtimeInput.audio;
        const level = rms(data);
        const bytes = Buffer.from(data, 'base64').length;
        session.audioFrames.push({ at: Date.now(), bytes, rms: level });
        if (session.speaking) return;
        const ms = (bytes / INPUT_BYTES_PER_SECOND) * 1000;
        if (level > o.vadThreshold) {
          session.heardSpeechMs += ms;
          session.silenceMs = 0;
        } else if (session.heardSpeechMs > 0) {
          session.silenceMs += ms;
          if (session.silenceMs >= 700) {
            const heard = Math.round(session.heardSpeechMs);
            session.heardSpeechMs = 0;
            session.silenceMs = 0;
            send({ serverContent: { inputTranscription: { text: `heard ${heard} ms of speech` } } });
            void reply(`Answer ${session.replies + 1} from session ${session.id}.`);
          }
        }
      }
    });
    ws.on('close', () => {
      session.closedAt = Date.now();
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    options: o,
    port,
    sessions,
    openSessions: () => sessions.filter((s) => s.closedAt === null),
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve(undefined));
      }),
  };
}
