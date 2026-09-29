// Preload for running the real, unmodified Parley server against the fake
// Gemini in test/harness/fake-gemini.mjs:
//
//   node --import tsx --import ./test/harness/redirect-upstream.mjs server/index.ts
//
// - PARLEY_FAKE_UPSTREAM=ws://127.0.0.1:NNNN  redirects the Live WebSocket
//   (server/live.ts resolves `globalThis.WebSocket` per session, so swapping
//   the global is enough — no server code changes).
// - Every fetch() to generativelanguage.googleapis.com (review / translate /
//   hint / warm-up) is answered locally with a canned, valid review payload,
//   so the harness never touches the network or spends quota.

import { WebSocket as WsWebSocket } from 'ws';

const target = process.env.PARLEY_FAKE_UPSTREAM;
const GOOGLE_WSS = /^wss:\/\/generativelanguage\.googleapis\.com/;

if (target) {
  class RedirectedWebSocket extends WsWebSocket {
    constructor(url, ...rest) {
      super(String(url).replace(GOOGLE_WSS, target), ...rest);
    }
  }
  globalThis.WebSocket = /** @type {any} */ (RedirectedWebSocket);
}

const CANNED_REVIEW = JSON.stringify({
  understood: true,
  score: 80,
  scores: { pronunciation: 80, grammar: 80, fluency: 80 },
  corrections: [],
  tip: 'Keep going.',
  words: [],
  name: '',
  endConversation: false,
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const text = process.env.PARLEY_FAKE_REVIEW ?? CANNED_REVIEW;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};
