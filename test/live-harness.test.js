// Integration tests for the /live session lifecycle: the REAL server
// (server/index.ts, unmodified) talking to a scriptable fake Gemini Live
// upstream (test/harness/fake-gemini.mjs). No network, no quota.
//
// Tests marked `todo` pin down confirmed, not-yet-fixed bugs from the
// stability review (#13 two voices / freeze, #14 asks to repeat phrases the
// learner never said). node:test runs them and reports them as TODO without
// failing the suite; once a fix lands they start passing and the `todo`
// marker should be removed in the same change, turning them into regression
// tests. See scripts/repro-browser.mjs for the browser-side counterparts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startFakeGemini, tagOfChunk } from './harness/fake-gemini.mjs';
import { startParley } from './harness/server.mjs';
import { GeminiLiveSession, buildSetupFrame } from '../server/live.js';
import { buildSystemPrompt } from '../server/tutor.js';

const PERSONA_PREFIX = 'You are Parley';

let gem;
let srv;

before(async () => {
  gem = await startFakeGemini({ replySeconds: 0.64, pace: 1 });
  srv = await startParley({
    upstreamUrl: gem.url,
    // Names a fix is expected to honour so these scenarios stay fast; they
    // are ignored by the current server.
    env: { PARLEY_SETUP_TIMEOUT_MS: '1000', PARLEY_TURN_WATCHDOG_MS: '1500', MAX_SESSIONS: '50' },
  });
});

after(async () => {
  await srv?.stop();
  await gem?.close();
});

function resetFake(overrides = {}) {
  Object.assign(gem.options, {
    replySeconds: 0.64,
    pace: 1,
    firstAudioDelayMs: 0,
    setupDelayMs: 0,
    neverCompleteSetup: false,
    omitTurnComplete: false,
    ...overrides,
  });
}

async function connect() {
  const ws = new WebSocket(srv.wsUrl);
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    events.push({ at: Date.now(), ...m, ...(m.type === 'audio' ? { tag: tagOfChunk(m.data), data: undefined } : {}) });
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise((resolve) => ws.once('close', resolve));
  return { ws, events, closed };
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}

const newSessions = (base) => gem.sessions.slice(base);
const LOUD_FRAME = (() => {
  const b = Buffer.alloc(1024);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 8000 : -8000, i);
  return b.toString('base64');
})();

function streamMic(ws, ms = 32) {
  const iv = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'audio', data: LOUD_FRAME }));
  }, ms);
  return () => clearInterval(iv);
}

async function health() {
  return (await fetch(`${srv.url}/api/health`)).json();
}

// --- baseline: behaviour that already works and must keep working ---------

test('one start opens exactly one upstream session, and every audio chunk the client gets comes from it', async () => {
  resetFake();
  const base = gem.sessions.length;
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  assert.ok(await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening')), 'greeting completes');
  const mine = newSessions(base);
  assert.equal(mine.length, 1);
  const tags = new Set(events.filter((e) => e.type === 'audio').map((e) => e.tag));
  assert.deepEqual([...tags], [mine[0].id * 1000]);
  ws.close();
});

test('the persona prompt is sent once, and mic audio is held back until the greeting has played', async () => {
  resetFake({ firstAudioDelayMs: 300 });
  const base = gem.sessions.length;
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  const stop = streamMic(ws);
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'));
  stop();
  const [s] = newSessions(base);
  assert.equal(s.textTurns.filter((t) => t.text.startsWith(PERSONA_PREFIX)).length, 1);
  const turnDone = events.find((e) => e.type === 'output-text' && e.final).at;
  assert.equal(s.audioFrames.filter((f) => f.at < turnDone).length, 0, 'no mic frame reached Gemini during the greeting');
  ws.close();
});

// --- #13: upstream drop / reconnect ----------------------------------------

test('#13 a dropped upstream resumes the same conversation instead of starting over', { todo: 'resume with the session handle; do not resend the persona prompt' }, async () => {
  resetFake();
  const base = gem.sessions.length;
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'));
  newSessions(base)[0].drop(1011, 'Internal error encountered.');
  assert.ok(await waitFor(() => newSessions(base).length === 2 && newSessions(base)[1].setup), 'server reconnects');
  await delay(200);
  const second = newSessions(base)[1];
  try {
    assert.equal(second.setup.sessionResumption?.handle, `handle-${newSessions(base)[0].id}`, 'reconnect should resume with the last handle');
    assert.equal(second.textTurns.filter((t) => t.text.startsWith(PERSONA_PREFIX)).length, 0, 'resumed session must not be re-greeted with the persona prompt');
  } finally {
    ws.close();
  }
});

test('#13 mic audio is held back while a reconnect re-establishes the session', { todo: 're-close the mic gate before the reconnect' }, async () => {
  resetFake({ firstAudioDelayMs: 600 });
  const base = gem.sessions.length;
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'), 4000);
  const stop = streamMic(ws);
  await delay(200);
  newSessions(base)[0].drop();
  await waitFor(() => (newSessions(base)[1]?.replyStarts.length ?? 0) > 0, 4000);
  stop();
  const second = newSessions(base)[1];
  try {
    const firstReplyAudio = second.replyStarts[0];
    const leaked = second.audioFrames.filter((f) => f.at < firstReplyAudio).length;
    assert.equal(leaked, 0, `${leaked} mic frames reached the new session while its opening turn was still pending`);
  } finally {
    ws.close();
  }
});

test('#13 when the upstream drops, the client is told to drop the queued audio of the lost turn', { todo: 'send an interrupted/flush before audio from the new upstream' }, async () => {
  resetFake({ replySeconds: 3 });
  const base = gem.sessions.length;
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.filter((e) => e.type === 'audio').length >= 2);
  newSessions(base)[0].drop();
  await waitFor(() => events.some((e) => e.type === 'audio' && e.tag === (newSessions(base)[1]?.id ?? -1) * 1000), 3000);
  try {
    const firstNewAudio = events.findIndex((e) => e.type === 'audio' && e.tag !== newSessions(base)[0].id * 1000);
    const reconnectIdx = events.findIndex((e) => e.type === 'reconnecting');
    const flushIdx = events.findIndex((e, i) => i > reconnectIdx && e.type === 'interrupted');
    assert.ok(reconnectIdx !== -1 && flushIdx !== -1 && flushIdx < firstNewAudio, 'expected reconnecting -> interrupted -> new audio');
  } finally {
    ws.close();
  }
});

test('#13 once the upstream is lost for good, the session ends cleanly and frees its slot', { todo: 'close the client socket (or recover) instead of leaving a zombie session' }, async () => {
  resetFake();
  const base = gem.sessions.length;
  const { ws, events, closed } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'));
  newSessions(base)[0].drop();
  await waitFor(() => newSessions(base)[1]?.replies > 0);
  const before = (await health()).activeSessions;
  newSessions(base)[1].drop();
  const ended = await Promise.race([closed.then(() => true), delay(2000).then(() => false)]);
  const afterCount = (await health()).activeSessions;
  ws.close();
  assert.ok(ended, 'client socket should be closed (today it stays open, the mic keeps streaming into nothing)');
  assert.equal(afterCount, before - 1, 'the dead session must stop counting against MAX_SESSIONS');
});

test('#13 an upstream that never completes setup fails the session with an error instead of hanging', { todo: 'add a setup timeout (PARLEY_SETUP_TIMEOUT_MS here)' }, async () => {
  resetFake({ neverCompleteSetup: true });
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  const gotError = await waitFor(() => events.some((e) => e.type === 'error'), 2500);
  ws.close();
  assert.ok(gotError, 'client heard nothing at all for 2.5 s');
});

test('#13 the mic re-opens even if a turn never reports turnComplete', { todo: 'add a turn watchdog (PARLEY_TURN_WATCHDOG_MS here)' }, async () => {
  resetFake({ omitTurnComplete: true, replySeconds: 0.32 });
  const base = gem.sessions.length;
  const { ws } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  const stop = streamMic(ws);
  const reached = await waitFor(() => (newSessions(base)[0]?.audioFrames.length ?? 0) > 0, 3000);
  stop();
  ws.close();
  assert.ok(reached, 'the mic stayed gated forever because the greeting turn never completed');
});

test('#13 a client that leaves while the upstream is still being set up does not leak the upstream session', { todo: 'stop the pending candidate when the client socket closes' }, async () => {
  resetFake({ setupDelayMs: 400 });
  const base = gem.sessions.length;
  const { ws } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await delay(100);
  ws.close();
  await delay(1200);
  const open = newSessions(base).filter((s) => s.closedAt === null).length;
  assert.equal(open, 0, `${open} upstream session(s) left open (and greeting nobody) after the client left`);
});

test('#13 a second start on the same socket does not open a second upstream session', { todo: 'ignore or reject a repeated start' }, async () => {
  resetFake();
  const base = gem.sessions.length;
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'));
  await delay(200);
  const tags = new Set(events.filter((e) => e.type === 'audio').map((e) => e.tag));
  ws.close();
  assert.equal(newSessions(base).length, 1, 'two upstream sessions');
  assert.equal(tags.size, 1, 'two voices interleaved into one client');
});

// --- #21: lifecycle records in the journal -----------------------------------

function lifecycleRecords() {
  return srv.logs
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('live-session '))
    .map((l) => JSON.parse(l.slice('live-session '.length)));
}

test('#21 a session writes lifecycle records (open, ready, upstream drop, end) and nothing sensitive', async () => {
  resetFake();
  const base = gem.sessions.length;
  const { ws, events, closed } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'));
  const stop = streamMic(ws);
  await delay(100);
  newSessions(base)[0].drop(1011, 'Internal error encountered (#21).');
  await waitFor(() => events.some((e) => e.type === 'reconnecting'));
  stop();
  ws.close();
  await closed;
  // Other tests drop upstreams too; this one's close reason is unique.
  const mine = () => {
    const all = lifecycleRecords();
    const sid = all.find((r) => r.event === 'upstream-close' && r.reason === 'Internal error encountered (#21).')?.sid;
    return all.filter((r) => r.sid === sid);
  };
  assert.ok(await waitFor(() => mine().some((r) => r.event === 'end')), 'end record written');
  const kinds = mine().map((r) => r.event);
  for (const e of ['open', 'start', 'upstream-ready', 'upstream-close', 'reconnecting', 'end']) assert.ok(kinds.includes(e), `missing ${e} in ${kinds}`);
  const drop = mine().find((r) => r.event === 'upstream-close');
  assert.equal(drop.code, 1011);
  assert.equal(typeof drop.upMs, 'number');
  const end = mine().find((r) => r.event === 'end');
  assert.equal(typeof end.durationMs, 'number');
  assert.ok(end.reconnects >= 1);
  const text = srv.logs.join('');
  assert.ok(!text.includes('harness-fake-key'), 'the API key must never be logged');
  assert.ok(!text.includes(LOUD_FRAME.slice(0, 64)), 'audio must never be logged');
  assert.ok(!text.includes(PERSONA_PREFIX), 'the persona prompt must never be logged');
});

// --- UX: the 'thinking' state ------------------------------------------------

test("the client sees a 'thinking' state between the learner's turn and the tutor's answer", { todo: "the thinking timer is re-armed by every mic frame, so it never fires while the mic streams" }, async () => {
  resetFake({ firstAudioDelayMs: 900, replySeconds: 0.32 });
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => events.some((e) => e.type === 'state' && e.value === 'listening'), 4000);
  // 0.5 s of speech then continuous silence, like a real open mic.
  const quiet = Buffer.alloc(1024).toString('base64');
  let n = 0;
  const iv = setInterval(() => ws.send(JSON.stringify({ type: 'audio', data: n++ < 16 ? LOUD_FRAME : quiet })), 32);
  await waitFor(() => events.filter((e) => e.type === 'state' && e.value === 'speaking').length >= 2, 3500);
  clearInterval(iv);
  ws.close();
  assert.ok(events.some((e) => e.type === 'state' && e.value === 'thinking'));
});

// --- #14: hearing and honesty ------------------------------------------------

class TextOnlyUpstream extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.readyState = TextOnlyUpstream.OPEN;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}
TextOnlyUpstream.OPEN = 1;

test('#14 the silence nudge is spoken as the tutor, never sent as if the learner had said it', { todo: 'the nudge is sent as a user turn today' }, async () => {
  const session = new GeminiLiveSession({ apiKey: 'k', model: 'm', voice: 'Kore', webSocketImpl: TextOnlyUpstream });
  const started = session.start();
  const up = session.ws;
  const ev = new Event('message');
  ev.data = JSON.stringify({ setupComplete: {} });
  up.dispatchEvent(ev);
  await started;
  session.nudge.delayMs = 10;
  session.armSilenceNudge();
  await delay(40);
  session.stop();
  const nudge = up.sent.find((f) => JSON.stringify(f).includes('Take your time'));
  assert.ok(nudge, 'nudge was sent');
  assert.notEqual(nudge.clientContent?.turns?.[0]?.role, 'user', 'the nudge reached the model as the learner speaking');
});

test('#14 the tutor is told to say it did not understand instead of guessing', { todo: 'add an explicit "did not catch that" rule to the persona' }, () => {
  for (const feedbackDetail of ['every-turn', 'mistakes-only']) {
    const prompt = buildSystemPrompt({ feedbackDetail });
    assert.match(prompt, /didn['’]t catch|did not (catch|understand|hear)/i, feedbackDetail);
  }
});

test('#14 the tutor only ever asks the learner to repeat words the learner actually said', { todo: 'the every-turn cadence mandates a fix + "try saying" even for a perfect turn' }, () => {
  const prompt = buildSystemPrompt({ feedbackDetail: 'every-turn' });
  assert.doesNotMatch(prompt, /after every turn the learner speaks, even when they did well/i);
  assert.match(prompt, /never invent a (sentence|phrase)/i);
});

test('#14 the Live setup carries the persona as a system instruction and asks for English transcription', { todo: 'systemInstruction + English language hint (both accepted by gemini-3.8-live, see scripts/live-probe.mjs)' }, () => {
  const setup = /** @type {any} */ (buildSetupFrame({ model: 'm', voice: 'Kore' })).setup;
  assert.ok(setup.systemInstruction, 'persona is sent as a user turn today');
  assert.deepEqual(setup.inputAudioTranscription?.languageCodes, ['en-US']);
});

// --- security ------------------------------------------------------------------

test('ACCESS_TOKENS, when set, is required to open a live session', { todo: 'the variable is parsed but never checked' }, async () => {
  const locked = await startParley({ upstreamUrl: gem.url, env: { ACCESS_TOKENS: 'secret-token' } });
  const base = gem.sessions.length;
  try {
    const ws = new WebSocket(locked.wsUrl);
    await new Promise((resolve) => {
      ws.once('open', resolve);
      ws.once('error', resolve);
      ws.once('unexpected-response', resolve);
    });
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'start' }));
    await delay(500);
    ws.terminate();
    assert.equal(gem.sessions.length - base, 0, 'an unauthenticated client opened a Gemini session');
  } finally {
    await locked.stop();
  }
});
