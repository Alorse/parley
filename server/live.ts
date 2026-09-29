import { EventEmitter } from 'node:events';
import { WebSocket as WsWebSocket } from 'ws';
import { appNote, buildSystemPrompt, KICKOFF_NOTE } from './tutor.js';
import { cleanReason, noopSessionLogger, type SessionLogger } from './session-log.js';
import type {
  ClientMessage,
  GeminiAudioUpstreamFrame,
  GeminiServerContent,
  GeminiServerFrame,
  GeminiSetupFrame,
  GeminiTextUpstreamFrame,
  GeminiUpstreamFrame,
  LiveEventMessage,
} from './protocol.js';

// Node >= 22 ships a global WebSocket; Node 20 does not. The production unit
// runs on the system node (/usr/bin/node), which may be older than the shell's,
// so fall back to the `ws` client we already depend on instead of crashing with
// "this.WebSocketImpl is not a constructor". Resolved as a constructor
// default (evaluated per-call, not at module load) so tests can flip
// globalThis.WebSocket and observe the fallback actually engage.
//
// Returns `any` on purpose: the DOM/undici global WebSocket and the `ws`
// package's WebSocket are two different, incompatible type declarations for
// the same runtime shape, and this class genuinely runs with either one
// depending on the Node version — forcing one's types onto the other would
// be dishonest, not safer.
export function resolveWebSocketImpl(): any {
  return globalThis.WebSocket ?? WsWebSocket;
}

const UPSTREAM_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

const TAIL_GUARD_MS = 400;
const THINKING_DELAY_MS = 500;
const SILENCE_NUDGE_DELAY_MS = 6000;
// An app note, not a learner turn: sent bare, the tutor took the nudge as
// the learner's own words and answered them (#29). A model-role turn is
// not an option: gemini-3.8-live stays silent after one.
const SILENCE_NUDGE_NOTE = appNote(
  `The learner has been quiet since your correction. Gently tell them, in your own voice, something like: "Take your time — try saying it, or we'll move on."`,
);
// Upstream drops were seen about every 8 minutes, so a long conversation
// needs several resumes; the cap only stops a flapping upstream from looping
// forever. Each drop gets a few attempts with exponential backoff.
export const MAX_RECONNECTS = 8;
export const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_DELAY_MS = 4000;
const RECONNECT_ATTEMPTS_PER_DROP = 3;
// No wait is unbounded (#17). A setup that never completes fails the attempt;
// a reply whose turnComplete never arrives is completed by the server this
// long after its audio would have finished playing, so the mic reopens.
export const SETUP_TIMEOUT_MS = 15000;
export const TURN_WATCHDOG_MS = 10000;
// A conversation with no sign of the learner for this long is closed (#20).
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_BYTES_PER_MS = (24000 * 2) / 1000;

// Wait before the Nth (1-based) attempt after a drop: base, 2x, 4x... capped.
export function reconnectDelayMs(attempt: number, baseMs: number = RECONNECT_BASE_MS): number {
  return Math.min(baseMs * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
}

export function upstreamUrl(apiKey: string): string {
  return `${UPSTREAM_BASE}?key=${apiKey}`;
}

export function buildSetupFrame({
  model,
  voice,
  resumeHandle = null,
  persona = '',
}: {
  model: string;
  voice: string;
  resumeHandle?: string | null;
  persona?: string;
}): GeminiSetupFrame {
  return {
    setup: {
      model: `models/${model}`,
      // The persona as standing instructions, not as the learner's first
      // message: the tutor starts speaking sooner and never mistakes its own
      // instructions for something the learner said (#23, #26).
      ...(persona ? { systemInstruction: { parts: [{ text: persona }] } } : {}),
      // Always on, so the upstream keeps sending sessionResumptionUpdate
      // handles; with a handle this setup continues that conversation.
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
      // The learner speaks English: without the hint the transcriber guesses
      // the language every turn and writes short or unclear English in other
      // scripts (#28). Accepted by gemini-3.8-live and
      // gemini-3.1-flash-live-preview (scripts/live-probe.mjs).
      inputAudioTranscription: { languageCodes: ['en-US'] },
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          silenceDurationMs: 700,
          prefixPaddingMs: 300,
        },
      },
    },
  };
}

export function audioUpstreamFrame(base64Data: string): GeminiAudioUpstreamFrame {
  return { realtimeInput: { audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' } } };
}

export function textUpstreamFrame(text: string): GeminiTextUpstreamFrame {
  return { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } };
}

// Client-message -> upstream-frame codec used both by the live session and by
// tests. `interrupt` has no upstream wire shape: automatic activity detection
// is always on, so interruption is handled locally (flush turn state, tell
// the client to flush playback) rather than by sending anything upstream.
export function toUpstreamFrame(message: ClientMessage): GeminiUpstreamFrame | null {
  switch (message.type) {
    case 'audio':
      return audioUpstreamFrame(message.data);
    case 'text':
    case 'say':
      return textUpstreamFrame(message.text);
    case 'interrupt':
      return null;
    default:
      return null;
  }
}

const NUMBER_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const SCORE_CONTEXT = /\b(score|scored|rate|rating|grade|out of (?:ten|100|a hundred)|percent)\b/i;
const NUMBER_WORD_PATTERN = new RegExp(`\\b(${NUMBER_WORDS})\\b`, 'i');

// The Live model's audio streams as it is generated, so a spoken score can't
// be un-said once heard — there's no deterministic fallback at the audio
// layer. This only flags the accumulated transcript after the fact, for a
// compliance metric; it must never gate or alter anything mid-stream.
export function containsSpokenScore(assistantText: string): boolean {
  if (!assistantText) return false;
  if (/%/.test(assistantText)) return true;
  if (/\bpercent\b/i.test(assistantText)) return true;
  if (!SCORE_CONTEXT.test(assistantText)) return false;
  return /\b\d{1,3}\b/.test(assistantText) || NUMBER_WORD_PATTERN.test(assistantText);
}

// Mirrors the mandated invitation phrasing in tutor.ts's system prompt — kept
// here (not imported) since it only needs to recognize the phrase in spoken
// output, not author it.
const CORRECTION_INVITATION_PATTERN = /\btry saying\b|\bgive (?:that|it) one a go\b/i;

// Low-noise compliance signal only, same spirit as containsSpokenScore: a
// completed turn that both invites a retry and asks a question is a
// candidate "stacked turn" — the correction-then-question pattern Part 1 is
// meant to eliminate. Flags after the fact for a counter; never gates or
// alters anything mid-stream.
export function containsStackedTurn(assistantText: string): boolean {
  if (!assistantText) return false;
  return CORRECTION_INVITATION_PATTERN.test(assistantText) && assistantText.includes('?');
}

export interface HalfDuplexGateOptions {
  tailGuardMs?: number;
  enabled?: boolean;
  now?: () => number;
}

// Pure, timestamp-based half-duplex gate: while the assistant's audio is
// playing, and for a short tail guard after it ends, incoming mic frames are
// dropped server-side. Timestamp-based (not setTimeout-based) so it is
// trivially unit-testable with a fake clock.
export class HalfDuplexGate {
  tailGuardMs: number;
  enabled: boolean;
  private _now: () => number;
  private _speaking: boolean;
  private _resumeAt: number;

  constructor({ tailGuardMs = TAIL_GUARD_MS, enabled = true, now = () => Date.now() }: HalfDuplexGateOptions = {}) {
    this.tailGuardMs = tailGuardMs;
    this.enabled = enabled;
    this._now = now;
    this._speaking = false;
    this._resumeAt = 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  onAssistantAudio(): void {
    this._speaking = true;
    this._resumeAt = Infinity;
  }

  // Closed until the next onTurnComplete/onInterrupted, like while the
  // assistant speaks: used while the upstream is being re-established.
  hold(): void {
    this.onAssistantAudio();
  }

  onTurnComplete(): void {
    this._speaking = false;
    this._resumeAt = this._now() + this.tailGuardMs;
  }

  onInterrupted(): void {
    this._speaking = false;
    this._resumeAt = 0;
  }

  isGated(): boolean {
    if (!this.enabled) return false;
    if (this._speaking) return true;
    return this._now() < this._resumeAt;
  }
}

export interface SilenceNudgeOptions {
  delayMs?: number;
  now?: () => number;
}

// Pure, timestamp-based arming state for the anti-freeze nudge, in the same
// style as HalfDuplexGate: comparisons over an injectable clock, no
// setTimeout, so the "should this fire yet" decision is unit-testable
// without real timers. The session (GeminiLiveSession) is what actually
// schedules a real timer and calls say() when shouldFire() turns true —
// this class only owns "armed after a correction, disarmed by learner
// input, fires at most once".
export class SilenceNudge {
  delayMs: number;
  private _now: () => number;
  private _armedAt: number | null;
  private _fired: boolean;

  constructor({ delayMs = SILENCE_NUDGE_DELAY_MS, now = () => Date.now() }: SilenceNudgeOptions = {}) {
    this.delayMs = delayMs;
    this._now = now;
    this._armedAt = null;
    this._fired = false;
  }

  arm(): void {
    this._armedAt = this._now();
    this._fired = false;
  }

  disarm(): void {
    this._armedAt = null;
    this._fired = false;
  }

  isArmed(): boolean {
    return this._armedAt !== null;
  }

  // How long until shouldFire() turns true; null once disarmed or fired.
  msUntilDue(): number | null {
    if (this._armedAt === null || this._fired) return null;
    return Math.max(0, this.delayMs - (this._now() - this._armedAt));
  }

  // True the first time delayMs has elapsed since arm(); false before that,
  // once disarmed, and on every call after it has already fired once — so a
  // caller can safely re-check without ever firing twice for the same arm.
  shouldFire(): boolean {
    if (this.msUntilDue() !== 0) return false;
    this._fired = true;
    return true;
  }
}

interface Turn {
  userText: string;
  assistantText: string;
  startedAt: number;
  silent: boolean;
  // When the reply audio received so far would finish playing in real time.
  playbackEndsAt: number;
}

function freshTurn(): Turn {
  return { userText: '', assistantText: '', startedAt: Date.now(), silent: false, playbackEndsAt: 0 };
}

export interface GeminiLiveSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  scenario?: string;
  level?: string;
  nativeLanguage?: string;
  feedbackDetail?: string;
  halfDuplex?: boolean;
  learnerName?: string;
  memoryNote?: string;
  webSocketImpl?: any;
  log?: SessionLogger;
  maxReconnects?: number;
  reconnectBaseMs?: number;
  setupTimeoutMs?: number;
  turnWatchdogMs?: number;
}

export interface ReviewRequestPayload {
  user: string;
  assistant: string;
  level: string;
  learnerName?: string;
  scenario?: string;
}

// One upstream Live session per browser WebSocket connection. Emits 'client'
// events shaped exactly like the documented server->client protocol, and
// 'review-request' when a non-silent turn completes (index.ts wires that to
// server/review.ts).
export class GeminiLiveSession extends EventEmitter {
  apiKey: string;
  model: string;
  voice: string;
  scenario: string;
  level: string;
  nativeLanguage: string;
  feedbackDetail: string;
  learnerName: string;
  memoryNote: string;
  WebSocketImpl: any;
  log: SessionLogger;
  gate: HalfDuplexGate;
  nudge: SilenceNudge;
  ws: any;
  closed: boolean;
  maxReconnects: number;
  reconnectBaseMs: number;
  setupTimeoutMs: number;
  turnWatchdogMs: number;
  // Upstream reconnect attempts made so far, across every drop.
  reconnects: number;
  // Latest session-resumption handle from the upstream (a credential for
  // the conversation: never logged).
  resumeHandle: string | null;
  turn: Turn;
  // Learner turns only (silent kickoff/say turns excluded); lifecycle logging.
  turnsCompleted: number;
  private _thinkingTimer: NodeJS.Timeout | undefined;
  private _resumeTimer: NodeJS.Timeout | undefined;
  private _nudgeTimer: NodeJS.Timeout | undefined;
  private _reconnectTimer: NodeJS.Timeout | undefined;
  private _watchdogTimer: NodeJS.Timeout | undefined;
  // True between setupComplete and the loss of the current upstream socket;
  // nothing may be sent upstream outside that window.
  private _upstreamReady: boolean;
  // Separate from gate._speaking (which starts pre-closed, see below) —
  // tracks whether we've told the client we're in the 'speaking' state
  // for the turn currently in flight.
  private _speakingUi: boolean;
  // Compliance metrics only — see containsSpokenScore/containsStackedTurn.
  // Never read back to gate or alter behaviour mid-stream.
  private _spokenScoreViolations: number;
  private _stackedTurnViolations: number;

  constructor({
    apiKey,
    model,
    voice,
    scenario = 'Just talk',
    level = 'B1',
    nativeLanguage = 'Spanish',
    feedbackDetail = 'every-turn',
    halfDuplex = true,
    learnerName = '',
    memoryNote = '',
    webSocketImpl = resolveWebSocketImpl(),
    log = noopSessionLogger,
    maxReconnects = MAX_RECONNECTS,
    reconnectBaseMs = RECONNECT_BASE_MS,
    setupTimeoutMs = SETUP_TIMEOUT_MS,
    turnWatchdogMs = TURN_WATCHDOG_MS,
  }: GeminiLiveSessionOptions) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.scenario = scenario;
    this.level = level;
    this.nativeLanguage = nativeLanguage;
    this.feedbackDetail = feedbackDetail;
    this.learnerName = learnerName;
    this.memoryNote = memoryNote;
    this.WebSocketImpl = webSocketImpl;
    this.log = log;
    this.gate = new HalfDuplexGate({ enabled: halfDuplex });
    this.nudge = new SilenceNudge();
    // The kickoff/greeting turn is sent as soon as setup completes, before
    // the learner has said anything. Close the mic gate immediately so any
    // audio the client streams while getUserMedia/connect is still settling
    // can't reach upstream and collide with that first turn's boundaries —
    // it opens again after the greeting's turnComplete + tail guard, same
    // as any other turn.
    this.gate.onAssistantAudio();
    this.ws = null;
    this.closed = false;
    this.maxReconnects = maxReconnects;
    this.reconnectBaseMs = reconnectBaseMs;
    this.setupTimeoutMs = setupTimeoutMs;
    this.turnWatchdogMs = turnWatchdogMs;
    this.reconnects = 0;
    this.resumeHandle = null;
    this.turn = freshTurn();
    this.turnsCompleted = 0;
    this._thinkingTimer = undefined;
    this._resumeTimer = undefined;
    this._nudgeTimer = undefined;
    this._reconnectTimer = undefined;
    this._watchdogTimer = undefined;
    this._upstreamReady = false;
    this._speakingUi = false;
    this._spokenScoreViolations = 0;
    this._stackedTurnViolations = 0;
  }

  setHalfDuplex(enabled: boolean): void {
    this.gate.setEnabled(enabled);
  }

  // Called once index.ts's review-request handler comes back with a
  // freshly captured name, so the rest of this session's review requests
  // stop asking the model to extract one all over again (see
  // buildReviewPrompt's nameInstruction).
  setLearnerName(name: string): void {
    this.learnerName = name;
  }

  setScenario(scenario: string): void {
    this.scenario = scenario;
  }

  async start(): Promise<void> {
    await this._connect(null);
  }

  // Opens one upstream socket and resolves once its setup completes. Given a
  // resumption handle, the upstream restores the conversation it belongs to,
  // so the kickoff turn is NOT sent again — a fresh opening turn is what made
  // the tutor greet the learner a second time with no memory of the talk (#16).
  // The persona goes in every setup, resumed or not.
  private _connect(resumeHandle: string | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const connectStartedAt = Date.now();
      let setupAt = 0;
      // `this.WebSocketImpl` is either the DOM/undici global WebSocket or the
      // `ws` package's WebSocket depending on the Node runtime (see
      // resolveWebSocketImpl above) — their type declarations disagree on the
      // exact MessageEvent shape, so this is intentionally untyped rather
      // than forcing one implementation's types onto the other.
      const ws: any = new this.WebSocketImpl(upstreamUrl(this.apiKey));
      // The global WebSocket defaults binaryType to "blob"; Gemini sends JSON
      // over binary frames, so without this every message arrives as an
      // unreadable Blob and silently fails to parse.
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this._upstreamReady = false;
      // First outcome wins: setupComplete, error, close or the deadline.
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(setupTimer);
        return true;
      };
      const setupTimer = setTimeout(() => {
        if (!settle()) return;
        this.log('setup-timeout', { model: this.model, ms: this.setupTimeoutMs });
        reject(new Error('upstream setup timed out'));
        try {
          ws.close();
        } catch {
          // already closed
        }
      }, this.setupTimeoutMs);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(buildSetupFrame({ model: this.model, voice: this.voice, resumeHandle, persona: this._persona() })));
      });

      ws.addEventListener('message', (event: any) => {
        let msg: GeminiServerFrame;
        try {
          const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.setupComplete && settle()) {
          setupAt = Date.now();
          this._upstreamReady = true;
          this.log('upstream-ready', { model: this.model, setupMs: setupAt - connectStartedAt, resumed: Boolean(resumeHandle) });
          this._emitClient({ type: 'ready' });
          if (resumeHandle) {
            // Nothing is in flight on a resumed session: hand the turn back
            // to the learner.
            this._reopenMic();
          } else {
            // No 'listening' state here: the kickoff turn is already in
            // flight and will produce 'speaking' once its audio starts, then
            // 'listening' once that greeting turn completes.
            this.say(KICKOFF_NOTE);
          }
          resolve();
          return;
        }
        this._handleUpstreamMessage(msg);
      });

      ws.addEventListener('error', () => {
        this.log('upstream-error', { model: this.model, afterSetup: Boolean(setupAt) });
        if (settle()) {
          reject(new Error('upstream error'));
        }
      });

      ws.addEventListener('close', (event: any) => {
        this.log('upstream-close', {
          model: this.model,
          code: event?.code,
          reason: cleanReason(event?.reason),
          byServer: this.closed,
          afterSetup: Boolean(setupAt),
          upMs: setupAt ? Date.now() - setupAt : null,
        });
        if (settle()) {
          reject(new Error(`upstream closed before setup (code ${event?.code})`));
          return;
        }
        if (setupAt && !this.closed && ws === this.ws) this._onUpstreamLost();
      });
    });
  }

  // The upstream dropped mid-conversation (seen live: close 1011 after ~8
  // minutes, no goAway first). Hold the mic, drop whatever the lost turn had
  // queued for playback, and resume.
  private _onUpstreamLost(): void {
    this._upstreamReady = false;
    this._clearTimers();
    this.gate.hold();
    this.turn = freshTurn();
    this._speakingUi = false;
    this._emitClient({ type: 'reconnecting' });
    this._emitClient({ type: 'interrupted' });
    void this._reconnect();
  }

  private async _reconnect(): Promise<void> {
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS_PER_DROP; attempt++) {
      if (this.reconnects >= this.maxReconnects) {
        this._giveUp('reconnect-limit');
        return;
      }
      const waitMs = reconnectDelayMs(attempt, this.reconnectBaseMs);
      await new Promise((resolve) => {
        this._reconnectTimer = setTimeout(resolve, waitMs);
      });
      if (this.closed) return;
      this.reconnects += 1;
      const startedAt = Date.now();
      this.log('reconnecting', { attempt, total: this.reconnects, resume: Boolean(this.resumeHandle), waitMs });
      try {
        await this._connect(this.resumeHandle);
        this.log('reconnected', { attempt, total: this.reconnects, ms: Date.now() - startedAt });
        return;
      } catch (err) {
        if (this.closed) return;
        this.log('reconnect-failed', { attempt, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this._giveUp('reconnect-failed');
  }

  // The upstream is gone for good: stop, tell the client plainly, and let
  // index.ts end the connection so its slot is freed (#17).
  private _giveUp(reason: string): void {
    this.log('gave-up', { reason, reconnects: this.reconnects });
    this.stop();
    this._emitClient({
      type: 'error',
      message: 'Lost connection to the tutor. Tap the microphone to start again.',
      code: 'upstream-closed',
    });
    this.emit('ended', reason);
  }

  // Built per setup, so a resumed session picks up a name learned meanwhile.
  private _persona(): string {
    return buildSystemPrompt({
      scenario: this.scenario,
      level: this.level,
      nativeLanguage: this.nativeLanguage,
      feedbackDetail: this.feedbackDetail,
      learnerName: this.learnerName,
      memoryNote: this.memoryNote,
    });
  }

  // A text turn always gets a reply, so the reply's turnComplete is awaited
  // under the watchdog.
  private _sendTurn(text: string): void {
    if (this._sendUpstream(textUpstreamFrame(text))) this._armTurnWatchdog();
  }

  private _armTurnWatchdog(): void {
    clearTimeout(this._watchdogTimer);
    const stillToPlayMs = Math.max(0, this.turn.playbackEndsAt - Date.now());
    this._watchdogTimer = setTimeout(() => {
      this.log('turn-watchdog', { ms: this.turnWatchdogMs });
      this._onTurnComplete();
    }, stillToPlayMs + this.turnWatchdogMs);
  }

  private _sendUpstream(frame: GeminiUpstreamFrame): boolean {
    if (!this._upstreamReady || this.ws.readyState !== this.WebSocketImpl.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private _emitClient(message: LiveEventMessage): void {
    this.emit('client', message);
  }

  private _clearTimers(): void {
    clearTimeout(this._thinkingTimer);
    clearTimeout(this._resumeTimer);
    clearTimeout(this._nudgeTimer);
    clearTimeout(this._watchdogTimer);
    this._thinkingTimer = undefined;
    this._resumeTimer = undefined;
    this._nudgeTimer = undefined;
    this._watchdogTimer = undefined;
  }

  private _armThinkingTimer(): void {
    clearTimeout(this._thinkingTimer);
    this._thinkingTimer = setTimeout(() => {
      this._emitClient({ type: 'state', value: 'thinking' });
    }, THINKING_DELAY_MS);
  }

  sendAudio(base64Data: string): boolean {
    // Deliberately does not disarm the silence nudge: the client streams mic
    // frames continuously and unconditionally, silence included (that's the
    // whole reason HalfDuplexGate exists — the server is what drops frames
    // while gated). A raw frame proves nothing; only actual transcribed
    // speech (see the inputTranscription branch below) means the learner
    // spoke.
    if (this.gate.isGated() || !this._sendUpstream(audioUpstreamFrame(base64Data))) return false;
    this._armThinkingTimer();
    return true;
  }

  sendText(text: string): void {
    this._disarmSilenceNudge();
    this._sendTurn(text);
  }

  // A turn the tutor answers that is not reviewed or counted as a learner
  // turn: the client's hint/scenario requests and the server's app notes.
  say(text: string): void {
    this.turn.silent = true;
    this._sendTurn(text);
  }

  interrupt(): void {
    this.gate.onInterrupted();
    this._disarmSilenceNudge();
    this._clearTimers();
    this.turn = freshTurn();
    this._speakingUi = false;
    this._emitClient({ type: 'interrupted' });
    this._emitClient({ type: 'state', value: 'listening' });
  }

  // Armed by index.ts once a completed turn's review comes back with at
  // least one correction. If the learner stays silent, automatic activity
  // detection never starts a new upstream turn on its own — nothing else in
  // this session would ever speak again — so this is what keeps the
  // conversation from freezing after the pace change in Part 1. Fires at
  // most once per arm (SilenceNudge.shouldFire), and is sent via say() as an
  // app note (no review, no score history pollution).
  armSilenceNudge(): void {
    this.nudge.arm();
    this._scheduleNudge(this.nudge.delayMs);
  }

  // A timer can fire a millisecond before Date.now() says the delay has
  // passed; re-check then instead of silently never nudging.
  private _scheduleNudge(ms: number): void {
    clearTimeout(this._nudgeTimer);
    this._nudgeTimer = setTimeout(() => {
      if (this.nudge.shouldFire()) {
        this.say(SILENCE_NUDGE_NOTE);
        return;
      }
      const left = this.nudge.msUntilDue();
      if (left !== null) this._scheduleNudge(Math.max(1, left));
    }, ms);
  }

  private _disarmSilenceNudge(): void {
    this.nudge.disarm();
    clearTimeout(this._nudgeTimer);
    this._nudgeTimer = undefined;
  }

  stop(): void {
    this.closed = true;
    this._clearTimers();
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
    }
  }

  private _handleUpstreamMessage(msg: GeminiServerFrame): void {
    if (msg.serverContent) {
      this._handleServerContent(msg.serverContent);
    }
    if (msg.sessionResumptionUpdate) {
      // resumable:false only means "not at this exact moment" (mid-turn);
      // the previous handle stays valid.
      const { newHandle, resumable } = msg.sessionResumptionUpdate;
      if (newHandle && resumable !== false) this.resumeHandle = newHandle;
    }
    if (msg.goAway) {
      this.log('going-away', { timeLeft: msg.goAway.timeLeft, resumable: Boolean(this.resumeHandle) });
      // With a handle the coming close is resumed transparently, so there
      // is nothing to warn the learner about.
      if (!this.resumeHandle) this._emitClient({ type: 'going-away', timeLeft: msg.goAway.timeLeft });
    }
  }

  private _handleServerContent(sc: GeminiServerContent): void {
    if (sc.interrupted) {
      this.interrupt();
      return;
    }

    const parts = sc.modelTurn?.parts || [];
    let gotAudio = false;
    for (const part of parts) {
      if (part.inlineData?.data) {
        gotAudio = true;
        const playMs = (part.inlineData.data.length * 3) / 4 / OUTPUT_BYTES_PER_MS;
        this.turn.playbackEndsAt = Math.max(this.turn.playbackEndsAt, Date.now()) + playMs;
        this._emitClient({ type: 'audio', data: part.inlineData.data });
      }
    }
    if (gotAudio) {
      clearTimeout(this._thinkingTimer);
      if (!this._speakingUi) {
        this._speakingUi = true;
        this._emitClient({ type: 'state', value: 'speaking' });
      }
      this.gate.onAssistantAudio();
    }
    if (gotAudio || sc.outputTranscription?.text) this._armTurnWatchdog();

    if (sc.inputTranscription?.text) {
      this._disarmSilenceNudge();
      this.turn.userText += sc.inputTranscription.text;
      this._emitClient({ type: 'input-text', text: this.turn.userText, final: false });
    }
    if (sc.outputTranscription?.text) {
      this.turn.assistantText += sc.outputTranscription.text;
      this._emitClient({ type: 'output-text', text: this.turn.assistantText, final: false });
    }

    if (sc.turnComplete) {
      this._onTurnComplete();
    }
  }

  private _onTurnComplete(): void {
    const { userText, assistantText, startedAt, silent } = this.turn;
    const durationMs = Date.now() - startedAt;
    clearTimeout(this._thinkingTimer);
    clearTimeout(this._watchdogTimer);
    this._speakingUi = false;

    this._emitClient({ type: 'input-text', text: userText, final: true });
    this._emitClient({ type: 'output-text', text: assistantText, final: true });

    if (containsSpokenScore(assistantText)) {
      this._spokenScoreViolations += 1;
      console.warn('live: assistant may have spoken a score', { count: this._spokenScoreViolations });
    }

    if (containsStackedTurn(assistantText)) {
      this._stackedTurnViolations += 1;
      console.warn('live: assistant may have stacked a follow-up question onto a correction turn', {
        count: this._stackedTurnViolations,
      });
    }

    if (!silent) {
      this.turnsCompleted += 1;
      this._emitClient({ type: 'turn-complete', user: userText, assistant: assistantText, durationMs });
      const payload: ReviewRequestPayload = {
        user: userText,
        assistant: assistantText,
        level: this.level,
        learnerName: this.learnerName,
        scenario: this.scenario,
      };
      this.emit('review-request', payload);
    }

    this.turn = freshTurn();
    this._reopenMic();
  }

  // Opens the mic gate after the tail guard, and tells the client then.
  private _reopenMic(): void {
    this.gate.onTurnComplete();
    clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => {
      this._emitClient({ type: 'state', value: 'listening' });
    }, this.gate.tailGuardMs);
  }
}
