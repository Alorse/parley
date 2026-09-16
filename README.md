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

### Environment variables (`.env`)

| var | default | meaning |
|---|---|---|
| `GOOGLE_API_KEY` | — | required, server-side only, never sent to the client |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | speech-to-speech model |
| `GEMINI_TEXT_MODEL` | `gemini-3.8-flash` | review + translate + hint |
| `TUTOR_VOICE` | `Kore` | prebuilt voice (Kore/Aoede/Puck/Charon/Leda) |
| `PORT` | `8322` | listens on 127.0.0.1 (a tunnel/reverse proxy terminates TLS) |
| `ACCESS_TOKENS` | empty | optional comma-separated bearer tokens (unused if empty) |
| `DATA_DIR` | `.data` | where the tiny JSON profile store lives |
| `MAX_SESSIONS` | `4` | concurrent `/live` sessions before new ones get `{code:"busy"}` |

`.env` is parsed by a ~20-line hand-rolled parser in `server/config.js` — no
`dotenv` dependency. It is git-ignored; never commit it.

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
