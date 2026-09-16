import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket as WsWebSocket } from 'ws';
import {
  toUpstreamFrame,
  audioUpstreamFrame,
  textUpstreamFrame,
  buildSetupFrame,
  HalfDuplexGate,
  SilenceNudge,
  containsStackedTurn,
  resolveWebSocketImpl,
  GeminiLiveSession,
} from '../server/live.js';

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

// --- WebSocket implementation fallback (Node 20 has no global WebSocket) --

test('resolveWebSocketImpl uses globalThis.WebSocket when present', () => {
  const fakeGlobal = function FakeGlobalWebSocket() {};
  const original = globalThis.WebSocket;
  globalThis.WebSocket = fakeGlobal;
  try {
    assert.equal(resolveWebSocketImpl(), fakeGlobal);
  } finally {
    if (original === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original;
  }
});

test('resolveWebSocketImpl falls back to the ws package when globalThis.WebSocket is absent (Node 20)', () => {
  const original = globalThis.WebSocket;
  delete globalThis.WebSocket;
  try {
    assert.equal(resolveWebSocketImpl(), WsWebSocket);
  } finally {
    if (original !== undefined) globalThis.WebSocket = original;
  }
});

test('GeminiLiveSession picks up the ws-package fallback when constructed without globalThis.WebSocket', () => {
  const original = globalThis.WebSocket;
  delete globalThis.WebSocket;
  try {
    const session = new GeminiLiveSession({ apiKey: 'k', model: 'm', voice: 'Kore' });
    assert.equal(session.WebSocketImpl, WsWebSocket);
  } finally {
    if (original !== undefined) globalThis.WebSocket = original;
  }
});

test('HalfDuplexGate: re-arms correctly across many consecutive turns (fake clock)', () => {
  let now = 0;
  const gate = new HalfDuplexGate({ enabled: true, tailGuardMs: 400, now: () => now });
  for (let turn = 0; turn < 5; turn++) {
    gate.onAssistantAudio();
    assert.equal(gate.isGated(), true, `turn ${turn}: gated while the assistant is speaking`);
    gate.onTurnComplete();
    assert.equal(gate.isGated(), true, `turn ${turn}: still gated immediately after turnComplete`);
    now += 400;
    assert.equal(gate.isGated(), false, `turn ${turn}: gate re-opens once the tail guard elapses`);
    now += 1000; // the learner speaks for a while before the next turn starts
  }
});

// --- anti-freeze silence nudge (fake clock) ---------------------------------

test('SilenceNudge: not armed and does not fire before arm() is called', () => {
  const nudge = new SilenceNudge({ delayMs: 6000 });
  assert.equal(nudge.isArmed(), false);
  assert.equal(nudge.shouldFire(), false);
});

test('SilenceNudge: fires once the delay elapses after arming', () => {
  let now = 1000;
  const nudge = new SilenceNudge({ delayMs: 6000, now: () => now });
  nudge.arm();
  assert.equal(nudge.isArmed(), true);
  assert.equal(nudge.shouldFire(), false, 'not yet — delay has not elapsed');

  now += 5999;
  assert.equal(nudge.shouldFire(), false, 'still not yet — 1ms short of the delay');

  now += 1;
  assert.equal(nudge.shouldFire(), true, 'fires once the delay has fully elapsed');
});

test('SilenceNudge: never fires twice for the same arm', () => {
  let now = 0;
  const nudge = new SilenceNudge({ delayMs: 1000, now: () => now });
  nudge.arm();
  now += 1000;
  assert.equal(nudge.shouldFire(), true, 'fires the first time the delay elapses');
  now += 5000;
  assert.equal(nudge.shouldFire(), false, 'does not fire again for the same arm, however long we wait');
});

test('SilenceNudge: disarmed by learner input never fires', () => {
  let now = 0;
  const nudge = new SilenceNudge({ delayMs: 1000, now: () => now });
  nudge.arm();
  now += 500;
  nudge.disarm();
  assert.equal(nudge.isArmed(), false);
  now += 5000;
  assert.equal(nudge.shouldFire(), false, 'disarming clears the armed timestamp, so it can never fire for that arm');
});

test('SilenceNudge: re-arming after a fire resets it for another turn', () => {
  let now = 0;
  const nudge = new SilenceNudge({ delayMs: 1000, now: () => now });
  nudge.arm();
  now += 1000;
  assert.equal(nudge.shouldFire(), true);

  now += 2000;
  nudge.arm(); // a later turn also came back with a correction
  assert.equal(nudge.shouldFire(), false, 'freshly armed, delay has not elapsed yet');
  now += 1000;
  assert.equal(nudge.shouldFire(), true, 'fires again for the new arm');
});

// --- stacked-turn compliance signal ------------------------------------------

test('containsStackedTurn: flags a correction invitation followed by a question mark', () => {
  assert.equal(containsStackedTurn("Nice try! Just try saying it again — so, what's your favorite food?"), true);
  assert.equal(containsStackedTurn('Go on, give that one a go? What do you think?'), true);
});

test('containsStackedTurn: does not flag an invitation with no question, or a question with no invitation', () => {
  assert.equal(containsStackedTurn('Nice try! Try saying it again.'), false);
  assert.equal(containsStackedTurn('That flowed well — what did you do this weekend?'), false);
  assert.equal(containsStackedTurn(''), false);
});
