// Static asset compression (#25): negotiation and ETag helpers, then the real
// server answering the way a browser, a CDN and the service worker ask.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { compressed, etagMatches, negotiateEncoding, worthCompressing } from '../server/compress.js';
import { startFakeGemini } from './harness/fake-gemini.mjs';
import { startParley } from './harness/server.mjs';
import { getRaw } from '../scripts/shell-weight.mjs';

test('brotli is preferred, gzip is the fallback, identity when neither is accepted', () => {
  assert.equal(negotiateEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(negotiateEncoding('gzip, deflate'), 'gzip');
  assert.equal(negotiateEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(negotiateEncoding('*'), 'br');
  assert.equal(negotiateEncoding('identity'), null);
  assert.equal(negotiateEncoding('gzip;q=0'), null);
  assert.equal(negotiateEncoding(''), null);
  assert.equal(negotiateEncoding(undefined), null);
});

test('only text assets big enough to benefit are compressed', () => {
  assert.ok(worthCompressing('.js', 30000));
  assert.ok(worthCompressing('.html', 11000));
  assert.ok(!worthCompressing('.js', 500), 'tiny files are not worth it');
  assert.ok(!worthCompressing('.woff2', 60000), 'fonts are already compressed');
  assert.ok(!worthCompressing('.png', 80000), 'images are already compressed');
});

test('If-None-Match matches strong, weak (a CDN may weaken it) and listed tags', () => {
  assert.ok(etagMatches('"abc-br"', '"abc-br"'));
  assert.ok(etagMatches('W/"abc-br"', '"abc-br"'));
  assert.ok(etagMatches('"x", "abc-br"', '"abc-br"'));
  assert.ok(etagMatches('*', '"abc"'));
  assert.ok(!etagMatches('"abc"', '"abc-br"'), 'an identity copy does not validate a brotli one');
  assert.ok(!etagMatches(undefined, '"abc"'));
});

test('a changed file is never served from a stale compression', async () => {
  const v1 = Buffer.from('const version = 1;\n'.repeat(100));
  const v2 = Buffer.from('const version = 2;\n'.repeat(100));
  assert.deepEqual(zlib.brotliDecompressSync(await compressed('/x.js', 'h1', v1, 'br')), v1);
  assert.deepEqual(zlib.brotliDecompressSync(await compressed('/x.js', 'h2', v2, 'br')), v2);
  assert.deepEqual(zlib.gunzipSync(await compressed('/x.js', 'h2', v2, 'gzip')), v2);
});

let gem;
let srv;
before(async () => {
  gem = await startFakeGemini();
  srv = await startParley({ upstreamUrl: gem.url });
});
after(async () => {
  await srv?.stop();
  await gem?.close();
});

const appJs = readFileSync(new URL('../public/app.js', import.meta.url));

test('the server sends code compressed, with Vary and a per-encoding ETag', async () => {
  const br = await getRaw(`${srv.url}/app.js?v=1`, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.equal(br.headers['cache-control'], 'no-cache', 'code still always revalidates');
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.ok(br.body.length < appJs.length / 2);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), appJs);

  const gz = await getRaw(`${srv.url}/app.js`, { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), appJs);

  const plain = await getRaw(`${srv.url}/app.js`);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.deepEqual(plain.body, appJs);

  const tags = new Set([br.headers.etag, gz.headers.etag, plain.headers.etag]);
  assert.equal(tags.size, 3, 'each representation has its own ETag');
});

test('revalidation still answers 304 for the representation the client holds', async () => {
  const first = await getRaw(`${srv.url}/styles.css`, { 'accept-encoding': 'br' });
  const again = await getRaw(`${srv.url}/styles.css`, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers['content-encoding'], 'br');
  const weak = await getRaw(`${srv.url}/styles.css`, { 'accept-encoding': 'br', 'if-none-match': `W/${first.headers.etag}` });
  assert.equal(weak.status, 304, 'a CDN-weakened ETag still validates');
  const other = await getRaw(`${srv.url}/styles.css`, { 'if-none-match': first.headers.etag });
  assert.equal(other.status, 200, 'a brotli ETag does not validate the uncompressed copy');
});

test('fonts and images are sent as they are', async () => {
  const font = await getRaw(`${srv.url}/fonts/manrope-latin.woff2`, { 'accept-encoding': 'br' });
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-encoding'], undefined);
  assert.equal(font.headers.vary, undefined);
  assert.equal(font.headers['cache-control'], 'public, max-age=86400');
});

test('HEAD reports the compressed length without a body', async () => {
  const head = await new Promise((resolve, reject) => {
    const req = http.request(`${srv.url}/app.js`, { method: 'HEAD', headers: { 'accept-encoding': 'br' } }, (res) => {
      let bytes = 0;
      res.on('data', (c) => (bytes += c.length));
      res.on('end', () => resolve({ headers: res.headers, bytes }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(head.bytes, 0);
  assert.equal(head.headers['content-encoding'], 'br');
  assert.ok(Number(head.headers['content-length']) < appJs.length / 2);
});
