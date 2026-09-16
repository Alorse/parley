#!/usr/bin/env node
// Real end-to-end test: spawns the actual server, opens /live, streams real
// TTS-generated speech through it, and asserts the Gemini Live API replies
// with a transcript, audio, and a completed turn. Also exercises the real
// /api/review endpoint. No mocks, no network stand-ins.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { config } from '../server/config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = path.join(ROOT, 'test/fixtures/speech.pcm');
const TEST_PORT = 8323;
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TEST_SENTENCE = 'I would like a coffee with milk, please.';
const EXPECTED_WORDS = ['coffee', 'milk'];

function resamplePcm16(buffer, fromRate, toRate) {
  if (fromRate === toRate) return buffer;
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    output[i] = Math.round(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}

async function synthesizeSpeech(text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${config.googleApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.tutorVoice } } },
        },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`TTS request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    throw new Error(`TTS response had no audio data: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const rateMatch = /rate=(\d+)/.exec(inline.mimeType || '');
  const sourceRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const raw = Buffer.from(inline.data, 'base64');
  return resamplePcm16(raw, sourceRate, 16000);
}

async function ensureFixture() {
  if (existsSync(FIXTURE_PATH)) {
    console.log(`Using cached speech fixture: ${FIXTURE_PATH}`);
    return readFile(FIXTURE_PATH);
  }
  console.log(`No cached fixture — synthesizing "${TEST_SENTENCE}" with ${TTS_MODEL}...`);
  const pcm = await synthesizeSpeech(TEST_SENTENCE);
  await mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, pcm);
  console.log(`Wrote fixture: ${FIXTURE_PATH} (${pcm.length} bytes)`);
  return pcm;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const onStdout = (data) => {
      process.stdout.write(`[server] ${data}`);
      if (!resolved && data.toString().includes('listening')) {
        resolved = true;
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));
    child.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`server exited early with code ${code}`));
      }
    });
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error('server did not start in time'));
    }, 8000);
  });
}

async function stopServer(child) {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000),
  ]);
}

async function streamAudio(ws, pcm) {
  const chunkBytes = 640; // 320 samples * 2 bytes = 20ms @ 16kHz mono PCM16
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    ws.send(JSON.stringify({ type: 'audio', data: chunk.toString('base64') }));
    await delay(20);
  }
  // Trailing silence so the upstream VAD detects end-of-speech.
  const silence = Buffer.alloc(chunkBytes);
  for (let i = 0; i < 45; i++) {
    ws.send(JSON.stringify({ type: 'audio', data: silence.toString('base64') }));
    await delay(20);
  }
}

async function runLiveTest(pcm, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const events = [];
  const state = { ready: false, audioFrames: 0, inputTextFinal: '', turnComplete: false };
  let streaming = null;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for turn-complete. Events seen: ${events.join(', ')}`));
    }, 60000);

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'start', scenario: 'Just talk', level: 'B1', halfDuplex: true }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      events.push(msg.type);

      if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`server error: ${msg.message}`));
        return;
      }
      if (msg.type === 'ready') {
        state.ready = true;
      }
      if (msg.type === 'audio') {
        state.audioFrames += 1;
      }
      if (msg.type === 'input-text' && msg.final) {
        state.inputTextFinal = msg.text;
      }
      if (msg.type === 'turn-complete') {
        state.turnComplete = true;
        clearTimeout(timer);
        resolve();
      }
      // The server's first turn is the silent persona/greeting turn. Only
      // start streaming the learner's simulated speech once that greeting
      // has actually finished playing (audio seen, then back to
      // "listening") — sending audio while it plays confuses upstream turn
      // boundaries, since automatic activity detection is on.
      if (msg.type === 'state' && msg.value === 'listening' && state.audioFrames > 0 && !streaming) {
        streaming = streamAudio(ws, pcm).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    });
  });

  if (streaming) await streaming;

  ws.send(JSON.stringify({ type: 'stop' }));
  ws.close();

  console.log('Events observed:', events.join(', '));
  console.log('Final input transcript:', JSON.stringify(state.inputTextFinal));

  assert.equal(state.ready, true, 'expected a ready event');
  assert.ok(state.audioFrames >= 1, `expected at least one audio frame, got ${state.audioFrames}`);
  assert.equal(state.turnComplete, true, 'expected a turn-complete event');

  const normalized = state.inputTextFinal.toLowerCase();
  const foundWord = EXPECTED_WORDS.some((w) => normalized.includes(w));
  assert.ok(
    foundWord,
    `expected the input transcript to contain one of [${EXPECTED_WORDS.join(', ')}], got: "${state.inputTextFinal}"`,
  );
}

async function runReviewTest(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: TEST_SENTENCE, assistant: 'Sure, coming right up!', level: 'B1' }),
  });
  assert.ok(res.ok, `review endpoint returned ${res.status}`);
  const data = await res.json();
  console.log('review():', JSON.stringify(data));
  assert.ok(
    typeof data.score === 'number' && data.score >= 0 && data.score <= 100,
    `expected a clamped 0-100 score, got: ${JSON.stringify(data)}`,
  );
}

async function main() {
  const pcm = await ensureFixture();
  console.log(`Fixture: ${pcm.length} bytes, ${(pcm.length / 2 / 16000).toFixed(2)}s @16kHz mono PCM16`);

  console.log(`Starting server on port ${TEST_PORT}...`);
  const server = await startServer(TEST_PORT);
  try {
    console.log('\n--- /live speech round-trip ---');
    await runLiveTest(pcm, TEST_PORT);
    console.log('PASS: /live speech round-trip');

    console.log('\n--- /api/review ---');
    await runReviewTest(TEST_PORT);
    console.log('PASS: /api/review');

    console.log('\nE2E PASSED');
  } finally {
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err.message);
  process.exitCode = 1;
});
