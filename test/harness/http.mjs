import http from 'node:http';

// A raw HTTP request: the body exactly as it crossed the wire. fetch() would
// silently decode a compressed body.
/** @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: Buffer}>} */
export function getRaw(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    http
      .request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject)
      .end();
  });
}
