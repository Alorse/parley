import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GeminiLiveSession, SilenceNudge, TAIL_GUARD_MS } from '../server/live.js';
import { APP_NOTE_PREFIX } from '../server/tutor.js';
import { waitFor } from './harness/wait.mjs';

const PAST_TAIL_GUARD = TAIL_GUARD_MS + 50;

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

  await delay(PAST_TAIL_GUARD); // past the tail guard
  assert.equal(session.sendAudio('turn-1-audio'), true, 'mic re-opens after the greeting finishes');

  // --- user turn 1 ------------------------------------------------------
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  assert.equal(session.sendAudio('gated-during-turn-1-reply'), false, 'gated again while turn 1 wraps up');

  await delay(PAST_TAIL_GUARD);
  assert.equal(session.sendAudio('turn-2-audio'), true, 'mic re-opens after turn 1 finishes');

  // --- user turn 2 --------------------------------------------------------
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  await delay(PAST_TAIL_GUARD);
  assert.equal(session.sendAudio('turn-3-audio'), true, 'mic re-opens after turn 2 finishes, ready for a third turn');

  // --- user turn 3 --------------------------------------------------------
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  await delay(PAST_TAIL_GUARD);
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
  await delay(PAST_TAIL_GUARD);

  let acceptedTurns = 0;
  for (let i = 0; i < 6; i++) {
    const opened = session.sendAudio(`turn-${i}`);
    if (opened) acceptedTurns += 1;
    ws.emitServerMessage(audioChunkMessage());
    ws.emitServerMessage(turnCompleteMessage());
    await delay(PAST_TAIL_GUARD);
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
  await delay(PAST_TAIL_GUARD);

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
  await delay(PAST_TAIL_GUARD);

  // Turn 1: the learner introduces themselves — index.ts's review-request
  // handler would call setLearnerName once review.ts reports the captured
  // name back, which is what this simulates directly.
  ws.emitServerMessage(inputTranscriptionMessage("I'm Priya"));
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());
  assert.equal(reviewRequests[0].learnerName, '', 'not known yet for this first turn');
  session.setLearnerName('Priya');
  await delay(PAST_TAIL_GUARD);

  // Turn 2: the session must now report the name on every later turn,
  // without needing a fresh 'start' handshake.
  ws.emitServerMessage(inputTranscriptionMessage('Tell me more'));
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  assert.equal(reviewRequests.length, 2);
  assert.equal(reviewRequests[1].learnerName, 'Priya');

  session.stop();
});

test('a typed turn is reviewed as what the learner typed', async () => {
  const { session, ws, clientEvents } = await startSession();
  const reviewRequests = [];
  session.on('review-request', (payload) => reviewRequests.push(payload));

  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting, silent
  await delay(PAST_TAIL_GUARD);

  session.sendText('Yesterday I goed to the park');
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  assert.equal(reviewRequests.length, 1);
  assert.equal(reviewRequests[0].user, 'Yesterday I goed to the park');
  assert.ok(clientEvents.some((e) => e.type === 'input-text' && e.final && e.text === 'Yesterday I goed to the park'), 'shown as the learner line');

  session.stop();
});

// --- scenario flows into the review request (issue #8) ---------------------

test('a completed turn\'s review-request payload carries the session\'s scenario, so the review can judge a role-play goodbye in context', async () => {
  const { session, ws } = await startSession({ scenario: 'Dinner out' });
  const reviewRequests = [];
  session.on('review-request', (payload) => reviewRequests.push(payload));

  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting, silent, no review-request
  await delay(PAST_TAIL_GUARD);

  ws.emitServerMessage(inputTranscriptionMessage('Goodbye, thanks for the meal!'));
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage());

  assert.equal(reviewRequests.length, 1);
  assert.equal(reviewRequests[0].scenario, 'Dinner out');

  session.stop();
});

// --- memory note flows into the persona --------------------------------

async function personaOf(ws) {
  await delay(0); // the setup frame goes out on the fake socket's 'open'
  return ws.sent.find((f) => f.setup).setup.systemInstruction.parts[0].text;
}

test('a session with a memoryNote weaves it into the persona sent upstream', async () => {
  const { session, ws } = await startSession({ memoryNote: 'talked about the weekend; the past tense was hard' });
  assert.match(await personaOf(ws), /talked about the weekend; the past tense was hard/);
  session.stop();
});

test('a session with no memoryNote mentions nothing about a remembered conversation', async () => {
  const { session, ws } = await startSession();
  assert.doesNotMatch(await personaOf(ws), /remember this from earlier conversations/i);
  session.stop();
});

// --- anti-freeze silence nudge, wired through a real session ----------------

function textOf(frame) {
  return frame.clientContent?.turns?.[0]?.parts?.[0]?.text;
}

const nudgesSince = (ws, from) => ws.sent.slice(from).filter((f) => textOf(f)?.includes('Take your time'));

async function waitForNudge(ws, from) {
  await waitFor(() => nudgesSince(ws, from).length > 0, 1000, 5);
  return nudgesSince(ws, from);
}

test('armSilenceNudge speaks the nudge via say() if the learner stays silent', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(PAST_TAIL_GUARD);

  const sentBeforeNudge = ws.sent.length;
  session.nudge.delayMs = 30; // short delay so the test doesn't wait 6s
  session.armSilenceNudge();

  const nudgeFrames = await waitForNudge(ws, sentBeforeNudge);
  await delay(60);
  assert.equal(nudgesSince(ws, sentBeforeNudge).length, 1, 'the nudge text was sent upstream exactly once');
  assert.ok(textOf(nudgeFrames[0]).startsWith(APP_NOTE_PREFIX), 'sent as an app note, not as the learner speaking');

  session.stop();
});

function inputTranscriptionMessage(text) {
  return { serverContent: { inputTranscription: { text } } };
}

test('armSilenceNudge is NOT disarmed by a raw sendAudio frame — the client streams mic audio continuously, silence included', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(PAST_TAIL_GUARD);

  const sentBeforeNudge = ws.sent.length;
  session.nudge.delayMs = 30;
  session.armSilenceNudge();

  // The browser client sends mic frames unconditionally, even while silent —
  // a raw frame must not be mistaken for the learner actually speaking.
  session.sendAudio('silent-mic-frame-the-client-sends-regardless');
  const nudgeFrames = await waitForNudge(ws, sentBeforeNudge);
  assert.equal(nudgeFrames.length, 1, 'a raw audio frame does not disarm the nudge, so it still fires');

  session.stop();
});

test('armSilenceNudge is disarmed once the learner\'s speech is actually transcribed', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(PAST_TAIL_GUARD);

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
  await delay(PAST_TAIL_GUARD);

  session.nudge.delayMs = 30;
  const before = ws.sent.length;
  session.armSilenceNudge();
  assert.equal((await waitForNudge(ws, before)).length, 1, 'fired once');

  const sentAfterFirstFire = ws.sent.length;
  assert.equal(session.nudge.shouldFire(), false, 'already fired once for this arm');

  await delay(60);
  const nudgeFramesAfterWaiting = ws.sent.slice(sentAfterFirstFire).filter((f) => textOf(f)?.includes('Take your time'));
  assert.equal(nudgeFramesAfterWaiting.length, 0, 'no second nudge without a fresh arm');

  session.stop();
});

test('a nudge timer that fires a moment early re-checks instead of never nudging', async () => {
  const { session, ws } = await startSession();
  ws.emitServerMessage(audioChunkMessage());
  ws.emitServerMessage(turnCompleteMessage()); // greeting
  await delay(PAST_TAIL_GUARD);

  // The clock falls 5 ms behind the timers right after arming, so the
  // timer's first check finds the nudge not yet due.
  let lag = 0;
  session.nudge = new SilenceNudge({ delayMs: 20, now: () => Date.now() - lag });
  const before = ws.sent.length;
  session.armSilenceNudge();
  lag = 5;
  assert.equal((await waitForNudge(ws, before)).length, 1);
  session.stop();
});

test('SilenceNudge reports how long until it is due, and nothing once fired or disarmed', () => {
  let t = 1000;
  const nudge = new SilenceNudge({ delayMs: 100, now: () => t });
  assert.equal(nudge.msUntilDue(), null);
  nudge.arm();
  t += 40;
  assert.equal(nudge.msUntilDue(), 60);
  t += 60;
  assert.equal(nudge.shouldFire(), true);
  assert.equal(nudge.msUntilDue(), null);
  nudge.arm();
  nudge.disarm();
  assert.equal(nudge.msUntilDue(), null);
});
