#!/usr/bin/env node
// Latency and weight of a running Parley server, as a user's device sees it:
//   - /live: socket open -> ready -> first greeting audio -> greeting done
//   - /api/review and /api/translate round trips (a few calls each; these
//     spend real text-model quota when the server has a real key)
//   - app shell weight: bytes per asset, and whether the server compresses
//
// Usage: node scripts/perf-api.mjs [baseUrl] [--calls N] [--no-live]
//   baseUrl defaults to http://127.0.0.1:8399 (a scratch server — never
//   point this at production without meaning to spend its quota).

import { WebSocket } from 'ws';

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8399';
const callsIdx = argv.indexOf('--calls');
const CALLS = callsIdx === -1 ? 3 : Number(argv[callsIdx + 1]);
const wsBase = base.replace(/^http/, 'ws');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function liveTiming() {
  const t0 = performance.now();
  const ws = new WebSocket(`${wsBase}/live`);
  const out = {};
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live timing timed out')), 30000);
    ws.on('open', () => {
      out.socketOpenMs = Math.round(performance.now() - t0);
      ws.send(JSON.stringify({ type: 'start', scenario: 'Just talk', level: 'B1', name: 'Ana' }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const now = Math.round(performance.now() - t0);
      if (m.type === 'ready') out.readyMs ??= now;
      if (m.type === 'audio') out.firstAudioMs ??= now;
      if (m.type === 'error') out.error = m.message;
      if (m.type === 'state' && m.value === 'listening') {
        out.greetingDoneMs = now;
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'stop' }));
  ws.close();
  return out;
}

async function timed(path, body) {
  const t0 = performance.now();
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await res.text();
  return { ms: Math.round(performance.now() - t0), status: res.status };
}

async function apiTiming() {
  const review = [];
  const translate = [];
  for (let i = 0; i < CALLS; i++) {
    review.push(await timed('/api/review', { user: `I goed to the market yesterday and buyed ${i + 2} apples.`, assistant: 'Nice!', level: 'B1', learnerName: 'Ana' }));
    // Distinct text each time: the server caches translations.
    translate.push(await timed('/api/translate', { text: `What did you do last weekend, number ${i + 1}?`, to: 'es' }));
  }
  return {
    reviewMs: review.map((r) => r.ms),
    reviewMedianMs: median(review.map((r) => r.ms)),
    translateMs: translate.map((r) => r.ms),
    translateMedianMs: median(translate.map((r) => r.ms)),
    statuses: [...new Set([...review, ...translate].map((r) => r.status))],
  };
}

async function shellWeight() {
  const html = await (await fetch(base + '/')).text();
  const assets = ['/'];
  for (const m of html.matchAll(/(?:href|src)="(\/[^"?#]+)[^"]*"/g)) assets.push(m[1]);
  for (const f of ['/app.js', '/orb.js', '/data.js', '/icons.js', '/live-client.js', '/audio-capture.js', '/audio-player.js', '/pcm-worklet.js', '/sw.js']) assets.push(f);
  const rows = {};
  let total = 0;
  let encoded = 0;
  for (const a of [...new Set(assets)]) {
    const res = await fetch(base + a, { headers: { 'accept-encoding': 'gzip, br' } });
    const buf = Buffer.from(await res.arrayBuffer());
    rows[a] = { bytes: buf.length, encoding: res.headers.get('content-encoding') ?? 'none', cache: res.headers.get('cache-control') };
    total += buf.length;
    if (res.headers.get('content-encoding')) encoded++;
  }
  return { totalKB: +(total / 1024).toFixed(1), assets: Object.keys(rows).length, compressedResponses: encoded, rows };
}

const report = {};
if (!argv.includes('--no-live')) report.live = await liveTiming();
report.api = await apiTiming();
report.shell = await shellWeight();
console.log(JSON.stringify(report, null, 2));
