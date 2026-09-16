# Parley

Parley is a voice-first English speaking tutor delivered as an installable PWA.
Talk to it out loud (or type), and it replies with real speech, live
transcripts, and short spoken pronunciation/grammar feedback after every turn
— built on the Gemini Live API.

No build step, no framework, no TypeScript: `server/*.js` is plain Node ESM,
`public/*.js` is plain browser ES modules. The only npm dependency is `ws`.

## Architecture

```
Phone browser (PWA)                Node server (ESM, only dep: ws)
  getUserMedia -> AudioWorklet        proxies /live to the Gemini Live API
  -> PCM16 16kHz mono                 renders the tutor persona
  <-> WebSocket /live (JSON +         exposes /api/review, /api/translate,
      base64 PCM audio frames)        /api/hint
```

The browser never talks to Google directly — the server holds the API key,
builds the tutor's system prompt, and proxies one upstream Live session per
browser connection. See `the design notes` for the full design record, including the
exact wire protocol.

## Running it

```bash
npm install          # only installs `ws`
cp .env.example .env # then fill in GOOGLE_API_KEY
npm start             # node server/index.js, listens on 127.0.0.1:8322
```

Open `http://127.0.0.1:8322` in a browser. For a real mic test on a phone
(mic access needs either `localhost` or HTTPS), use the HTTPS URL
below, or `ngrok http 8322` / similar for local phone testing.

### The Node-version trap

Node **>= 22** ships a global `WebSocket`; Node 20 does not. `server/live.js`
uses the global `WebSocket` when present and otherwise falls back to the
`ws` package we already depend on (`resolveWebSocketImpl()`), so the app
runs correctly on Node 20.11+ through the latest LTS.

The trap: **your interactive shell's `node` and the the service manager unit's `node`
can silently be different binaries.** This box's shell resolves `node` to a
v26 install, while the production unit's `ExecStart=/usr/bin/node` is
v20.20.2. A regression that only breaks on the older global-`WebSocket`-less
runtime will pass every local test run and still take the live site down.
Always sanity-check with the exact binary the unit runs:

```bash
/usr/bin/node --version
/usr/bin/node --test test/*.test.js
/usr/bin/node scripts/e2e-live.mjs
```

### Environment variables (`.env`)

| var | default | meaning |
|---|---|---|
| `GOOGLE_API_KEY` | — | required, server-side only, never sent to the client |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | speech-to-speech model |
| `GEMINI_LIVE_MODEL_FALLBACKS` | `gemini-3.1-flash-live-preview` | comma-separated live models tried in order if the primary fails to complete setup |
| `GEMINI_TEXT_MODEL` | `gemini-3.8-flash` | review + translate + hint |
| `GEMINI_TEXT_MODEL_FALLBACKS` | `gemini-3.1-flash-lite,gemini-2.5-flash,gemini-3.5-flash` | comma-separated text models tried in order on a 429 (quota) or 503 (overloaded) |
| `TUTOR_VOICE` | `Kore` | prebuilt voice (Kore/Aoede/Puck/Charon/Leda) |
| `PORT` | `8322` | listens on 127.0.0.1 (a tunnel/reverse proxy terminates TLS) |
| `ACCESS_TOKENS` | empty | optional comma-separated bearer tokens (unused if empty) |
| `DATA_DIR` | `.data` | where the tiny JSON profile store lives |
| `MAX_SESSIONS` | `4` | concurrent `/live` sessions before new ones get `{code:"busy"}` |

`.env` is parsed by a ~20-line hand-rolled parser in `server/config.js` — no
`dotenv` dependency. It is git-ignored; never commit it.

### Model fallback chains

Gemini's free tier enforces a **per-model** daily request quota (429
`RESOURCE_EXHAUSTED`), and any model can occasionally answer 503
("high demand — try again later"). Rather than surface either as a hard
failure, `server/gemini-client.js`'s `generateContent()` walks
`GEMINI_TEXT_MODEL_FALLBACKS` in order — review/translate/hint all use the
same chain — and `server/index.js` does the equivalent for
`GEMINI_LIVE_MODEL_FALLBACKS` when a `/live` session fails to complete
upstream setup. First model that actually works wins; the failure is only
surfaced to the user if every model in the chain fails.

## Testing

```bash
npm test    # node:test — config parsing, tutor prompt, protocol codec,
            # half-duplex gating, review parsing. No network calls, fast.

npm run e2e # real end-to-end against the live Gemini API: spawns the
            # server, opens /live, streams real TTS-generated speech,
            # asserts transcript + audio + turn-complete, then checks
            # /api/review. The speech fixture is generated once with
            # gemini-2.5-flash-preview-tts and cached at
            # test/fixtures/speech.pcm — later runs are fast/offline for
            # that part (the /live and /api/review calls still hit the
            # real API).

npm run browser-check  # real headless-Chrome check: launches Chrome with a
            # FAKE MICROPHONE (a looping WAV, --use-fake-device-for-media-
            # stream), drives the actual page over the DevTools Protocol —
            # click the mic, wait, sample DOM state — and saves screenshots
            # + a report.json. Proves getUserMedia, AudioWorklet, canvas
            # rendering, and the WS session all work in a real browser,
            # which npm test / npm run e2e cannot (they never load a page).
            # Needs Chrome/Chromium installed; not part of the fast suite.
            # Usage: node scripts/browser-check.mjs [url] [wav] [outdir]
            #   [--mobile|--desktop] [--seconds N]
            # Defaults: http://127.0.0.1:8322, test/fixtures/fake-mic.wav,
            # tmp/browser-check (git-ignored).
```

## Testing the mic in a browser

1. Run the server (`npm start`) and open it over `localhost` or HTTPS (mic
   access requires a secure context — plain `http://<lan-ip>` won't work).
2. Tap the microphone. The browser will prompt for mic permission — that tap
   is the user gesture that unlocks audio playback too (important on iOS
   Safari).
3. Say something. You should see your words appear as a live transcript,
   hear Parley reply, and see a score pill land a moment later.
4. If permission is denied, the app shows: *"I couldn't hear you — check the
   microphone permission."*

If you can't get to a real device, `chrome://flags` "fake microphone" plus a
loopback test file also works for a quick smoke test, but only a real mic
proves the AudioWorklet resampling and half-duplex gating end to end.

## release shape (`localhost`)

Parley runs as a the service manager unit bound to `127.0.0.1:8322`, with `reverse proxy`
terminating TLS and tunnelling `https://localhost` to it. See
`the app service` and `the reverse-proxy service` — those are
copies of what actually runs in production:

```
WorkingDirectory=the project directory
EnvironmentFile=the project directory/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
MemoryMax=512M
```

To release: copy the unit files into `/etc/the service manager/system/`, `the service manager
daemon-reload`, `the service manager enable --now parley reverse proxy-parley`. The app
itself has no build step — `git pull && the service manager restart parley` is the
whole update.

## Repo layout

```
server/    config.js, tutor.js, live.js, review.js, translate.js,
           gemini-client.js, store.js, index.js
public/    index.html, styles.css, app.js, live-client.js,
           audio-capture.js, pcm-worklet.js, audio-player.js, orb.js,
           icons.js, data.js, manifest.webmanifest, sw.js, icons/, fonts/
scripts/   make_icons.py, e2e-live.mjs
test/      *.test.js, fixtures/speech.pcm
    the app service, the reverse-proxy service
```

See `the design notes` for the full design record (wire protocol, tutor persona
rules, design tokens, and the definition of done this build was checked
against).
