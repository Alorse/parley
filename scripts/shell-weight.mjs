// App shell weight as it crosses the wire: every asset the page links and
// every code file in the service worker's shell, fetched the way a browser
// asks for it (accepting br/gzip), counting the bytes actually sent.

import { getRaw } from '../test/harness/http.mjs';

export async function shellWeight(base, acceptEncoding = 'gzip, deflate, br') {
  const html = (await getRaw(base + '/')).body.toString();
  const assets = ['/'];
  for (const m of html.matchAll(/(?:href|src)="(\/[^"?#]+)[^"]*"/g)) assets.push(m[1]);
  // The code modules the page imports, as the service worker lists them.
  const sw = (await getRaw(base + '/sw.js')).body.toString();
  const shell = sw.slice(sw.indexOf('APP_SHELL'), sw.indexOf('];'));
  for (const m of shell.matchAll(/'(\/[^']+\.js)'/g)) assets.push(m[1]);
  assets.push('/sw.js');
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
