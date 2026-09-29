#!/usr/bin/env node
// Server cost per live session: runs the real server against the fake
// upstream (test/harness/fake-gemini.mjs, burst replies like the real API)
// and N simulated browsers that stream mic audio exactly like the page does
// (31.25 binary frames per second of 512 PCM16 samples, speaking 1 s then
// silent 2 s so replies keep coming), then samples the server process CPU
// and RSS from /proc, and the payload bytes each way. `--audio json` streams
// JSON/base64 frames instead, like an app from before #24. Offline; Linux only.
//
// Usage: node scripts/perf-server.mjs [--sessions 1,4] [--seconds 20] [--audio binary|json]
//        node scripts/perf-server.mjs --shell   (app shell bytes on the wire,
//          with and without compression accepted)

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startFakeGemini } from '../test/harness/fake-gemini.mjs';
import { startParley } from '../test/harness/server.mjs';
import { shellWeight } from './shell-weight.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const COUNTS = String(arg('--sessions', '1,4')).split(',').map(Number);
const SECONDS = Number(arg('--seconds', 20));
const BINARY = arg('--audio', 'binary') !== 'json';
const CLK_TCK = 100;

function procStat(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]);
  return { cpuTicks, rssKb };
}

const loud = Buffer.alloc(1024);
for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 6000 : -6000, i);
const frame = (pcm) => (BINARY ? pcm : JSON.stringify({ type: 'audio', data: pcm.toString('base64') }));
const LOUD = frame(loud);
const QUIET = frame(Buffer.alloc(1024));

async function run(n) {
  const gem = await startFakeGemini({ replySeconds: 3, burst: true, firstAudioDelayMs: 600 });
  const srv = await startParley({ upstreamUrl: gem.url, env: { MAX_SESSIONS: String(n + 1) } });
  const clients = [];
  let received = 0;
  let receivedBytes = 0;
  let sentBytes = 0;
  try {
    const idle = procStat(srv.pid);
    for (let i = 0; i < n; i++) {
      const ws = new WebSocket(srv.wsUrl);
      ws.on('message', (raw) => {
        received++;
        receivedBytes += raw.length;
      });
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'start', binary: BINARY }));
      let n = 0;
      const iv = setInterval(() => {
        const f = n++ % 94 < 31 ? LOUD : QUIET;
        sentBytes += f.length;
        ws.send(f);
      }, 32);
      clients.push({ ws, iv });
    }
    await sleep(3000); // settle past the greetings
    const a = procStat(srv.pid);
    const t0 = performance.now();
    received = 0;
    receivedBytes = 0;
    sentBytes = 0;
    await sleep(SECONDS * 1000);
    const b = procStat(srv.pid);
    const secs = (performance.now() - t0) / 1000;
    const replies = gem.sessions.reduce((x, s) => x + s.replies, 0);
    return {
      audio: BINARY ? 'binary' : 'json',
      sessions: n,
      serverCpuPct: +(((b.cpuTicks - a.cpuTicks) / CLK_TCK / secs) * 100).toFixed(1),
      rssIdleMB: +(idle.rssKb / 1024).toFixed(1),
      rssLoadedMB: +(b.rssKb / 1024).toFixed(1),
      micFrameWireBytes: LOUD.length,
      micFramePcmBytes: loud.length,
      upstreamKBps: +(sentBytes / 1024 / secs).toFixed(1),
      downstreamMsgsPerSec: +(received / secs).toFixed(1),
      downstreamKBps: +(receivedBytes / 1024 / secs).toFixed(1),
      replies,
    };
  } finally {
    for (const c of clients) {
      clearInterval(c.iv);
      c.ws.close();
    }
    await srv.stop();
    await gem.close();
  }
}

async function shell() {
  const gem = await startFakeGemini();
  const srv = await startParley({ upstreamUrl: gem.url });
  try {
    const compressed = await shellWeight(srv.url);
    const identity = await shellWeight(srv.url, 'identity');
    return { wireKB: compressed.totalKB, identityKB: identity.totalKB, ...compressed };
  } finally {
    await srv.stop();
    await gem.close();
  }
}

if (argv.includes('--shell')) console.log(JSON.stringify(await shell(), null, 2));
else for (const n of COUNTS) console.log(JSON.stringify(await run(n)));
