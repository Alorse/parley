import { promisify } from 'node:util';
import zlib from 'node:zlib';

// Text assets (the page, styles, code) shrink to about a third with br/gzip.
// Fonts and PNGs are already compressed, so they are sent as they are.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
// Below this, the encoding overhead is about what it saves.
const MIN_BYTES = 1024;

export type Encoding = 'br' | 'gzip';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export function worthCompressing(ext: string, bytes: number): boolean {
  return COMPRESSIBLE.has(ext) && bytes >= MIN_BYTES;
}

/** The best encoding the client accepts (br over gzip), or null for identity. */
export function negotiateEncoding(acceptEncoding: string | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const wildcard = accepted.get('*') ?? 0;
  for (const enc of ['br', 'gzip'] as const) {
    if ((accepted.get(enc) ?? wildcard) > 0) return enc;
  }
  return null;
}

// Compressed bodies, one entry per file, keyed on the content hash so an
// edited file is never served from a stale compression.
const cache = new Map<string, { hash: string; bodies: Partial<Record<Encoding, Promise<Buffer>>> }>();

export function compressed(file: string, hash: string, data: Buffer, encoding: Encoding): Promise<Buffer> {
  let entry = cache.get(file);
  if (!entry || entry.hash !== hash) {
    entry = { hash, bodies: {} };
    cache.set(file, entry);
  }
  entry.bodies[encoding] ??=
    encoding === 'br'
      ? brotli(data, {
          params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        })
      : gzip(data, { level: 9 });
  return entry.bodies[encoding];
}

/** Whether an If-None-Match header matches the ETag (weak or strong). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}
