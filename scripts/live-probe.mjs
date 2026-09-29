#!/usr/bin/env node
// Talks to the real Gemini Live API directly (no Parley server in between) to
// answer two questions the unit tests cannot:
//
//   1. Timing of one tutor turn: connect -> setupComplete -> first audio ->
//      last audio -> turnComplete, against how many seconds of audio that
//      turn contains. Where turnComplete lands relative to the end of
//      playback decides whether the server-side half-duplex gate (which
//      re-opens the mic a fixed delay after turnComplete) can re-open it
//      while the browser is still playing the reply out loud.
//   2. Which optional setup fields the model accepts (systemInstruction,
//      transcription language hints, session resumption, context window
//      compression). A rejected field closes the socket with a reason.
//
// Uses the API sparingly: one short greeting turn plus one setup-only
// connection per probed variant (no audio is streamed for the variants).
//
// Usage: GOOGLE_API_KEY=... node scripts/live-probe.mjs [--model M] [--variants-only|--timing-only]

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const modelIdx = args.indexOf('--model');
const MODEL = modelIdx !== -1 ? args[modelIdx + 1] : process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const KEY = process.env.GOOGLE_API_KEY;
if (!KEY) {
  console.error('GOOGLE_API_KEY is required');
  process.exit(2);
}
const URL_ =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=' +
  KEY;

const OUTPUT_BYTES_PER_SECOND = 24000 * 2; // 24 kHz mono PCM16

function baseSetup(extra = {}) {
  return {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...extra,
    },
  };
}

function open(setup, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ws = new WebSocket(URL_);
    const result = { openMs: null, setupMs: null, closeCode: null, closeReason: '' };
    const timer = setTimeout(() => {
      result.timedOut = true;
      ws.close();
    }, timeoutMs);
    ws.on('open', () => {
      result.openMs = Math.round(performance.now() - t0);
      ws.send(JSON.stringify(setup));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.setupComplete && result.setupMs === null) {
        result.setupMs = Math.round(performance.now() - t0);
        clearTimeout(timer);
        ws.close();
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      result.closeCode = code;
      result.closeReason = reason.toString().slice(0, 200);
      resolve(result);
    });
    ws.on('error', () => {});
  });
}

async function timing() {
  const t = { sentAt: 0, firstAudio: null, lastAudio: null, turnComplete: null, chunks: 0, audioBytes: 0, chunkSizes: [], wireBytes: 0, text: '' };
  const t0 = performance.now();
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(URL_);
    const out = { openMs: null, setupMs: null };
    const timer = setTimeout(() => ws.close(), 30000);
    ws.on('open', () => {
      out.openMs = Math.round(performance.now() - t0);
      ws.send(JSON.stringify(baseSetup()));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.setupComplete) {
        out.setupMs = Math.round(performance.now() - t0);
        t.sentAt = performance.now();
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  role: 'user',
                  parts: [{ text: 'You are a friendly English tutor. Greet the learner in two or three sentences and ask what they did today.' }],
                },
              ],
              turnComplete: true,
            },
          }),
        );
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      for (const p of sc.modelTurn?.parts || []) {
        if (p.inlineData?.data) {
          if (t.firstAudio === null) t.firstAudio = performance.now();
          t.lastAudio = performance.now();
          const bytes = Buffer.from(p.inlineData.data, 'base64').length;
          t.chunks += 1;
          t.audioBytes += bytes;
          t.chunkSizes.push(bytes);
          t.wireBytes += JSON.stringify({ type: 'audio', data: p.inlineData.data }).length;
        }
      }
      if (sc.outputTranscription?.text) t.text += sc.outputTranscription.text;
      if (sc.turnComplete) {
        t.turnComplete = performance.now();
        clearTimeout(timer);
        ws.close();
      }
    });
    ws.on('close', (code, reason) => resolve({ ...out, closeCode: code, closeReason: reason.toString().slice(0, 200) }));
    ws.on('error', () => {});
  });

  const audioSeconds = t.audioBytes / OUTPUT_BYTES_PER_SECOND;
  const genSeconds = t.firstAudio && t.turnComplete ? (t.turnComplete - t.firstAudio) / 1000 : NaN;
  const sorted = [...t.chunkSizes].sort((a, b) => a - b);
  const report = {
    model: MODEL,
    connectToOpenMs: result.openMs,
    connectToSetupCompleteMs: result.setupMs,
    promptToFirstAudioMs: t.firstAudio ? Math.round(t.firstAudio - t.sentAt) : null,
    firstAudioToTurnCompleteMs: Number.isFinite(genSeconds) ? Math.round(genSeconds * 1000) : null,
    lastAudioToTurnCompleteMs: t.lastAudio && t.turnComplete ? Math.round(t.turnComplete - t.lastAudio) : null,
    audioSeconds: +audioSeconds.toFixed(2),
    // How fast the reply's audio actually arrives: the API sends it in a
    // burst, much faster than real time...
    audioDeliveryMs: t.lastAudio && t.firstAudio ? Math.round(t.lastAudio - t.firstAudio) : null,
    // ...but holds turnComplete until about when playback (started at the
    // first chunk) would end. Near 0 means turnComplete ~ end of playback, so
    // a mic gate re-opened a fixed delay after turnComplete has only that
    // delay minus network and device output latency as echo margin.
    turnCompleteMinusPlaybackEndMs: Number.isFinite(genSeconds) ? Math.round((genSeconds - audioSeconds) * 1000) : null,
    audioChunks: t.chunks,
    chunkBytesMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    chunkBytesMax: sorted.length ? sorted[sorted.length - 1] : null,
    pcmBytes: t.audioBytes,
    clientWireBytesAsBase64Json: t.wireBytes,
    wireOverheadPct: t.audioBytes ? Math.round((t.wireBytes / t.audioBytes - 1) * 100) : null,
    transcript: t.text.trim(),
    closeCode: result.closeCode,
  };
  return report;
}

const VARIANTS = {
  baseline: {},
  systemInstruction: { systemInstruction: { parts: [{ text: 'You are a friendly English tutor.' }] } },
  speechLanguageCode: null, // filled below — lives inside generationConfig.speechConfig
  inputTranscriptionLanguageCodes: { inputAudioTranscription: { languageCodes: ['en-US'] } },
  sessionResumption: { sessionResumption: {} },
  contextWindowCompression: { contextWindowCompression: { slidingWindow: {} } },
};

async function variants() {
  const out = {};
  for (const [name, extra] of Object.entries(VARIANTS)) {
    let setup;
    if (name === 'speechLanguageCode') {
      setup = baseSetup();
      setup.setup.generationConfig.speechConfig.languageCode = 'en-US';
    } else {
      setup = baseSetup(extra);
    }
    const r = await open(setup, { timeoutMs: 12000 });
    out[name] = r.setupMs !== null ? `accepted (setupComplete in ${r.setupMs} ms)` : `rejected: close ${r.closeCode} ${r.closeReason}`;
  }
  return out;
}

const runTiming = !args.includes('--variants-only');
const runVariants = !args.includes('--timing-only');
if (runTiming) console.log('timing:', JSON.stringify(await timing(), null, 2));
if (runVariants) console.log('setup variants:', JSON.stringify(await variants(), null, 2));
