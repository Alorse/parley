import { iconMarkup } from './icons.js';
import { Orb, MicWaveform } from './orb.js';
import {
  SCENARIOS,
  SCENARIO_CATEGORIES,
  JUST_TALK,
  masteryTier,
  recordWordSighting,
  searchWords,
  getAllWords,
  getProfile,
  setProfileName,
  getMemoryNote,
  getClientId,
  addConversationMemory,
  buildConversationMemory,
  forgetProfile,
} from './data.js';
import { LiveClient } from './live-client.js';
import { AudioCapture } from './audio-capture.js';
import { AudioPlayer } from './audio-player.js';
import { Announcer, finishedLine, stateCue } from './announcer.js';

const SETTINGS_KEY = 'parley.settings.v1';
const DEFAULT_SETTINGS = {
  voice: 'Kore',
  level: 'B1',
  halfDuplex: true,
  feedbackDetail: 'every-turn',
  saveWords: true,
  textSize: 'M',
};

const VOICES = ['Kore', 'Aoede', 'Puck', 'Charon', 'Leda'];
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
const FEEDBACK_OPTIONS = [
  { value: 'every-turn', label: 'Every turn' },
  { value: 'mistakes-only', label: 'On mistakes' },
];
const TEXT_SIZES = [
  { value: 'S', label: 'S', scale: 0.92 },
  { value: 'M', label: 'M', scale: 1 },
  { value: 'L', label: 'L', scale: 1.15 },
];

const STATUS_TEXT = {
  idle: 'Ready when you are',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Parley is speaking',
  reconnecting: 'Reconnecting…',
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage failures — settings just won't persist this session
  }
}

function applyTextSize(textSize) {
  const found = TEXT_SIZES.find((t) => t.value === textSize) || TEXT_SIZES[1];
  document.documentElement.style.setProperty('--scale', String(found.scale));
}

// null for a start that was cancelled on purpose (another window took the
// conversation over while this one was still connecting): nothing to report.
function micErrorMessage(err) {
  if (err && err.name === 'AbortError') return null;
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return "I couldn't hear you — check the microphone permission.";
  }
  return (err && err.message) || 'Something went wrong. Please try again.';
}

// Untyped on purpose: callers immediately narrow to whatever element kind
// they expect (input, button, select, ...), which a single shared helper
// can't express without a cast at every call site.
/** @returns {any} */
const el = (id) => document.getElementById(id);

const state = {
  screen: 'talk',
  scenario: JUST_TALK,
  settings: loadSettings(),
  profile: getProfile(),
  sessionStarted: false,
  // The half-duplex setting the running conversation was started with.
  sessionHalfDuplex: true,
  micOn: false,
  uiState: 'idle',
  lastTutorText: '',
  lastUserText: '',
  lastReview: null,
  // Accumulated across the current conversation only, to build the one-line
  // memory saved when it ends — see finalizeConversationMemory().
  conversationCorrections: [],
  hadTurn: false,
  // Set when a review comes back with endConversation: true but the
  // goodbye audio hasn't finished playing yet (uiState isn't 'listening')
  // — see the 'state' case below, which acts on it once playback catches up.
  pendingEndConversation: false,
  themesFilter: 'All',
  themesQuery: '',
  wordsQuery: '',
  expandedWord: null,
};

applyTextSize(state.settings.textSize);

// --- static icon pass ----------------------------------------------------

function renderStaticIcons() {
  document.querySelectorAll('[data-icon]').forEach((node) => {
    node.innerHTML = iconMarkup(/** @type {HTMLElement} */ (node).dataset.icon);
  });
}

// --- orb + levels ----------------------------------------------------------

const orb = new Orb(el('orb-canvas'));
const micWaveform = new MicWaveform(el('waveform-canvas'));
const audioCapture = new AudioCapture();
const audioPlayer = new AudioPlayer();
const liveClient = new LiveClient();
const announcer = new Announcer(el('sr-transcript'));

orb.start();
micWaveform.start(() => (state.micOn ? audioCapture.getWaveformData() : null));

function levelLoop() {
  if (state.uiState === 'listening' && state.micOn) {
    orb.setLevel(audioCapture.getLevel());
  } else if (state.uiState === 'speaking') {
    orb.setLevel(audioPlayer.getLevel());
  } else {
    orb.setLevel(0);
  }
  requestAnimationFrame(levelLoop);
}
requestAnimationFrame(levelLoop);

function updateWaveformVisibility() {
  el('waveform-canvas').classList.toggle('hidden', !(state.uiState === 'listening' && state.micOn));
}

// --- screen routing ----------------------------------------------------

function showScreen(name) {
  state.screen = name;
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('hidden', /** @type {HTMLElement} */ (screen).dataset.screen !== name);
  }
  for (const btn of document.querySelectorAll('.tab-btn')) {
    if (/** @type {HTMLElement} */ (btn).dataset.tab === name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (name === 'themes') renderThemeGrid();
  if (name === 'words') renderWords();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => showScreen(/** @type {HTMLElement} */ (btn).dataset.tab));
});

// --- Talk screen: transcript + status ------------------------------------

function updateStatusLine() {
  el('status-line').textContent = STATUS_TEXT[state.uiState] || STATUS_TEXT.idle;
}

// Half-duplex: the mic stays closed until Parley's voice has actually been
// heard out of this device's speaker, plus this much for the room's echo
// (#27). The server keeps its own, estimated guard as well.
const ECHO_TAIL_MS = 250;

function micHoldMs() {
  return state.sessionHalfDuplex ? audioPlayer.msUntilHeard(ECHO_TAIL_MS) : 0;
}

function sendMicChunk(base64) {
  if (micHoldMs() > 0) return;
  liveClient.sendAudio(base64);
}

let listeningTimer = 0;

/** @param {string} value one of the STATUS_TEXT keys */
function setUiState(value) {
  clearTimeout(listeningTimer);
  state.uiState = value;
  updateStatusLine();
  el('sr-status').textContent = stateCue(value);
  orb.setState(value === 'reconnecting' ? 'thinking' : value);
  updateWaveformVisibility();
}

function renderTopicChip() {
  const chip = el('topic-chip');
  if (state.scenario === JUST_TALK) {
    chip.classList.add('hidden');
    return;
  }
  chip.textContent = state.scenario;
  chip.classList.remove('hidden');
}

function updateUserLine(text, final) {
  state.lastUserText = text;
  el('empty-prompt').classList.add('hidden');
  const line = el('user-line');
  el('user-line-text').textContent = text;
  line.classList.toggle('hidden', !text);
  void final;
}

function updateTutorLine(text, final) {
  state.lastTutorText = text;
  el('empty-prompt').classList.add('hidden');
  const line = el('tutor-line');
  line.textContent = text;
  line.classList.remove('hidden');
  line.classList.toggle('streaming', !final);
}

function resetTranscript() {
  state.lastTutorText = '';
  state.lastUserText = '';
  state.lastReview = null;
  el('tutor-line').classList.add('hidden');
  el('tutor-translation').classList.add('hidden');
  el('user-line').classList.add('hidden');
  el('score-pill').classList.add('hidden');
  el('empty-prompt').classList.remove('hidden');
}

// Server error codes whose wording the app owns.
const TAKEN_OVER_MESSAGE = 'Parley is open in another window, so this conversation was closed here.';
const ERROR_TEXT = {
  busy: 'Parley is busy right now — try again in a minute.',
  replaced: TAKEN_OVER_MESSAGE,
};

function showError(message) {
  if (!message) return;
  el('error-message').textContent = message;
  el('error-card').classList.remove('hidden');
}

function hideError() {
  el('error-card').classList.add('hidden');
}

el('error-dismiss').addEventListener('click', hideError);

// --- score pill + sheet --------------------------------------------------

function showScorePillMessage(text) {
  state.lastReview = null;
  el('score-value').classList.add('hidden');
  el('score-meter-track').classList.add('hidden');
  el('score-message').textContent = text;
  el('score-message').classList.remove('hidden');
  el('score-pill').classList.remove('hidden');
  scrollScorePillIntoView();
}

function scrollScorePillIntoView() {
  // The score pill can land below the fold once the transcript grows long;
  // never leave it sitting unseen behind the fixed nav.
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el('score-pill').scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'center' });
}

function handleReview(msg) {
  if (msg.error) {
    showScorePillMessage('No score for that turn');
    return;
  }

  if (msg.understood === false) {
    // Nothing intelligible was said: no number, no meter, and nothing saved
    // to the Words list for this turn — a hallucinated/garbled transcript
    // must not pollute it.
    showScorePillMessage("I didn't catch that — try again");
    return;
  }

  state.lastReview = msg;
  if (Array.isArray(msg.corrections) && msg.corrections.length > 0) {
    state.conversationCorrections.push(...msg.corrections);
  }

  el('score-message').classList.add('hidden');
  el('score-value').classList.remove('hidden');
  el('score-meter-track').classList.remove('hidden');
  el('score-value').textContent = String(msg.score);
  el('score-meter-fill').style.width = `${Math.max(0, Math.min(100, msg.score))}%`;
  el('score-tip').textContent = msg.tip || '';
  el('score-pill').classList.remove('hidden');
  scrollScorePillIntoView();

  if (state.settings.saveWords && Array.isArray(msg.words)) {
    for (const w of msg.words) {
      recordWordSighting({ word: w.word, meaning: w.meaning, sentence: state.lastUserText });
    }
  }

  // The server only ever reports a name here when one wasn't already known
  // (see review.ts's nameInstruction), so this can't clobber a name the
  // learner set by hand in Settings.
  if (msg.name && !state.profile.name) {
    state.profile = setProfileName(state.profile, msg.name);
  }

  // The pair is satisfied: the learner signalled leaving and the tutor
  // answered with its own goodbye (see review.ts's endInstruction). End the
  // same way the End button does, but only once the goodbye has actually
  // finished playing — otherwise wait for the 'state' handler to catch up.
  if (msg.endConversation) {
    if (state.uiState === 'listening') {
      endSession();
    } else {
      state.pendingEndConversation = true;
    }
  }
}

function openScoreSheet() {
  const r = state.lastReview;
  if (!r) return;
  el('score-breakdown').innerHTML = ['pronunciation', 'grammar', 'fluency']
    .map((k) => `<div class="score-metric"><span class="score-metric-value">${r.scores?.[k] ?? 0}</span><span class="score-metric-label">${k}</span></div>`)
    .join('');
  const corrections = Array.isArray(r.corrections) ? r.corrections : [];
  el('corrections-list').innerHTML = corrections.length
    ? corrections
        .map(
          (c) =>
            `<div class="correction-row"><p class="correction-from">${escapeHtml(c.from)}</p><p class="correction-to">${escapeHtml(c.to)}</p><p class="correction-why">${escapeHtml(c.why)}</p></div>`,
        )
        .join('')
    : '<p class="no-corrections">No corrections this turn — nice work!</p>';
  el('score-sheet').classList.remove('hidden');
}

el('score-pill').addEventListener('click', openScoreSheet);
el('score-sheet-close').addEventListener('click', () => el('score-sheet').classList.add('hidden'));
el('score-sheet').addEventListener('click', (e) => {
  if (e.target === el('score-sheet')) el('score-sheet').classList.add('hidden');
});

// --- screen wake lock ------------------------------------------------------
// Keeps the display on for a conversation's duration so a phone dimming and
// locking doesn't stutter the session. Feature-detected and never allowed to
// throw — browsers without it (iOS < 16.4, most desktops) just keep working
// as they do today.

let wakeLock = null;

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // denied, unsupported for this browser, or the page is hidden right now
    // — the conversation carries on without it
  }
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch {
    // already released
  }
}

// The browser drops the lock whenever the page is hidden (orb.js has its own
// unrelated visibilitychange listener, for canvas pause/resume), so
// re-request it once the app is foregrounded again while a session is
// still active.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.sessionStarted && !wakeLock) {
    acquireWakeLock();
  }
});

// --- live session orchestration -------------------------------------------

let connectPromise = null;

async function ensureSession() {
  if (state.sessionStarted) return;
  if (connectPromise) return connectPromise;
  hideError();
  claimConversation();
  state.conversationCorrections = [];
  state.hadTurn = false;
  state.sessionHalfDuplex = state.settings.halfDuplex;
  connectPromise = liveClient
    .connect({
      scenario: state.scenario,
      level: state.settings.level,
      voice: state.settings.voice,
      halfDuplex: state.settings.halfDuplex,
      feedbackDetail: state.settings.feedbackDetail,
      name: state.profile.name,
      memoryNote: getMemoryNote(state.profile),
      clientId: getClientId(),
    })
    .then(() => {
      state.sessionStarted = true;
      updateEndButtonState();
      acquireWakeLock();
    })
    .finally(() => {
      connectPromise = null;
    });
  return connectPromise;
}

// A conversation is "finished" the moment its session actually ends, however
// that happens — the End button closing the socket, the server closing it,
// a dropped connection, or the tab simply going away (see the pagehide
// listener below). Idempotent (guarded by hadTurn) so it's safe to reach
// from more than one of those places for the same session.
function finalizeConversationMemory() {
  if (!state.hadTurn) return;
  const line = buildConversationMemory(state.scenario, state.conversationCorrections);
  state.profile = addConversationMemory(state.profile, line);
  state.hadTurn = false;
  state.conversationCorrections = [];
}

// Best-effort net for a tab that simply closes: localStorage writes are
// synchronous, so this can still complete even though there is no more
// WebSocket 'close' event guaranteed to fire during unload.
window.addEventListener('pagehide', finalizeConversationMemory);

liveClient.addEventListener('message', (event) => {
  const msg = /** @type {CustomEvent} */ (event).detail;
  switch (msg.type) {
    case 'ready':
      hideError();
      break;
    case 'state': {
      // The server's 'listening' can come while this device is still
      // playing the reply: say so only once the mic really is open.
      const wait = msg.value === 'listening' ? micHoldMs() : 0;
      clearTimeout(listeningTimer);
      if (wait > 0) listeningTimer = window.setTimeout(() => applyServerState('listening'), wait);
      else applyServerState(msg.value);
      break;
    }
    case 'audio':
      audioPlayer.enqueuePcm16(msg.data);
      break;
    case 'input-text':
      // Any speech transcribed after a pending auto-close was armed belongs
      // to a new turn started after the goodbye pair — the learner kept
      // talking, so the close is stale and must not fire.
      state.pendingEndConversation = false;
      updateUserLine(msg.text, msg.final);
      announcer.say(finishedLine(msg));
      break;
    case 'output-text':
      updateTutorLine(msg.text, msg.final);
      announcer.say(finishedLine(msg));
      break;
    case 'interrupted':
      // The learner spoke over the tutor — clearly still engaged, so a
      // pending auto-close (armed for the turn just interrupted) is stale.
      state.pendingEndConversation = false;
      audioPlayer.flush();
      break;
    case 'turn-complete':
      state.hadTurn = true;
      break;
    case 'review':
      handleReview(msg);
      break;
    case 'reconnecting':
      // The server holds the mic and resumes the same conversation; the
      // 'interrupted' that follows drops the lost turn's queued audio.
      showError('Reconnecting to the tutor…');
      setUiState('reconnecting');
      break;
    case 'going-away':
      showError('This session will end soon — feel free to wrap up.');
      break;
    case 'error':
      showError(ERROR_TEXT[msg.code] || msg.message || 'Something went wrong.');
      break;
    default:
      break;
  }
});

function applyServerState(value) {
  if (value === 'speaking' && state.uiState !== 'speaking') {
    el('tutor-translation').classList.add('hidden');
  }
  setUiState(value);
  if (value === 'listening' && state.pendingEndConversation) {
    state.pendingEndConversation = false;
    endSession();
  }
}

// Everything a finished session releases, however it ended.
function teardownSession() {
  finalizeConversationMemory();
  state.pendingEndConversation = false;
  releaseWakeLock();
  audioCapture.stop();
  audioPlayer.flush();
  state.sessionStarted = false;
  state.micOn = false;
  setUiState('idle');
  updateMicUI();
  updateEndButtonState();
}

// Ended from the other side (tutor unreachable, server restart, network):
// turn the mic off for real and say so, so it never looks like it is still
// listening (#17).
liveClient.addEventListener('close', () => {
  if (!state.sessionStarted) return;
  teardownSession();
  if (el('error-card').classList.contains('hidden')) {
    showError('The conversation ended. Tap the microphone to start again.');
  }
});

// --- one conversation per device (#19) -----------------------------------
// Starting a conversation here ends the one in any other Parley window or
// tab on this device (the installed app included), so two tutors never talk
// over each other or hear each other through the mic. The server enforces
// the same rule per device id; this makes the older window let go at once
// and say why.

const conversationChannel = 'BroadcastChannel' in window ? new BroadcastChannel('parley-conversation') : null;

function claimConversation() {
  conversationChannel?.postMessage({ type: 'claim' });
}

conversationChannel?.addEventListener('message', (event) => {
  if (event.data?.type !== 'claim' || (!state.sessionStarted && !connectPromise)) return;
  liveClient.stop();
  if (state.sessionStarted) teardownSession();
  showError(TAKEN_OVER_MESSAGE);
});

// --- mic / end / meaning / type / hint controls --------------------------

function updateMicUI() {
  el('mic-btn').classList.toggle('on', state.micOn);
  el('mic-btn').setAttribute('aria-pressed', String(state.micOn));
  el('mic-status').textContent = state.micOn ? 'Microphone on' : 'Microphone off';
  updateWaveformVisibility();
}

// There is nothing to end until a session actually exists — keep the
// button in the layout (so the mic stays centered) but inert until then.
function updateEndButtonState() {
  el('end-btn').disabled = !state.sessionStarted;
  el('end-control').classList.toggle('is-disabled', !state.sessionStarted);
}

// Taps while the mic is still connecting or opening are ignored: acting on
// them opened a second mic pipeline next to the first (#18).
let micToggleBusy = false;

el('mic-btn').addEventListener('click', async () => {
  if (micToggleBusy) return;
  micToggleBusy = true;
  try {
    await ensureSession();
    if (!state.sessionStarted) return;
    if (!state.micOn) {
      // false when the session ended while the mic was opening: teardown
      // already stopped it, so it stays off.
      state.micOn = await audioCapture.start(sendMicChunk);
    } else {
      audioCapture.stop();
      state.micOn = false;
    }
    updateMicUI();
  } catch (err) {
    showError(micErrorMessage(err));
  } finally {
    micToggleBusy = false;
  }
});

// Reused both by the End button and by the automatic close on a satisfied
// goodbye pair (see handleReview/the 'state' case above) — one way to end a
// session, not two.
function endSession() {
  // liveClient.stop() detaches the socket, so its close is not reported to
  // the 'close' listener (a new session may already be starting by then):
  // tear down here.
  liveClient.stop();
  teardownSession();
  resetTranscript();
}

el('end-btn').addEventListener('click', () => {
  if (!state.sessionStarted) return;
  endSession();
});

el('meaning-btn').addEventListener('click', async () => {
  const translation = el('tutor-translation');
  if (!translation.classList.contains('hidden')) {
    translation.classList.add('hidden');
    return;
  }
  if (!state.lastTutorText) return;
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: state.lastTutorText, to: 'es' }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    translation.textContent = data.text;
    translation.classList.remove('hidden');
    announcer.say(`Meaning: ${data.text}`);
  } catch {
    showError("Couldn't fetch the translation right now.");
  }
});

el('hint-btn').addEventListener('click', async () => {
  if (!state.sessionStarted) {
    showError('Tap the microphone first to start talking.');
    return;
  }
  liveClient.say('Can you give me a hint for what I could say next?');
});

el('type-instead-btn').addEventListener('click', () => {
  const form = el('type-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) el('type-input').focus();
});

el('type-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el('type-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  el('type-form').classList.add('hidden');
  try {
    await ensureSession();
    liveClient.sendText(text);
  } catch (err) {
    showError(micErrorMessage(err));
  }
});

// --- Themes screen ---------------------------------------------------------

function selectScenario(title) {
  const changed = title !== state.scenario;
  state.scenario = title;
  renderTopicChip();
  showScreen('talk');
  if (changed && state.sessionStarted) {
    liveClient.say(title === JUST_TALK ? "Let's just talk, no particular topic." : `Let's switch to ${title}.`);
  }
}

el('just-talk-btn').addEventListener('click', () => selectScenario(JUST_TALK));

function renderThemeFilters() {
  el('theme-filters').innerHTML = SCENARIO_CATEGORIES.map(
    (cat) => `<button class="chip ${cat === state.themesFilter ? 'active' : ''}" data-cat="${cat}" type="button">${cat}</button>`,
  ).join('');
  el('theme-filters').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.themesFilter = chip.dataset.cat;
      renderThemeFilters();
      renderThemeGrid();
    });
  });
}

function renderThemeGrid() {
  const q = state.themesQuery.trim().toLowerCase();
  const filtered = SCENARIOS.filter((s) => {
    const matchesCategory = state.themesFilter === 'All' || s.category === state.themesFilter;
    const matchesQuery = !q || s.title.toLowerCase().includes(q) || s.subtitle.toLowerCase().includes(q);
    return matchesCategory && matchesQuery;
  });

  el('theme-grid').innerHTML = filtered
    .map(
      (s) => `
      <button class="theme-card theme-card--${s.tone}" data-id="${s.id}" type="button">
        <span class="theme-card-icon">${iconMarkup(s.icon)}</span>
        <span>
          <p class="theme-card-title">${escapeHtml(s.title)}</p>
          <p class="theme-card-subtitle">${escapeHtml(s.subtitle)}</p>
        </span>
      </button>`,
    )
    .join('');

  el('theme-empty').classList.toggle('hidden', filtered.length > 0);

  el('theme-grid').querySelectorAll('.theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      const scenario = SCENARIOS.find((s) => s.id === card.dataset.id);
      if (scenario) selectScenario(scenario.title);
    });
  });
}

el('themes-search').addEventListener('input', (e) => {
  state.themesQuery = e.target.value;
  renderThemeGrid();
});

// --- Words screen ------------------------------------------------------

function renderWords() {
  const words = searchWords(state.wordsQuery);
  el('word-list').innerHTML = words
    .map((w) => {
      const tier = masteryTier(w.count);
      const filled = tier === 'Fragile' ? 1 : tier === 'Growing' ? 2 : 3;
      const segments = [0, 1, 2].map((i) => `<span class="meter-segment ${i < filled ? 'filled' : ''}"></span>`).join('');
      const expanded = state.expandedWord === w.word;
      const sentences = expanded && w.sentences.length
        ? `<div class="word-sentences">${w.sentences.map((s) => `<p>“${escapeHtml(s)}”</p>`).join('')}</div>`
        : expanded
          ? '<div class="word-sentences"><p class="no-sentences">No saved sentences yet.</p></div>'
          : '';
      return `
        <button class="word-row" type="button" data-word="${escapeHtml(w.word)}" aria-expanded="${expanded}">
          <div class="word-main">
            <p class="word-title">${escapeHtml(w.word)}</p>
            <p class="word-meaning">${escapeHtml(w.meaning)}</p>
            ${sentences}
          </div>
          <div class="word-meter">
            <div class="meter-segments">${segments}</div>
            <span class="meter-label">${tier}</span>
          </div>
        </button>`;
    })
    .join('');

  const hasAnyWords = getAllWords().length > 0;
  el('words-empty').classList.toggle('hidden', words.length > 0);
  // The mastery legend only means something once at least one word exists —
  // showing it (and the CTA) over an empty library either way.
  el('word-legend').classList.toggle('hidden', !hasAnyWords);
  el('word-footnote').classList.toggle('hidden', !hasAnyWords);

  if (words.length === 0) {
    if (hasAnyWords) {
      el('words-empty-text').textContent = 'No words match that search.';
      el('words-empty-cta').classList.add('hidden');
    } else {
      el('words-empty-text').textContent = 'Start a conversation and your words will show up here.';
      el('words-empty-cta').classList.remove('hidden');
    }
  }

  el('word-list').querySelectorAll('.word-row').forEach((row) => {
    row.addEventListener('click', () => {
      const word = row.dataset.word;
      state.expandedWord = state.expandedWord === word ? null : word;
      renderWords();
    });
  });
}

el('words-empty-cta').addEventListener('click', () => showScreen('talk'));

el('words-search').addEventListener('input', (e) => {
  state.wordsQuery = e.target.value;
  renderWords();
});

// --- Settings sheet ------------------------------------------------------

function renderPillGroup(containerId, options, currentValue, onSelect) {
  const container = el(containerId);
  container.innerHTML = options
    .map((opt) => `<button class="pill-option ${opt.value === currentValue ? 'active' : ''}" data-value="${opt.value}" type="button">${opt.label}</button>`)
    .join('');
  container.querySelectorAll('.pill-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSelect(btn.dataset.value);
      renderPillGroup(containerId, options, btn.dataset.value, onSelect);
    });
  });
}

function updateSetting(key, value) {
  state.settings[key] = value;
  saveSettings(state.settings);
  if (key === 'textSize') applyTextSize(value);
}

function renderSettingsSheet() {
  el('name-input').value = state.profile.name || '';
  renderPillGroup('voice-options', VOICES.map((v) => ({ value: v, label: v })), state.settings.voice, (v) => updateSetting('voice', v));
  renderPillGroup('level-options', LEVELS.map((v) => ({ value: v, label: v })), state.settings.level, (v) => updateSetting('level', v));
  renderPillGroup('feedback-options', FEEDBACK_OPTIONS, state.settings.feedbackDetail, (v) => updateSetting('feedbackDetail', v));
  renderPillGroup('text-size-options', TEXT_SIZES, state.settings.textSize, (v) => updateSetting('textSize', v));

  // "Interruptions" toggle reads as hands-free mode: halfDuplex OFF = interruptions allowed.
  el('half-duplex-toggle').setAttribute('aria-checked', String(!state.settings.halfDuplex));

  const saveWordsToggle = el('save-words-toggle');
  saveWordsToggle.setAttribute('aria-checked', String(state.settings.saveWords));
}

el('half-duplex-toggle').addEventListener('click', () => {
  const interruptionsOn = el('half-duplex-toggle').getAttribute('aria-checked') !== 'true';
  el('half-duplex-toggle').setAttribute('aria-checked', String(interruptionsOn));
  updateSetting('halfDuplex', !interruptionsOn);
});

el('name-input').addEventListener('change', (e) => {
  state.profile = setProfileName(state.profile, e.target.value);
  e.target.value = state.profile.name;
});

el('save-words-toggle').addEventListener('click', () => {
  const on = el('save-words-toggle').getAttribute('aria-checked') !== 'true';
  el('save-words-toggle').setAttribute('aria-checked', String(on));
  updateSetting('saveWords', on);
});

el('forget-btn').addEventListener('click', () => {
  if (!window.confirm("Forget everything Parley remembers about you? This clears your name and what it knows from past conversations — it can't be undone.")) return;
  state.profile = forgetProfile();
  renderSettingsSheet();
});

function openSettingsSheet() {
  renderSettingsSheet();
  el('settings-sheet').classList.remove('hidden');
}

el('settings-btn').addEventListener('click', openSettingsSheet);
document.querySelectorAll('.settings-btn-alt').forEach((btn) => btn.addEventListener('click', openSettingsSheet));
el('settings-close').addEventListener('click', () => el('settings-sheet').classList.add('hidden'));
el('settings-sheet').addEventListener('click', (e) => {
  if (e.target === el('settings-sheet')) el('settings-sheet').classList.add('hidden');
});

// --- boot ----------------------------------------------------------------

renderStaticIcons();
renderTopicChip();
updateStatusLine();
updateEndButtonState();
renderThemeFilters();
renderThemeGrid();
renderWords();
showScreen('talk');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=11').catch(() => {
      // offline shell just won't be available — the app still works online
    });
  });
}
