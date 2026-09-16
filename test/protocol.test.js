import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUpstreamFrame, audioUpstreamFrame, textUpstreamFrame, buildSetupFrame, HalfDuplexGate } from '../server/live.js';

test('audioUpstreamFrame shapes a base64 PCM16 16kHz realtimeInput frame', () => {
  const frame = audioUpstreamFrame('QUJD');
  assert.deepEqual(frame, {
    realtimeInput: { audio: { data: 'QUJD', mimeType: 'audio/pcm;rate=16000' } },
  });
});

test('textUpstreamFrame shapes a completed clientContent user turn', () => {
  const frame = textUpstreamFrame('hello there');
  assert.deepEqual(frame, {
    clientContent: { turns: [{ role: 'user', parts: [{ text: 'hello there' }] }], turnComplete: true },
  });
});

test('toUpstreamFrame codec: audio', () => {
  const frame = toUpstreamFrame({ type: 'audio', data: 'ZGF0YQ==' });
  assert.deepEqual(frame, audioUpstreamFrame('ZGF0YQ=='));
});

test('toUpstreamFrame codec: text', () => {
  const frame = toUpstreamFrame({ type: 'text', text: 'good morning' });
  assert.deepEqual(frame, textUpstreamFrame('good morning'));
});

test('toUpstreamFrame codec: say (silent control turn uses the same clientContent shape)', () => {
  const frame = toUpstreamFrame({ type: 'say', text: "Let's switch to a job interview." });
  assert.deepEqual(frame, textUpstreamFrame("Let's switch to a job interview."));
});

test('toUpstreamFrame codec: interrupt has no upstream wire shape (handled locally)', () => {
  assert.equal(toUpstreamFrame({ type: 'interrupt' }), null);
});

test('toUpstreamFrame codec: unknown message types are ignored', () => {
  assert.equal(toUpstreamFrame({ type: 'stop' }), null);
});

test('buildSetupFrame shapes model, voice and VAD config', () => {
  const frame = buildSetupFrame({ model: 'gemini-3.8-live', voice: 'Kore' });
  assert.equal(frame.setup.model, 'models/gemini-3.8-live');
  assert.equal(
    frame.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    'Kore',
  );
  assert.deepEqual(frame.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.deepEqual(frame.setup.inputAudioTranscription, {});
  assert.deepEqual(frame.setup.outputAudioTranscription, {});
  assert.equal(frame.setup.realtimeInputConfig.automaticActivityDetection.disabled, false);
  assert.equal(frame.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 700);
});

// --- half-duplex gating -----------------------------------------------------

test('HalfDuplexGate: mic is open before the assistant has spoken', () => {
  const gate = new HalfDuplexGate({ enabled: true });
  assert.equal(gate.isGated(), false);
});

test('HalfDuplexGate: mic frames are dropped while assistant audio is playing', () => {
  const gate = new HalfDuplexGate({ enabled: true });
  gate.onAssistantAudio();
  assert.equal(gate.isGated(), true);
});

test('HalfDuplexGate: mic stays gated during the tail guard, then resumes', () => {
  let now = 1000;
  const gate = new HalfDuplexGate({ enabled: true, tailGuardMs: 400, now: () => now });
  gate.onAssistantAudio();
  gate.onTurnComplete();
  assert.equal(gate.isGated(), true, 'still gated immediately after turnComplete');

  now += 200;
  assert.equal(gate.isGated(), true, 'still gated inside the tail guard window');

  now += 250; // total 450ms > 400ms tail guard
  assert.equal(gate.isGated(), false, 'gate opens after the tail guard elapses');
});

test('HalfDuplexGate: interruption opens the gate immediately', () => {
  const gate = new HalfDuplexGate({ enabled: true, tailGuardMs: 400 });
  gate.onAssistantAudio();
  gate.onInterrupted();
  assert.equal(gate.isGated(), false);
});

test('HalfDuplexGate: disabled gate (hands-free mode) never gates', () => {
  const gate = new HalfDuplexGate({ enabled: false });
  gate.onAssistantAudio();
  assert.equal(gate.isGated(), false);
});
