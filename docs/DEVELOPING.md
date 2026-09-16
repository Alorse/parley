# Developing Parley

Everything you need beyond the four commands in the [README](../README.md).

## Architecture

```
Browser (PWA, no build step)          Node server (ESM, only dependency: ws)
  getUserMedia -> AudioWorklet          holds the API key
  -> PCM16 16 kHz mono                  builds the tutor persona
  <-> WebSocket /live  (JSON control     proxies one upstream Live session per
      frames + base64 PCM audio)         browser connection
                                        /api/review  /api/translate  /api/hint
```

The browser never talks to Google directly. The server owns the key, renders
the tutor prompt, applies the half-duplex microphone gate, and turns each
finished turn into a structured review (score, corrections, words).

- `public/` — plain browser ES modules. No bundler, no framework, no TypeScript.
- `server/` — plain Node ESM. `node server/index.js` is the whole runtime.
- `DESIGN.md` — the visual identity ("Afterglow") and why it is what it is.
- `the design notes` — the build record: wire protocol, tutor persona rules, design
  tokens, definition of done.

## Environment variables (`.env`)

| var | default | meaning |
|---|---|---|
| `GOOGLE_API_KEY` | — | required, server-side only, never sent to the client |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | speech-to-speech model |
| `GEMINI_LIVE_MODEL_FALLBACKS` | `gemini-3.1-flash-live-preview` | comma-separated live models tried in order if the primary fails to complete setup |
| `GEMINI_TEXT_MODEL` | `gemini-3-flash-preview` | review + translate + hint |
| `GEMINI_TEXT_MODEL_FALLBACKS` | `gemini-3.1-flash-lite,gemini-2.5-flash,gemini-3.5-flash` | comma-separated text models tried in order on a 429 (quota) or 503 (overloaded) |
| `TUTOR_VOICE` | `Kore` | prebuilt voice (Kore/Aoede/Puck/Charon/Leda) |
| `PORT` | `8080` | listens on 127.0.0.1 |
| `ACCESS_TOKENS` | empty | optional comma-separated bearer tokens (unused if empty) |
| `DATA_DIR` | `.data` | where the tiny JSON profile store lives |
| `MAX_SESSIONS` | `4` | concurrent `/live` sessions before new ones get `{code:"busy"}` |

`.env` is parsed by a ~20-line hand-rolled parser in `server/config.js` — no
`dotenv` dependency. It is git-ignored; never commit it.

## Model fallback chains

Gemini's free tier enforces a **per-model** daily request quota (429
`RESOURCE_EXHAUSTED`), and any model can occasionally answer 503 ("high demand —
try again later"). Instead of surfacing either as a hard failure,
`server/gemini-client.js`'s `generateContent()` walks `GEMINI_TEXT_MODEL_FALLBACKS`
in order — review, translate and hint all use the same chain — and
`server/index.js` does the equivalent for `GEMINI_LIVE_MODEL_FALLBACKS` when a
`/live` session fails to complete upstream setup. The first model that works
wins; the user only sees an error if the whole chain fails.

## Node version

The app runs on Node **20.11+** and later. Node ≥ 22 ships a global `WebSocket`;
Node 20 does not, so `server/live.js` uses the global when present and otherwise
falls back to the `ws` package we already depend on.

Worth knowing: the `node` in your shell and the `node` that runs the service can
be **different binaries**. A regression that only breaks on the older runtime
(e.g. relying on the global `WebSocket`) will pass every test you run from your
shell and still take the running app down. Sanity-check with the exact binary
you actually run:

```bash
/usr/bin/node --version
/usr/bin/node --test test/*.test.js
```

## Testing

```bash
npm test    # node:test — config parsing, tutor prompt, protocol codec,
            # half-duplex gating, review parsing. No network calls, fast.

npm run e2e # real end-to-end against the live Gemini API: spawns the server,
            # opens /live, streams real TTS-generated speech, asserts
            # transcript + audio + turn-complete, then checks /api/review.
            # The speech fixture is generated once with
            # gemini-2.5-flash-preview-tts and cached at
            # test/fixtures/speech.pcm — later runs are offline for that part
            # (the /live and /api/review calls still hit the real API).

npm run browser-check   # real headless Chrome: launches with a FAKE MICROPHONE
            # (a looping WAV via --use-fake-device-for-media-stream), drives
            # the actual page over the DevTools Protocol — clicks the mic,
            # waits, samples DOM state — and writes screenshots + report.json.
            # Proves getUserMedia, AudioWorklet, canvas rendering and the
            # websocket session work in a real browser, which the other two
            # cannot (they never load a page).
            # The fake-mic WAV isn't committed — it's built on demand by
            # scripts/make-fake-mic.mjs from the already-cached
            # test/fixtures/speech.pcm padded with silence.
            # Usage: node scripts/browser-check.mjs [url] [wav] [outdir]
            #   [--mobile|--desktop] [--seconds N]
```

## Testing the mic in a browser

1. Run the server and open it over `localhost` or HTTPS (mic access requires a
   secure context — plain `http://<lan-ip>` will not work).
2. Tap the microphone. The browser prompts for permission, and that tap is also
   the user gesture that unlocks audio playback (important on iOS Safari).
3. Say something. Your words should appear as a live transcript, Parley replies
   out loud, and a score lands a moment later.
4. If permission is denied the app shows: *"I couldn't hear you — check the
   microphone permission."*

## Serving updates without stale caches

There is no build step, so filenames never change between releases and any cache
keyed on the URL alone (a CDN edge, or the browser) can serve a **fresh
`index.html` with a stale `styles.css` or `app.js`**. That is a real failure
mode, not a theoretical one. The defences, in order:

1. **Version the entry assets.** `index.html` is the one document that is not
   cached long, so the cache key lives there: bump `?v=N` on `/styles.css` and
   `/app.js` in `public/index.html`, and on the
   `serviceWorker.register('/sw.js?v=N')` call in `public/app.js`. Bump it on
   every release that touches them.
2. **Bump `CACHE_NAME` in `public/sw.js`** (`parley-vN`). The service worker's
   `activate` handler deletes every other cache — that is what evicts the
   previous release from devices that already installed it.
3. **Serve an `ETag`** (the server does) so an intermediary can revalidate
   instead of holding a copy until its TTL runs out.
4. **Verify after restarting the app** that origin and edge agree:

```bash
o=$(curl -s http://127.0.0.1:8080/app.js | sha256sum)
e=$(curl -s https://<your-host>/app.js?v=3 | sha256sum)   # must match
```

Two more service-worker rules, both learned the hard way:

- `cache.addAll()` is **all-or-nothing**. One shell entry that 404s rejects the
  install forever, and the previously installed worker keeps running. Add shell
  entries individually and tolerate failures (see `public/sw.js`).
- A device that already has the previous worker shows the new build on its
  **second** load: the first navigation is still served by the old worker, which
  installs the new one.

## Repo layout

```
server/    config.js, tutor.js, live.js, review.js, translate.js,
           gemini-client.js, store.js, index.js
public/    index.html, styles.css, app.js, live-client.js, audio-capture.js,
           pcm-worklet.js, audio-player.js, orb.js, icons.js, data.js,
           manifest.webmanifest, sw.js, icons/, fonts/
scripts/   make_icons.py, e2e-live.mjs, browser-check.mjs, make-fake-mic.mjs
test/      *.test.js, fixtures/speech.pcm (fixtures/fake-mic.wav is generated,
           not committed — see scripts/make-fake-mic.mjs)
assets/    screenshot.png
```
