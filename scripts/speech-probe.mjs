#!/usr/bin/env node
// Real-API probe for "Parley mistakes my language / asks me to repeat
// something I never said" (#14). Replays one learner turn through the REAL
// Gemini Live API using Parley's exact setup frame and persona prompt
// (imported from server/live.ts and server/tutor.ts), and records what the
// model transcribed and what the tutor said back.
//
// Each variant is derived deterministically from committed fixtures, so the
// only network calls are the Live sessions themselves (plus one cached TTS
// call the first time the accented fixture is needed):
//
//   clean      - test/fixtures/speech.pcm as is (control)
//   doubled    - what the server receives when two mic pipelines run at once
//                (reproduced in the browser by scripts/repro-browser.mjs
//                server-restart): 32 ms slices from two offset copies of the
//                same mic, interleaved, at twice the frame rate
//   quiet      - phone held far away: -22 dB plus a light noise floor
//   accented   - the same sentence spoken with a strong Spanish accent
//                (Gemini TTS, cached as test/fixtures/speech-accented.pcm)
//   echo       - no learner speech at all: only a faint tail of the tutor's
//                own voice (the fixture uses the same voice as the tutor)
//
// Usage:
//   GOOGLE_API_KEY=... node --import tsx scripts/speech-probe.mjs [variant ...] [--hint] [--prompt-file F]
//   --hint         adds an English language hint to the setup (input
//                  transcription languageCodes + speechConfig.languageCode)
//                  to test whether it keeps the transcript in English
//   --legacy       sends the persona as the first user turn, as Parley did
//                  before #23 (default: Parley's setup, persona as
//                  systemInstruction plus the kickoff app note)
//   --prompt-file  replaces the persona prompt with the file's content (to
//                  try a revised prompt without editing server code)
//   --trace        also print the sequence of upstream message kinds

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { buildSetupFrame, textUpstreamFrame, audioUpstreamFrame, upstreamUrl } from '../server/live.ts';
import { buildSystemPrompt, KICKOFF_NOTE } from '../server/tutor.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEY = process.env.GOOGLE_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
if (!KEY) {
  console.error('GOOGLE_API_KEY is required');
  process.exit(2);
}

const argv = process.argv.slice(2);
const HINT = argv.includes('--hint');
const LEGACY = argv.includes('--legacy');
const TRACE = argv.includes('--trace');
const pfIdx = argv.indexOf('--prompt-file');
const PROMPT_FILE = pfIdx !== -1 ? argv[pfIdx + 1] : null;
const ALL = ['clean', 'doubled', 'quiet', 'accented', 'echo'];
const variants = argv.filter((a) => ALL.includes(a));
const run = variants.length ? variants : ALL;

const RATE = 16000;
const FRAME = 512; // samples per browser worklet chunk (32 ms)

function pcm(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}
function toBuf(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}
function silence(seconds) {
  return new Int16Array(Math.round(seconds * RATE));
}
function concat(...arrays) {
  const out = new Int16Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
function gain(a, g) {
  return a.map((v) => Math.max(-32768, Math.min(32767, Math.round(v * g))));
}
// Deterministic noise (LCG), so every run sends identical bytes.
function addNoise(a, amplitude) {
  let seed = 12345;
  return a.map((v) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = ((seed / 0x7fffffff) * 2 - 1) * amplitude;
    return Math.max(-32768, Math.min(32767, Math.round(v + n)));
  });
}

const speech = pcm(readFileSync(path.join(ROOT, 'test/fixtures/speech.pcm')));

async function accentedFixture() {
  const file = path.join(ROOT, 'test/fixtures/speech-accented.pcm');
  if (existsSync(file)) return pcm(readFileSync(file));
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Say it slowly and a little hesitantly, with a strong Spanish accent, like a beginner learner: I would like a coffee with milk, please.' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } },
    }),
  });
  if (!res.ok) throw new Error(`TTS failed ${res.status}`);
  const data = await res.json();
  const inline = data.candidates[0].content.parts[0].inlineData;
  const src = pcm(Buffer.from(inline.data, 'base64'));
  const ratio = 24000 / RATE;
  const out = new Int16Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = src[Math.floor(i * ratio)];
  writeFileSync(file, toBuf(out));
  return out;
}

// Two capture pipelines on one mic: each posts its own 512-sample chunks,
// slightly out of phase; the server forwards both, in arrival order.
function doubled(a) {
  const offset = 173;
  const b = concat(silence(offset / RATE), a);
  const frames = [];
  for (let i = 0; i + FRAME <= a.length; i += FRAME) {
    frames.push(a.subarray(i, i + FRAME));
    frames.push(b.subarray(i, i + FRAME));
  }
  return { frames, intervalMs: 16 };
}

function framesOf(a) {
  const frames = [];
  for (let i = 0; i < a.length; i += FRAME) frames.push(a.subarray(i, Math.min(i + FRAME, a.length)));
  return { frames, intervalMs: 32 };
}

async function buildVariant(name) {
  const lead = silence(0.3);
  const trail = silence(1.6);
  switch (name) {
    case 'clean':
      return framesOf(concat(lead, speech, trail));
    case 'doubled': {
      const d = doubled(concat(lead, speech));
      d.frames.push(...framesOf(trail).frames);
      return d;
    }
    case 'quiet':
      return framesOf(concat(lead, addNoise(gain(speech, 0.08), 250), addNoise(trail, 250)));
    case 'accented':
      return framesOf(concat(lead, await accentedFixture(), trail));
    case 'echo': {
      const tail = speech.subarray(speech.length - Math.round(0.9 * RATE));
      return framesOf(concat(lead, addNoise(gain(tail, 0.15), 120), addNoise(trail, 120)));
    }
    default:
      throw new Error(`unknown variant ${name}`);
  }
}

function setupFrame(prompt) {
  const frame = buildSetupFrame({ model: MODEL, voice: 'Kore', persona: LEGACY ? '' : prompt });
  const s = /** @type {any} */ (frame.setup);
  if (HINT) {
    s.inputAudioTranscription = { languageCodes: ['en-US'] };
    s.generationConfig.speechConfig.languageCode = 'en-US';
  }
  return frame;
}

function runVariant(name, variant) {
  const prompt = PROMPT_FILE ? readFileSync(PROMPT_FILE, 'utf8') : buildSystemPrompt({ scenario: 'Just talk', level: 'B1', learnerName: 'Ana' });
  return new Promise((resolve) => {
    const ws = new WebSocket(upstreamUrl(KEY));
    const out = { variant: name, model: MODEL, hint: HINT, legacy: LEGACY, greeting: '', heard: '', reply: '', interrupted: false, error: null, frames: [] };
    let phase = 'setup';
    const timer = setTimeout(() => {
      out.error = `timeout in phase ${phase}`;
      ws.close();
    }, 45000);
    ws.on('open', () => ws.send(JSON.stringify(setupFrame(prompt))));
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      // Compact trace of what arrived in which phase (audio collapsed).
      const kind = Object.keys(msg.serverContent ?? msg).filter((k) => k !== 'modelTurn' || !out.frames.at(-1)?.endsWith('modelTurn')).join('+');
      if (kind) out.frames.push(`${phase}:${kind}`);
      if (msg.setupComplete) {
        phase = 'greeting';
        ws.send(JSON.stringify(textUpstreamFrame(LEGACY ? prompt : KICKOFF_NOTE)));
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.interrupted) out.interrupted = true;
      if (sc.inputTranscription?.text) out.heard += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) {
        if (phase === 'greeting') out.greeting += sc.outputTranscription.text;
        else out.reply += sc.outputTranscription.text;
      }
      if (sc.turnComplete) {
        if (phase === 'greeting') {
          phase = 'learner';
          for (const f of variant.frames) {
            ws.send(JSON.stringify(audioUpstreamFrame(toBuf(f).toString('base64'))));
            await new Promise((r) => setTimeout(r, variant.intervalMs));
          }
          phase = 'reply';
          // A learner turn that never triggers a reply is itself a result.
          setTimeout(() => {
            if (phase === 'reply') {
              out.reply = out.reply || '(no reply within 12 s)';
              ws.close();
            }
          }, 12000);
        } else if (phase === 'reply') {
          phase = 'done';
          ws.close();
        }
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      if (phase !== 'done' && !out.error && !out.reply) out.error = `closed ${code} ${reason}`;
      resolve(out);
    });
    ws.on('error', () => {});
  });
}

const results = [];
for (const name of run) {
  const v = await buildVariant(name);
  const r = await runVariant(name, v);
  for (const k of ['greeting', 'heard', 'reply']) r[k] = r[k].replace(/\s+/g, ' ').trim();
  if (!TRACE) delete r.frames;
  results.push(r);
  console.log(JSON.stringify(r));
}
