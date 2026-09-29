#!/usr/bin/env node
// Browser-level reproduction harness for the "two voices at once / freeze"
// (#13) and "misheard, asks to repeat what I never said" (#14) reports.
//
// Runs the REAL page in headless Chrome with a fake microphone, against the
// real, unmodified server, but with Gemini replaced by the scriptable fake in
// test/harness/fake-gemini.mjs — deterministic, offline, no quota. Each
// scenario is a user action sequence; the page is instrumented (before any
// app code runs) to record:
//
//   - every AudioBufferSourceNode scheduled for playback, with the upstream
//     session that produced it (the fake fills each session's PCM with its
//     own constant sample value) -> were two sessions' voices mixed?
//   - every /live WebSocket opened/closed, and every mic frame sent on it
//   - every getUserMedia stream and whether its tracks are still live
//   - for each 'state: listening' message (the moment the server re-opens
//     the mic) and each time the screen starts saying "Listening…", how much
//     tutor audio is still to be heard (output latency included), and every
//     mic frame sent while it is -> the window in which Parley's own voice
//     can leak back into the mic.
//
// Usage:
//   node scripts/repro-browser.mjs [scenario ...] [--port N] [--json out.json]
// Scenarios: double-tap, server-restart, end-restart, echo-window,
//            echo-bluetooth, screen-reader, upstream-drop-twice, upstream-lost, two-tabs, idle-cpu   (default: all)
//
// Needs Chrome/Chromium (CHROME_PATH or the usual locations). The scratch
// server is started on a free port (or --port) and stopped by PID only.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { generateFakeMic } from './make-fake-mic.mjs';
import { startFakeGemini } from '../test/harness/fake-gemini.mjs';
import { startParley, freePort } from '../test/harness/server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const ALL = ['double-tap', 'server-restart', 'end-restart', 'echo-window', 'echo-bluetooth', 'screen-reader', 'upstream-drop-twice', 'upstream-lost', 'two-tabs', 'idle-cpu'];
const flagValues = new Set([flag('--port'), flag('--json')]);
const requested = argv.filter((a) => !a.startsWith('--') && !flagValues.has(a));
const scenarios = requested.length ? requested : ALL;
const fixedPort = flag('--port') ? Number(flag('--port')) : undefined;
const jsonOut = flag('--json');

const WAV = path.join(ROOT, 'test/fixtures/fake-mic.wav');
if (!existsSync(WAV)) generateFakeMic();

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) {
  console.error('No Chrome/Chromium found; set CHROME_PATH.');
  process.exit(2);
}

// Injected before any page script. Kept dependency-free and defensive: it
// must never change app behaviour, only observe it.
const INSTRUMENT = `(() => {
  const P = (window.__parley = { sources: [], sockets: [], streams: [], listening: [], listeningShown: [], states: [], rafCalls: 0, framesWhilePlaying: 0, srStatus: [], srLines: [] });
  // Tutor audio still to be heard on this device, in ms (negative: heard
  // that long ago), counting the device's output latency.
  const stillToPlayMs = () => {
    const ctx = P.lastCtx;
    if (!ctx) return null;
    const maxEnd = Math.max(0, ...(ctx.__ends || [0]));
    return Math.round((maxEnd + (ctx.outputLatency || 0) - ctx.currentTime) * 1000);
  };
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    try {
      const ctx = this.context;
      if (!ctx.__pid) ctx.__pid = Math.random().toString(36).slice(2, 7);
      const b = this.buffer;
      const tag = b ? Math.round(b.getChannelData(0)[0] * 32768 / 100) * 100 : 0;
      const at = Math.max(when, ctx.currentTime);
      const rec = { ctx: ctx.__pid, at, end: at + (b ? b.duration : 0), tag, wall: performance.now() };
      P.sources.push(rec);
      (ctx.__ends = ctx.__ends || []).push(rec.end);
      P.lastCtx = ctx;
    } catch (e) {}
    return origStart.call(this, when, ...rest);
  };
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(url, ...rest) {
      super(url, ...rest);
      const rec = { url: String(url), opened: null, closed: null, framesSent: 0, firstFrameAt: null, lastFrameAt: null };
      P.sockets.push(rec);
      this.addEventListener('open', () => (rec.opened = performance.now()));
      this.addEventListener('close', () => (rec.closed = performance.now()));
      this.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'state') {
            P.states.push({ value: m.value, wall: performance.now() });
            if (m.value === 'listening' && P.lastCtx) {
              P.listening.push({ stillToPlayMs: stillToPlayMs(), outputLatencyMs: Math.round((P.lastCtx.outputLatency || 0) * 1000), wall: performance.now() });
            }
          }
        } catch (err) {}
      });
      const origSend = this.send.bind(this);
      this.send = (data) => {
        try {
          if (typeof data === 'string' && data.startsWith('{"type":"audio"')) {
            rec.framesSent++;
            if ((stillToPlayMs() ?? -1) > 0) P.framesWhilePlaying++;
            const now = performance.now();
            if (rec.firstFrameAt === null) rec.firstFrameAt = now;
            rec.lastFrameAt = now;
          }
        } catch (err) {}
        return origSend(data);
      };
    }
  };
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await origGUM(c);
    P.streams.push(s);
    return s;
  };
  // When the screen starts saying "Listening…", how much tutor audio is
  // still to be heard.
  document.addEventListener('DOMContentLoaded', () => {
    const line = document.getElementById('status-line');
    if (!line) return;
    new MutationObserver(() => {
      if (line.textContent === 'Listening…') P.listeningShown.push(stillToPlayMs());
    }).observe(line, { childList: true, characterData: true, subtree: true });
    // What a screen reader is given: the turn cues and the finished lines.
    const status = document.getElementById('sr-status');
    const log = document.getElementById('sr-transcript');
    if (status) new MutationObserver(() => status.textContent && P.srStatus.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
    if (log) new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => P.srLines.push(n.textContent)))).observe(log, { childList: true });
  });
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { P.rafCalls++; return origRaf(cb); };
  P.summary = () => {
    const now = performance.now();
    const liveTracks = P.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;
    const liveSockets = P.sockets.filter((s) => s.url.endsWith('/live') && s.opened !== null && s.closed === null).length;
    // Frames/s over the last 2 s, across every socket.
    const tags = [...new Set(P.sources.map((s) => s.tag))].filter(Boolean);
    // "Interleaved": within one AudioContext, consecutive scheduled buffers
    // alternate between upstream sessions A,B,A... i.e. two voices chopped
    // together into one stream.
    let switches = 0;
    const byCtx = {};
    for (const s of P.sources) (byCtx[s.ctx] = byCtx[s.ctx] || []).push(s);
    for (const list of Object.values(byCtx)) {
      list.sort((a, b) => a.at - b.at);
      for (let i = 2; i < list.length; i++) if (list[i].tag === list[i - 2].tag && list[i].tag !== list[i - 1].tag) switches++;
    }
    return {
      liveMicTracks: liveTracks,
      getUserMediaCalls: P.streams.length,
      liveSockets,
      socketsOpened: P.sockets.filter((s) => s.url.endsWith('/live')).length,
      framesSent: P.sockets.map((s) => s.framesSent),
      upstreamSessionsHeard: tags.length,
      interleavedSwitches: switches,
      listeningStillToPlayMs: P.listening.map((l) => l.stillToPlayMs),
      listeningShownStillToPlayMs: P.listeningShown,
      micFramesSentWhilePlaying: P.framesWhilePlaying,
      outputLatencyMs: P.listening.map((l) => l.outputLatencyMs),
      states: P.states.map((s) => s.value).join(','),
      status: document.getElementById('status-line')?.textContent,
      micStatus: document.getElementById('mic-status')?.textContent,
      error: document.getElementById('error-card')?.classList.contains('hidden') ? null : document.getElementById('error-message')?.textContent,
      now,
    };
  };
})();`;

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.console.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      }
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  summary() {
    return this.eval('window.__parley.summary()');
  }
  click(id) {
    return this.eval(`document.getElementById(${JSON.stringify(id)}).click()`);
  }
}

async function launchChrome() {
  const cdpPort = await freePort();
  const profile = path.join(ROOT, 'tmp/repro-chrome-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      break;
    } catch {
      await sleep(150);
    }
  }
  return {
    async newPage(url) {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
      const target = await r.json();
      const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      const page = new Page(ws);
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
      await page.send('Page.navigate', { url });
      await sleep(1500);
      return page;
    },
    stop() {
      try { process.kill(/** @type {number} */ (proc.pid), 'SIGKILL'); } catch { /* gone */ }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

function framesPerSecond(before, after, seconds) {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return +((sum(after.framesSent) - sum(before.framesSent)) / seconds).toFixed(1);
}

const results = {};

async function withRig(geminiOpts, fn) {
  const gem = await startFakeGemini(geminiOpts);
  let srv = await startParley({ upstreamUrl: gem.url, port: fixedPort });
  const chrome = await launchChrome();
  const rig = {
    gem,
    get srv() { return srv; },
    chrome,
    async restartServer() {
      const port = srv.port;
      await srv.stop();
      srv = await startParley({ upstreamUrl: gem.url, port });
    },
  };
  try {
    return await fn(rig);
  } finally {
    chrome.stop();
    await srv.stop();
    await gem.close();
  }
}

// Normal conversation with realistic pacing (audio sent in a burst,
// turnComplete held until real-time playback would end, 700 ms think time
// — all measured live with scripts/live-probe.mjs). Measures how much tutor
// audio is still to be heard (device output latency included) when the
// server re-opens the mic ('state: listening') and when the screen says
// "Listening…", and how many mic frames were sent while it was still
// playing. Negative = that many ms AFTER playback ended, i.e. the margin.
async function echoWindow({ outputLatencyMs = null } = {}) {
  return withRig({ replySeconds: 4, firstAudioDelayMs: 700, burst: true }, async ({ chrome, srv, gem }) => {
    const page = await chrome.newPage(srv.url);
    if (outputLatencyMs !== null) {
      await page.eval(`Object.defineProperty(AudioContext.prototype, 'outputLatency', { get: () => ${outputLatencyMs / 1000} }), true`);
    }
    await page.click('mic-btn');
    await sleep(25000);
    const s = await page.summary();
    const upstream = gem.sessions[0];
    return {
      expected: 'mic re-opens only after Parley has finished playing (stillToPlay < 0, with margin for network + device output latency)',
      turns: upstream?.replies,
      listeningStillToPlayMs: s.listeningStillToPlayMs,
      listeningShownStillToPlayMs: s.listeningShownStillToPlayMs,
      micFramesSentWhilePlaying: s.micFramesSentWhilePlaying,
      outputLatencyMs: s.outputLatencyMs,
      thinkingStatesSeen: s.states.split(',').filter((v) => v === 'thinking').length,
      states: s.states,
    };
  });
}

// 16 kHz / 512-sample worklet chunks = 31.25 mic frames per second for ONE pipeline.
const ONE_PIPELINE_FPS = 31.25;

const SCENARIOS = {
  // A quick second tap while the first is still connecting / opening the mic.
  async 'double-tap'() {
    return withRig({ replySeconds: 2, firstAudioDelayMs: 300 }, async ({ chrome, srv }) => {
      const page = await chrome.newPage(srv.url);
      await page.eval(`(document.getElementById('mic-btn').click(), setTimeout(() => document.getElementById('mic-btn').click(), 80), true)`);
      await sleep(5000);
      const a = await page.summary();
      await sleep(2000);
      const b = await page.summary();
      // The UI's mic toggle: tap once more to turn the mic "off".
      await page.click('mic-btn');
      await sleep(1500);
      const c1 = await page.summary();
      await sleep(2000);
      const c2 = await page.summary();
      return {
        expected: `1 live mic track, ~${ONE_PIPELINE_FPS} frames/s, 0 after turning the mic off`,
        liveMicTracks: b.liveMicTracks,
        getUserMediaCalls: b.getUserMediaCalls,
        micFramesPerSecond: framesPerSecond(a, b, 2),
        afterTurningMicOff: { micStatus: c2.micStatus, liveMicTracks: c2.liveMicTracks, micFramesPerSecond: framesPerSecond(c1, c2, 2) },
      };
    });
  },

  // The server restarts (a deploy) or the network drops the socket mid-talk;
  // the learner taps the mic again to carry on.
  async 'server-restart'() {
    return withRig({ replySeconds: 2, firstAudioDelayMs: 300 }, async (rig) => {
      const page = await rig.chrome.newPage(rig.srv.url);
      await page.click('mic-btn');
      await sleep(4000);
      await rig.restartServer();
      await sleep(1500);
      const afterDrop = await page.summary();
      await page.click('mic-btn');
      await sleep(4000);
      const a = await page.summary();
      await sleep(2000);
      const b = await page.summary();
      return {
        expected: `after reconnecting: 1 live mic track, ~${ONE_PIPELINE_FPS} frames/s`,
        afterDrop: { micStatus: afterDrop.micStatus, liveMicTracks: afterDrop.liveMicTracks },
        liveMicTracks: b.liveMicTracks,
        getUserMediaCalls: b.getUserMediaCalls,
        micFramesPerSecond: framesPerSecond(a, b, 2),
      };
    });
  },

  // End the conversation and immediately start a new one.
  async 'end-restart'() {
    return withRig({ replySeconds: 4, firstAudioDelayMs: 200 }, async ({ chrome, srv, gem }) => {
      const page = await chrome.newPage(srv.url);
      await page.click('mic-btn');
      await sleep(2500); // mid-greeting
      await page.eval(`(document.getElementById('end-btn').click(), document.getElementById('mic-btn').click(), true)`);
      await sleep(6000);
      const s = await page.summary();
      return {
        expected: '1 live socket, audio from 1 upstream session after the restart, no interleaving',
        liveSockets: s.liveSockets,
        socketsOpened: s.socketsOpened,
        upstreamSessionsOpenAtServer: gem.openSessions().length,
        upstreamSessionsHeard: s.upstreamSessionsHeard,
        interleavedSwitches: s.interleavedSwitches,
        micStatus: s.micStatus,
      };
    });
  },

  // See echoWindow().
  async 'echo-window'() {
    return echoWindow();
  },

  // The same, on a device whose speaker is heard 250 ms late (a Bluetooth
  // speaker or headset; headless Chrome itself reports ~30 ms).
  async 'echo-bluetooth'() {
    return echoWindow({ outputLatencyMs: 250 });
  },

  // What a screen reader user is told during a conversation (#31): the mic
  // button's state, a cue when the turn changes, each finished line once,
  // and no live region over the streaming transcript.
  async 'screen-reader'() {
    return withRig({ replySeconds: 2, firstAudioDelayMs: 700 }, async ({ chrome, srv }) => {
      const page = await chrome.newPage(srv.url);
      const pressed = () => page.eval(`document.getElementById('mic-btn').getAttribute('aria-pressed')`);
      const before = await pressed();
      await page.click('mic-btn');
      await sleep(18000);
      const during = await pressed();
      await page.click('mic-btn');
      await sleep(300);
      const after = await pressed();
      const p = await page.eval(`({ srStatus: window.__parley.srStatus, srLines: window.__parley.srLines, transcriptLive: document.getElementById('transcript').getAttribute('aria-live'), micLabel: document.getElementById('mic-btn').getAttribute('aria-label') })`);
      return {
        expected: 'aria-pressed false/true/false, turn cues, each finished line once, transcript not live',
        micLabel: p.micLabel,
        micPressed: { before, during, after },
        transcriptAriaLive: p.transcriptLive,
        turnCues: p.srStatus,
        linesAnnounced: p.srLines,
        repeatedLines: p.srLines.length - new Set(p.srLines).size,
      };
    });
  },

  // Gemini drops the connection twice (observed live: close 1011 after ~8 min).
  async 'upstream-drop-twice'() {
    return withRig({ replySeconds: 2, firstAudioDelayMs: 300 }, async ({ chrome, srv, gem }) => {
      const page = await chrome.newPage(srv.url);
      await page.click('mic-btn');
      await sleep(4000);
      gem.sessions.at(-1).drop();
      await sleep(4000);
      const afterFirst = await page.summary();
      gem.sessions.at(-1).drop();
      await sleep(1500);
      const a = await page.summary();
      const upstreamFramesBefore = gem.sessions.reduce((n, s) => n + s.audioFrames.length, 0);
      await sleep(10000);
      const b = await page.summary();
      const upstreamFramesAfter = gem.sessions.reduce((n, s) => n + s.audioFrames.length, 0);
      const health = await (await fetch(`${srv.url}/api/health`)).json();
      return {
        expected: 'recover, or end the session clearly (socket closed, mic off); never keep streaming into nothing',
        kickoffTurnsSent: gem.sessions.map((s) => s.textTurns.filter((t) => t.text.includes('opened the app')).length),
        resumptionHandleUsedOnReconnect: Boolean(gem.sessions[1]?.setup?.sessionResumption?.handle),
        afterFirstDrop: { status: afterFirst.status, error: afterFirst.error },
        afterSecondDrop: {
          status: b.status,
          micStatus: b.micStatus,
          error: b.error,
          liveSockets: b.liveSockets,
          micFramesPerSecondStillSent: framesPerSecond(a, b, 10),
          framesReachingGeminiIn10s: upstreamFramesAfter - upstreamFramesBefore,
          serverActiveSessions: health.activeSessions,
        },
      };
    });
  },

  // Gemini drops the connection and cannot be reached again.
  async 'upstream-lost'() {
    return withRig({ replySeconds: 2, firstAudioDelayMs: 300 }, async ({ chrome, srv, gem }) => {
      const page = await chrome.newPage(srv.url);
      await page.click('mic-btn');
      await sleep(4000);
      gem.options.rejectConnections = true;
      gem.sessions.at(-1).drop();
      await sleep(6000);
      const a = await page.summary();
      await sleep(3000);
      const b = await page.summary();
      const health = await (await fetch(`${srv.url}/api/health`)).json();
      return {
        expected: 'within a few seconds: socket closed, mic off, a clear message, slot freed',
        status: b.status,
        micStatus: b.micStatus,
        error: b.error,
        liveSockets: b.liveSockets,
        liveMicTracks: b.liveMicTracks,
        micFramesPerSecondStillSent: framesPerSecond(a, b, 3),
        serverActiveSessions: health.activeSessions,
      };
    });
  },

  // The app open in two tabs (or the installed app plus a browser tab).
  async 'two-tabs'() {
    return withRig({ replySeconds: 4, firstAudioDelayMs: 200 }, async ({ chrome, srv }) => {
      const p1 = await chrome.newPage(srv.url);
      const p2 = await chrome.newPage(srv.url);
      await p1.click('mic-btn');
      await p2.click('mic-btn');
      await sleep(4000);
      const [a, b] = await Promise.all([p1.summary(), p2.summary()]);
      return {
        expected: 'only one tab holds a live conversation at a time',
        tab1: { liveSockets: a.liveSockets, liveMicTracks: a.liveMicTracks, status: a.status, error: a.error },
        tab2: { liveSockets: b.liveSockets, liveMicTracks: b.liveMicTracks, status: b.status, error: b.error },
      };
    });
  },

  // Main-thread cost while the app sits idle on the Talk screen (no session).
  async 'idle-cpu'() {
    return withRig({}, async ({ chrome, srv }) => {
      const page = await chrome.newPage(srv.url);
      await page.send('Performance.enable');
      const m = async () => Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
      const r0 = await page.eval('window.__parley.rafCalls');
      const m0 = await m();
      await sleep(10000);
      const m1 = await m();
      const r1 = await page.eval('window.__parley.rafCalls');
      return {
        expected: 'near-zero work when idle',
        rafCallbacksPerSecond: +((r1 - r0) / 10).toFixed(1),
        scriptMsPerSecond: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / 10).toFixed(1),
        taskMsPerSecond: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / 10).toFixed(1),
        jsHeapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
      };
    });
  },
};

for (const name of scenarios) {
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario: ${name} (known: ${ALL.join(', ')})`);
    process.exitCode = 2;
    continue;
  }
  process.stdout.write(`\n== ${name} ==\n`);
  try {
    results[name] = await SCENARIOS[name]();
  } catch (err) {
    results[name] = { error: String(err?.stack || err) };
  }
  console.log(JSON.stringify(results[name], null, 2));
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
process.exit(process.exitCode ?? 0);
