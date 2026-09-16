import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { GeminiLiveSession } from './live.js';
import { review } from './review.js';
import { translate, hint } from './translate.js';
import { JsonStore } from './store.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const store = new JsonStore(path.join(config.root, config.dataDir));

// Ordered model chains: primary first, then fallbacks. A 429 (quota) or 503
// (overload) on one model falls through to the next instead of failing the
// request/session outright.
const TEXT_MODELS = [config.geminiTextModel, ...config.geminiTextModelFallbacks];
const LIVE_MODELS = [config.geminiLiveModel, ...config.geminiLiveModelFallbacks];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

let activeSessions = 0;

// No build step means no content-hashed filenames, so any CDN/browser that
// caches app.js or styles.css by URL alone can end up serving a stale file
// alongside a fresh index.html after a release — a real incident: Cloudflare's
// default edge cache for .js (4h TTL) once did exactly this and crashed the
// app for real users. HTML and code always revalidate; only rarely-changing
// binary assets (fonts/icons) get a real cache lifetime.
function cacheControlFor(ext) {
  if (ext === '.woff2' || ext === '.png' || ext === '.ico') {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const fullPath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(fullPath);
    const ext = path.extname(fullPath);
    const headers = {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': cacheControlFor(ext),
      // A validator lets an intermediary (Cloudflare) revalidate a cached
      // copy instead of serving it until its TTL runs out, which is how a
      // release can otherwise be served stale for hours.
      etag: `"${createHash('sha1').update(data).digest('hex').slice(0, 32)}"`,
    };
    if (req.headers['if-none-match'] === headers.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': data.length });
    // HEAD must not carry a body (curl -I, health checkers, link previews).
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(config.googleApiKey),
        liveModel: config.geminiLiveModel,
        liveModelFallbacks: config.geminiLiveModelFallbacks,
        textModel: config.geminiTextModel,
        textModelFallbacks: config.geminiTextModelFallbacks,
        activeSessions,
        maxSessions: config.maxSessions,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/review') {
      const body = await readJsonBody(req);
      const result = await review({ ...body, apiKey: config.googleApiKey, models: TEXT_MODELS });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/translate') {
      const body = await readJsonBody(req);
      const result = await translate({ ...body, apiKey: config.googleApiKey, models: TEXT_MODELS });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/hint') {
      const body = await readJsonBody(req);
      const result = await hint({ ...body, apiKey: config.googleApiKey, models: TEXT_MODELS });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error('request error:', err.message);
    sendJson(res, 500, { error: 'internal error' });
  }
});

const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', (ws) => {
  if (activeSessions >= config.maxSessions) {
    ws.send(JSON.stringify({ type: 'error', message: 'Parley is busy right now — try again in a minute.', code: 'busy' }));
    ws.close();
    return;
  }

  activeSessions += 1;
  let session = null;
  let alive = true;

  const pingInterval = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 20000);

  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      const profile = store.read('profile', {});
      const scenario = msg.scenario ?? profile.scenario ?? 'Just talk';
      const level = msg.level ?? profile.level ?? 'B1';
      const voice = msg.voice ?? profile.voice ?? config.tutorVoice;
      const halfDuplex = msg.halfDuplex ?? profile.halfDuplex ?? true;
      const feedbackDetail = msg.feedbackDetail ?? profile.feedbackDetail ?? 'every-turn';
      store.write('profile', { scenario, level, voice, halfDuplex, feedbackDetail });

      // Try each live model in the fallback chain until one actually
      // completes setup — a model-specific outage or quota exhaustion
      // shouldn't take the whole session down. Listeners must be attached
      // before start() so we never miss the initial 'ready'/greeting audio.
      let lastError;
      for (const liveModel of LIVE_MODELS) {
        const candidate = new GeminiLiveSession({
          apiKey: config.googleApiKey,
          model: liveModel,
          voice,
          scenario,
          level,
          halfDuplex,
          feedbackDetail,
        });

        candidate.on('client', (clientMsg) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(clientMsg));
        });

        candidate.on('review-request', async (turn) => {
          try {
            const result = await review({ ...turn, apiKey: config.googleApiKey, models: TEXT_MODELS });
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'review', ...result }));
          } catch (err) {
            console.error('review failed:', err.message);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'review', error: 'Review is unavailable right now.' }));
            }
          }
        });

        try {
          await candidate.start();
          session = candidate;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          candidate.stop();
          console.error(`live session failed to start with model ${liveModel}:`, err.message);
        }
      }

      if (!session) {
        console.error('live session failed to start on every model fallback:', lastError && lastError.message);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Could not reach the tutor right now.' }));
        }
      }
      return;
    }

    if (!session) return;

    if (msg.type === 'audio') session.sendAudio(msg.data);
    else if (msg.type === 'text') session.sendText(msg.text);
    else if (msg.type === 'say') session.say(msg.text);
    else if (msg.type === 'interrupt') session.interrupt();
    else if (msg.type === 'stop') session.stop();
  });

  ws.on('close', () => {
    alive = false;
    clearInterval(pingInterval);
    activeSessions -= 1;
    if (session) session.stop();
  });
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Parley listening on http://127.0.0.1:${config.port}`);
});

function shutdown() {
  console.log('Shutting down...');
  for (const client of wss.clients) client.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server };
