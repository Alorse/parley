// Parley service worker.
//
// Strategy notes (learned the hard way in production):
// - The shell list must only contain files that EXIST. `cache.addAll()` is
//   all-or-nothing: a single 404 makes the whole install reject, the new
//   service worker never activates, and an older one keeps controlling the
//   page and serving stale markup/assets forever. We therefore add each entry
//   individually and tolerate failures.
// - Bump CACHE_NAME whenever the shell changes: `activate` deletes every other
//   cache, which is what evicts a previous release's assets.
// - Code (HTML/JS/CSS) is NETWORK-FIRST: there is no build step and no
//   content-hashed filenames, so a cache-first shell can pair a fresh
//   index.html with a stale app.js/styles.css after an update. Fonts and
//   icons are immutable enough to serve cache-first.
const CACHE_NAME = 'parley-v5';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/icons.js',
  '/orb.js',
  '/data.js',
  '/live-client.js',
  '/audio-capture.js',
  '/audio-player.js',
  '/pcm-worklet.js',
  '/manifest.webmanifest',
  '/fonts/manrope-latin.woff2',
  '/fonts/manrope-latin-ext.woff2',
  '/fonts/fraunces-latin.woff2',
  '/fonts/fraunces-latin-ext.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.svg',
];

const CODE_EXT = /\.(?:html|js|mjs|css|json|webmanifest)$/;

self.addEventListener('install', (/** @type {ExtendableEvent} */ event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          APP_SHELL.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => {
              // A missing shell entry must never fail the whole install.
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (/** @type {ExtendableEvent} */ event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (/** @type {FetchEvent} */ event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/live') return; // never intercept the live session socket

  if (url.pathname.startsWith('/api/')) {
    // Network-first: the tutor's answers are never something to serve stale.
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    return;
  }

  const isNavigation = request.mode === 'navigate';
  const isCode = CODE_EXT.test(url.pathname);

  if (isNavigation || isCode) {
    // Network-first with a cached fallback: a new release is picked up on the
    // next load, and the app still opens offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))),
    );
    return;
  }

  // Fonts, icons, images: cache-first, refreshing in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
