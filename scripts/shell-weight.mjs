// App shell weight as it crosses the wire: every asset the page and its
// service worker load, fetched the way a browser asks for it (accepting
// br/gzip). Uses node:http rather than fetch, which silently decodes the
// body and would report the uncompressed size.

import http from 'node:http';

const CODE = ['/app.js', '/orb.js', '/data.js', '/icons.js', '/announcer.js', '/live-client.js', '/audio-capture.js', '/audio-player.js', '/pcm-worklet.js', '/sw.js'];

/** @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: Buffer}>} */
export function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

export async function shellWeight(base, acceptEncoding = 'gzip, deflate, br') {
  const html = (await getRaw(base + '/')).body.toString();
  const assets = ['/'];
  for (const m of html.matchAll(/(?:href|src)="(\/[^"?#]+)[^"]*"/g)) assets.push(m[1]);
  assets.push(...CODE);
  const rows = {};
  let total = 0;
  let encoded = 0;
  for (const a of [...new Set(assets)]) {
    const res = await getRaw(base + a, { 'accept-encoding': acceptEncoding });
    const encoding = res.headers['content-encoding'] ?? 'none';
    rows[a] = { bytes: res.body.length, encoding, cache: res.headers['cache-control'], vary: res.headers.vary ?? null };
    total += res.body.length;
    if (encoding !== 'none') encoded++;
  }
  return { totalKB: +(total / 1024).toFixed(1), assets: Object.keys(rows).length, compressedResponses: encoded, rows };
}
