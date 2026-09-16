import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GeminiLiveSession } from '../server/live.js';

// A minimal stand-in for the upstream WebSocket, driven manually so a test
// can script exactly what "Gemini" sends back without any network. Mirrors
// just the subset of the browser/`ws` WebSocket API server/live.js touches:
// addEventListener, send, readyState/OPEN, close.
class FakeUpstreamSocket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.readyState = FakeUpstreamSocket.OPEN;
    this.binaryType = 'nodebuffer';
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeUpstreamSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  emitServerMessage(obj) {
    const event = new Event('message');
    event.data = JSON.stringify(obj);
    this.dispatchEvent(event);
  }
}
FakeUpstreamSocket.OPEN = 1;
FakeUpstreamSocket.CLOSED = 3;

function audioChunkMessage() {
  return { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'ZmFrZQ==' } }] } } };
}

function turnCompleteMessage() {
  return { serverContent: { turnComplete: true } };
}

async function startSession(options = {}) {
  const session = new GeminiLiveSession({
    apiKey: 'k',
    model: 'm',
    voice: 'Kore',
    webSocketImpl: FakeUpstreamSocket,
    ...options,
  });
  const clientEvents = [];
  session.on('client', (msg) => clientEvents.push(msg));

  const startPromise = session.start();
  const ws = session.ws;
  // No need to wait for the synthetic 'open' — setupComplete's handling
  // doesn't depend on it, matching how the real message handler behaves.
  ws.emitServerMessage({ setupComplete: {} });
  await startPromise;

  return { session, ws, clientEvents };
}

function audioFrameCount(ws) {
  return ws.sent.filter((f) => f.realtimeInput?.audio).length;
}

test('a live session accepts a second and third user turn after the tutor finishes speaking', async () => {
  const { session, ws, clientEvents } = await startSession();

  // The persona/greeting turn is in flight and pre-gates the mic (see
  // server/live.js constructor comment) — confirm audio sent right now is
  // dropped, exactly as it would be for a learner who starts talking before
  // the greeting has played.
  assert.equal(session.sendAudio('greeting-gated'), false);

  // The greeting "speaks" and completes. It's a silent turn (no review),
  // but the gate must still cycle through it like any other turn.
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  const turnCompleteEventsAfterGreeting = clientEvents.filter((e) => e.type === 'turn-complete').length;
  assert.equal(turnCompleteEventsAfterGreeting, 0, 'the greeting turn is silent, no turn-complete for it');

  await delay(450); // past the 400ms tail guard
  assert.equal(session.sendAudio('turn-1-audio'), true, 'mic re-opens after the greeting finishes');

  // --- user turn 1 ------------------------------------------------------
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  assert.equal(session.sendAudio('gated-during-turn-1-reply'), false, 'gated again while turn 1 wraps up');

  await delay(450);
  assert.equal(session.sendAudio('turn-2-audio'), true, 'mic re-opens after turn 1 finishes');

  // --- user turn 2 --------------------------------------------------------
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  await delay(450);
  assert.equal(session.sendAudio('turn-3-audio'), true, 'mic re-opens after turn 2 finishes, ready for a third turn');

  // --- user turn 3 --------------------------------------------------------
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  await delay(450);
  assert.equal(session.sendAudio('turn-4-audio'), true, 'mic re-opens yet again after turn 3 — the gate never gets stuck');

  const turnCompleteEvents = clientEvents.filter((e) => e.type === 'turn-complete');
  assert.equal(turnCompleteEvents.length, 3, 'turns 1, 2 and 3 each produced a turn-complete event (greeting excluded)');

  const sentAudioFrames = audioFrameCount(ws);
  assert.equal(sentAudioFrames, 4, 'exactly the 4 non-gated sendAudio calls actually reached upstream');

  session.stop();
});

test('a live session keeps accepting turns indefinitely, not just the first one or two', async () => {
  const { session, ws } = await startSession();

  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(450);

  let acceptedTurns = 0;
  for (let i = 0; i < 6; i++) {
    const opened = session.sendAudio(`turn-${i}`);
    if (opened) acceptedTurns += 1;
    ws.emitServerMessage(audioChunkMessage());
    ws.emitServerMessage(turnCompleteMessage());
    await delay(450);
  }

  assert.equal(acceptedTurns, 6, 'every one of 6 sequential turns found the mic open after its predecessor finished');

  session.stop();
});

// --- learner name flows into the review request ----------------------------

test('a completed turn\'s review-request payload carries the session\'s learnerName', async () => {
  const { session, ws } = await startSession({ learnerName: 'Kenji' });
  const reviewRequests = [];
  session.on('review-request', (payload) => reviewRequests.push(payload));

  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting, silent, no review-request
  await delay(450);

  ws.emitServerMessage(inputTranscriptionMessage("I'm Kenji"));
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  assert.equal(reviewRequests.length, 1);
  assert.equal(reviewRequests[0].learnerName, 'Kenji');

  session.stop();
});

test('setLearnerName updates the name carried by every later review-request, once the tutor learns it mid-session', async () => {
  const { session, ws } = await startSession(); // no learnerName yet
  const reviewRequests = [];
  session.on('review-request', (payload) => reviewRequests.push(payload));

  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting, silent
  await delay(450);

  // Turn 1: the learner introduces themselves — index.ts's review-request
  // handler would call setLearnerName once review.ts reports the captured
  // name back, which is what this simulates directly.
  ws.emitServerMessage(inputTranscriptionMessage("I'm Priya"));
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  assert.equal(reviewRequests[0].learnerName, '', 'not known yet for this first turn');
  session.setLearnerName('Priya');
  await delay(450);

  // Turn 2: the session must now report the name on every later turn,
  // without needing a fresh 'start' handshake.
  ws.emitServerMessage(inputTranscriptionMessage('Tell me more'));
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  assert.equal(reviewRequests.length, 2);
  assert.equal(reviewRequests[1].learnerName, 'Priya');

  session.stop();
});

// --- memory note flows into the persona turn --------------------------------

test('a session with a memoryNote weaves it into the persona turn sent upstream', async () => {
  const { ws } = await startSession({ memoryNote: 'talked about the weekend; the past tense was hard' });
  const personaFrame = ws.sent[0];
  assert.match(personaFrame.clientContent.turns[0].parts[0].text, /talked about the weekend; the past tense was hard/);
});

test('a session with no memoryNote mentions nothing about a remembered conversation', async () => {
  const { ws } = await startSession();
  const personaFrame = ws.sent[0];
  assert.doesNotMatch(personaFrame.clientContent.turns[0].parts[0].text, /remember this from earlier conversations/i);
});

// --- anti-freeze silence nudge, wired through a real session ----------------

function textOf(frame) {
  return frame.clientContent?.turns?.[0]?.parts?.[0]?.text;
}

test('armSilenceNudge speaks the nudge via say() if the learner stays silent', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(450);

  const sentBeforeNudge = ws.sent.length;
  session.nudge.delayMs = 30; // short delay so the test doesn't wait 6s
  session.armSilenceNudge();

  await delay(60);
  const nudgeFrames = ws.sent.slice(sentBeforeNudge).filter((f) => textOf(f)?.includes('Take your time'));
  assert.equal(nudgeFrames.length, 1, 'the nudge text was sent upstream exactly once');

  session.stop();
});

function inputTranscriptionMessage(text) {
  return { serverContent: { inputTranscription: { text } } };
}

test('armSilenceNudge is NOT disarmed by a raw sendAudio frame — the client streams mic audio continuously, silence included', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(450);

  const sentBeforeNudge = ws.sent.length;
  session.nudge.delayMs = 30;
  session.armSilenceNudge();

  // The browser client sends mic frames unconditionally, even while silent —
  // a raw frame must not be mistaken for the learner actually speaking.
  session.sendAudio('silent-mic-frame-the-client-sends-regardless');
  await delay(60);

  const nudgeFrames = ws.sent.slice(sentBeforeNudge).filter((f) => textOf(f)?.includes('Take your time'));
  assert.equal(nudgeFrames.length, 1, 'a raw audio frame does not disarm the nudge, so it still fires');

  session.stop();
});

test('armSilenceNudge is disarmed once the learner\'s speech is actually transcribed', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(450);

  const sentBeforeNudge = ws.sent.length;
  session.nudge.delayMs = 30;
  session.armSilenceNudge();

  // Upstream reports real transcribed speech — this is the actual "the
  // learner started talking" signal, unlike a raw sendAudio frame.
  ws.emitServerMessage(inputTranscriptionMessage('okay let me try'));
  await delay(60);

  const nudgeFrames = ws.sent.slice(sentBeforeNudge).filter((f) => textOf(f)?.includes('Take your time'));
  assert.equal(nudgeFrames.length, 0, 'transcribed speech disarmed the nudge before its delay elapsed');

  session.stop();
});

test('armSilenceNudge fires at most once even if re-armed after already firing', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(450);

  session.nudge.delayMs = 30;
  session.armSilenceNudge();
  await delay(60);

  const sentAfterFirstFire = ws.sent.length;
  assert.equal(session.nudge.shouldFire(), false, 'already fired once for this arm');

  await delay(60);
  const nudgeFramesAfterWaiting = ws.sent.slice(sentAfterFirstFire).filter((f) => textOf(f)?.includes('Take your time'));
  assert.equal(nudgeFramesAfterWaiting.length, 0, 'no second nudge without a fresh arm');

  session.stop();
});
