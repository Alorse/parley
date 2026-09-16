#!/usr/bin/env node
// Real browser-level check for Parley: launches headless Chrome with a FAKE
// MICROPHONE whose input is a looping WAV file, opens the app, drives it
// over the Chrome DevTools Protocol, and collects console errors, a DOM
// snapshot, and screenshots. This proves the real audio path end to end in
// an actual browser — something npm test / npm run e2e cannot do, since
// those never touch getUserMedia, AudioWorklet, or canvas rendering.
//
// This is a manual/exploratory check, not part of the automated test suite
// (it needs Chrome installed and takes ~30-60s). See README.md.
//
// Usage:
//   node scripts/browser-check.mjs [url] [wav] [outdir] [--mobile] [--seconds N]
//
// Defaults: url=http://127.0.0.1:8080, wav=test/fixtures/fake-mic.wav,
// outdir=tmp/browser-check (git-ignored).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

const args = process.argv.slice(2);
const url = args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:8080';
const wav = args[1] && !args[1].startsWith('--') ? args[1] : path.join(ROOT, 'test/fixtures/fake-mic.wav');
const outdir = args[2] && !args[2].startsWith('--') ? args[2] : path.join(ROOT, 'tmp/browser-check');
const mobile = !args.includes('--desktop'); // Parley is phone-first; default to mobile emulation
const secondsFlagIndex = args.indexOf('--seconds');
const seconds = secondsFlagIndex !== -1 ? Number(args[secondsFlagIndex + 1]) || 45 : 45;

if (!existsSync(wav)) {
  console.error(`fake-mic WAV not found: ${wav}`);
  process.exit(2);
}

mkdirSync(outdir, { recursive: true });
const profile = path.join(ROOT, 'tmp/chrome-profile');
rmSync(profile, { recursive: true, force: true });

const CHROME_CANDIDATES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chromeBin = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromeBin) {
  console.error(`No Chrome/Chromium binary found (tried: ${CHROME_CANDIDATES.join(', ')}). Set CHROME_PATH.`);
  process.exit(2);
}

const PORT = 9333;
const W = mobile ? 390 : 1280;
const H = mobile ? 844 : 900;

const chrome = spawn(chromeBin, [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}%noloop`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const die = (msg, code = 1) => {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  console.error(msg);
  process.exit(code);
};

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome still starting up
    }
    await sleep(250);
  }
  die('chrome never came up:\n' + chromeErr.slice(-800));
}

const wsUrl = await cdpTarget();
const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let id = 0;
const pending = new Map();
const consoleMsgs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  } else if (m.method === 'Log.entryAdded') {
    consoleMsgs.push(`[log:${m.params.entry.level}] ${m.params.entry.text}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: r.result?.value };
};

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(outdir, `${name}.png`);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('screenshot:', p);
  return p;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 3 : 2, mobile });
await send('Page.navigate', { url });
await sleep(3500);

console.log('== page ==', JSON.stringify(await evaluate('({title:document.title, url:location.href, ready:document.readyState})')));
console.log('== manifest ==', JSON.stringify(await evaluate(`fetch('/manifest.webmanifest').then(r=>r.status+' '+(r.headers.get('content-type')||''))`)));
console.log('== service worker ==', JSON.stringify(await evaluate(`('serviceWorker' in navigator) ? navigator.serviceWorker.getRegistrations().then(r=>r.length) : 'none'`)));

await shot('01-initial');

const clicked = await evaluate(`(() => {
  const mic = document.getElementById('mic-btn');
  if (!mic) return { ok: false };
  mic.click();
  return { ok: true, tag: mic.tagName, id: mic.id, disabled: mic.disabled };
})()`);
console.log('== click mic ==', JSON.stringify(clicked));

await sleep(9000);
await shot('02-after-start');

const samples = [];
for (let i = 0; i < Math.ceil(seconds / 5); i++) {
  await sleep(5000);
  const s = await evaluate(`(() => {
    const status = document.getElementById('status-line');
    const scorePill = document.getElementById('score-pill');
    return {
      i: ${i},
      status: status ? status.textContent : null,
      micOn: document.getElementById('mic-status')?.textContent,
      scoreVisible: scorePill ? !scorePill.classList.contains('hidden') : false,
      endDisabled: document.getElementById('end-btn')?.disabled,
      transcriptSnippet: document.getElementById('transcript')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200),
    };
  })()`);
  samples.push(s.value);
  console.log(`sample ${i}:`, JSON.stringify(s.value));
  if (i === 1 || i === 3) await shot(`03-sample-${i}`);
}

await shot('04-final');
const finalTxt = await evaluate('document.body.innerText.replace(/\\s+/g," ").trim()');
console.log('== final text ==\n' + (finalTxt.value || '').slice(0, 2000));

const errs = consoleMsgs.filter((m) => /error|exception|failed|refused|denied/i.test(m));
console.log('== console (last 60) ==\n' + consoleMsgs.slice(-60).join('\n'));
console.log('== error-ish console count ==', errs.length);

const turnsSeen = samples.filter((s) => s?.scoreVisible).length;
console.log('== samples with a visible score pill ==', turnsSeen);

writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ url, consoleMsgs, samples, finalTxt: finalTxt.value }, null, 2));
console.log('report written to', path.join(outdir, 'report.json'));

try { chrome.kill('SIGKILL'); } catch { /* already gone */ }

if (!clicked.value?.ok) die('mic button was never found — the app failed to render as expected', 1);
process.exit(0);
