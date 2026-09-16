import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { GeminiLiveSession, type ReviewRequestPayload } from './live.js';
import { review, type ReviewParams } from './review.js';
import { translate, hint, type TranslateParams, type HintParams } from './translate.js';
import { JsonStore } from './store.js';
import { warmUp } from './warmup.js';
import type { ClientMessage, LiveEventMessage } from './protocol.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const store = new JsonStore(path.join(config.root, config.dataDir));

// Ordered model chains: primary first, then fallbacks. A 429 (quota) or 503
// (overload) on one model falls through to the next instead of failing the
// request/session outright.
const TEXT_MODELS = [config.geminiTextModel, ...config.geminiTextModelFallbacks];
const LIVE_MODELS = [config.geminiLiveModel, ...config.geminiLiveModelFallbacks];

const MIME_TYPES: Record<string, string> = {
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

// No build step means no content-hashed filenames, so any cache in front of the
// app (or a browser) that keys on the URL alone can serve a stale styles.css or
// app.js next to a fresh index.html. HTML and code therefore always revalidate;
// only rarely-changing binary assets (fonts/icons) get a real cache lifetime.
function cacheControlFor(ext: string): string {
  if (ext === '.woff2' || ext === '.png' || ext === '.ico') {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
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
      // A validator lets an intermediary revalidate a cached copy instead of
      // serving it until its TTL runs out, which is how a release can
      // otherwise be served stale for hours.
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

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      const body = (await readJsonBody(req)) as ReviewParams;
      const result = await review({ ...body, apiKey: config.googleApiKey, models: TEXT_MODELS });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/translate') {
      const body = (await readJsonBody(req)) as TranslateParams;
      const result = await translate({ ...body, apiKey: config.googleApiKey, models: TEXT_MODELS });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/hint') {
      const body = (await readJsonBody(req)) as HintParams;
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
    console.error('request error:', errorMessage(err));
    sendJson(res, 500, { error: 'internal error' });
  }
});

const wss = new WebSocketServer({ server, path: '/live' });

interface StoredProfile {
  scenario?: string;
  level?: string;
  voice?: string;
  halfDuplex?: boolean;
  feedbackDetail?: string;
  name?: string;
}

wss.on('connection', (ws) => {
  if (activeSessions >= config.maxSessions) {
    ws.send(JSON.stringify({ type: 'error', message: 'Parley is busy right now — try again in a minute.', code: 'busy' }));
    ws.close();
    return;
  }

  activeSessions += 1;
  let session: GeminiLiveSession | null = null;
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
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === 'start') {
      const profile = store.read<StoredProfile>('profile', {});
      const scenario = msg.scenario ?? profile.scenario ?? 'Just talk';
      const level = msg.level ?? profile.level ?? 'B1';
      const voice = msg.voice ?? profile.voice ?? config.tutorVoice;
      const halfDuplex = msg.halfDuplex ?? profile.halfDuplex ?? true;
      const feedbackDetail = msg.feedbackDetail ?? profile.feedbackDetail ?? 'every-turn';
      const name = msg.name ?? profile.name ?? '';
      store.write('profile', { scenario, level, voice, halfDuplex, feedbackDetail, name });

      // Try each live model in the fallback chain until one actually
      // completes setup — a model-specific outage or quota exhaustion
      // shouldn't take the whole session down. Listeners must be attached
      // before start() so we never miss the initial 'ready'/greeting audio.
      let lastError: unknown;
      for (const liveModel of LIVE_MODELS) {
        const candidate = new GeminiLiveSession({
          apiKey: config.googleApiKey,
          model: liveModel,
          voice,
          scenario,
          level,
          halfDuplex,
          feedbackDetail,
          learnerName: name,
        });

        candidate.on('client', (clientMsg: LiveEventMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(clientMsg));
        });

        candidate.on('review-request', async (turn: ReviewRequestPayload) => {
          try {
            const result = await review({ ...turn, apiKey: config.googleApiKey, models: TEXT_MODELS });
            if (result.corrections.length > 0) candidate.armSilenceNudge();
            if (result.name) candidate.setLearnerName(result.name);
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'review', ...result }));
          } catch (err) {
            console.error('review failed:', errorMessage(err));
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
          console.error(`live session failed to start with model ${liveModel}:`, errorMessage(err));
        }
      }

      if (!session) {
        console.error('live session failed to start on every model fallback:', lastError ? errorMessage(lastError) : undefined);
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
  // Fire-and-forget: don't hold up startup, and a failed warm-up must not
  // affect anything else — see server/warmup.ts.
  if (config.warmupEnabled) {
    void warmUp({ apiKey: config.googleApiKey, models: TEXT_MODELS });
  }
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
