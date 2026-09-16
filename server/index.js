import http from 'node:http';
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
    res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
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
        textModel: config.geminiTextModel,
        activeSessions,
        maxSessions: config.maxSessions,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/review') {
      const body = await readJsonBody(req);
      const result = await review({ ...body, apiKey: config.googleApiKey, model: config.geminiTextModel });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/translate') {
      const body = await readJsonBody(req);
      const result = await translate({ ...body, apiKey: config.googleApiKey, model: config.geminiTextModel });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/hint') {
      const body = await readJsonBody(req);
      const result = await hint({ ...body, apiKey: config.googleApiKey, model: config.geminiTextModel });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET') {
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

      session = new GeminiLiveSession({
        apiKey: config.googleApiKey,
        model: config.geminiLiveModel,
        voice,
        scenario,
        level,
        halfDuplex,
        feedbackDetail,
      });

      session.on('client', (clientMsg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(clientMsg));
      });

      session.on('review-request', async (turn) => {
        try {
          const result = await review({ ...turn, apiKey: config.googleApiKey, model: config.geminiTextModel });
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'review', ...result }));
        } catch (err) {
          console.error('review failed:', err.message);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'review', error: 'Review is unavailable right now.' }));
          }
        }
      });

      try {
        await session.start();
      } catch (err) {
        console.error('live session failed to start:', err.message);
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
