#!/usr/bin/env node
// Generates test/fixtures/fake-mic.wav — the fake-microphone fixture used by
// scripts/browser-check.mjs (Chrome's --use-file-for-fake-audio-capture) —
// deterministically from the already-cached test/fixtures/speech.pcm (see
// scripts/e2e-live.mjs), padded with silence into a handful of repeated
// utterances. This keeps the ~1MB generated WAV out of git entirely: it's
// cheap and instant to rebuild from a small real PCM clip we already have,
// so there is nothing to commit.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEECH_PCM = path.join(ROOT, 'test/fixtures/speech.pcm');
const OUT_WAV = path.join(ROOT, 'test/fixtures/fake-mic.wav');

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // PCM16
const REPEATS = 5;
const GAP_SECONDS = 2.5;
const LEAD_SECONDS = 0.5;
const TRAIL_SECONDS = 0.5;

function silence(seconds) {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * BYTES_PER_SAMPLE);
}

function wavHeader(dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export function generateFakeMic() {
  if (!existsSync(SPEECH_PCM)) {
    throw new Error(`missing ${SPEECH_PCM} — run \`npm run e2e\` once to generate it, then retry`);
  }
  const speech = readFileSync(SPEECH_PCM);
  const gap = silence(GAP_SECONDS);

  const parts = [silence(LEAD_SECONDS)];
  for (let i = 0; i < REPEATS; i++) {
    parts.push(speech);
    if (i < REPEATS - 1) parts.push(gap);
  }
  parts.push(silence(TRAIL_SECONDS));

  const data = Buffer.concat(parts);
  writeFileSync(OUT_WAV, Buffer.concat([wavHeader(data.length), data]));
  return OUT_WAV;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = generateFakeMic();
  console.log(`fake-mic WAV written to ${out}`);
}
