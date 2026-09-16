import { EventEmitter } from 'node:events';
import { WebSocket as WsWebSocket } from 'ws';
import { buildSystemPrompt } from './tutor.js';
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
const SILENCE_NUDGE_TEXT = "Take your time — try saying it, or we'll move on.";

export function upstreamUrl(apiKey: string): string {
  return `${UPSTREAM_BASE}?key=${apiKey}`;
}

export function buildSetupFrame({ model, voice }: { model: string; voice: string }): GeminiSetupFrame {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
      inputAudioTranscription: {},
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

  // True the first time delayMs has elapsed since arm(); false before that,
  // once disarmed, and on every call after it has already fired once — so a
  // caller can safely re-check without ever firing twice for the same arm.
  shouldFire(): boolean {
    if (this._armedAt === null || this._fired) return false;
    if (this._now() - this._armedAt < this.delayMs) return false;
    this._fired = true;
    return true;
  }
}

interface Turn {
  userText: string;
  assistantText: string;
  startedAt: number;
  silent: boolean;
}

function freshTurn(): Turn {
  return { userText: '', assistantText: '', startedAt: Date.now(), silent: false };
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
  webSocketImpl?: any;
}

export interface ReviewRequestPayload {
  user: string;
  assistant: string;
  level: string;
  learnerName?: string;
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
  WebSocketImpl: any;
  gate: HalfDuplexGate;
  nudge: SilenceNudge;
  ws: any;
  closed: boolean;
  reconnectAttempted: boolean;
  turn: Turn;
  private _thinkingTimer: NodeJS.Timeout | undefined;
  private _resumeTimer: NodeJS.Timeout | undefined;
  private _nudgeTimer: NodeJS.Timeout | undefined;
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
    webSocketImpl = resolveWebSocketImpl(),
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
    this.WebSocketImpl = webSocketImpl;
    this.gate = new HalfDuplexGate({ enabled: halfDuplex });
    this.nudge = new SilenceNudge();
    // The persona/greeting turn is sent as soon as setup completes, before
    // the learner has said anything. Close the mic gate immediately so any
    // audio the client streams while getUserMedia/connect is still settling
    // can't reach upstream and collide with that first turn's boundaries —
    // it opens again after the greeting's turnComplete + tail guard, same
    // as any other turn.
    this.gate.onAssistantAudio();
    this.ws = null;
    this.closed = false;
    this.reconnectAttempted = false;
    this.turn = freshTurn();
    this._thinkingTimer = undefined;
    this._resumeTimer = undefined;
    this._nudgeTimer = undefined;
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
    await this._connect();
  }

  private _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
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

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(buildSetupFrame({ model: this.model, voice: this.voice })));
      });

      ws.addEventListener('message', (event: any) => {
        let msg: GeminiServerFrame;
        try {
          const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.setupComplete && !settled) {
          settled = true;
          this._sendPersonaTurn();
          this._emitClient({ type: 'ready' });
          // No 'listening' state here: the persona turn is already in
          // flight and will produce 'speaking' once its audio starts, then
          // 'listening' once that greeting turn completes.
          resolve();
          return;
        }
        this._handleUpstreamMessage(msg);
      });

      ws.addEventListener('error', () => {
        this._emitClient({ type: 'error', message: 'Upstream connection error' });
        if (!settled) {
          settled = true;
          reject(new Error('upstream error'));
        }
      });

      ws.addEventListener('close', () => {
        const wasClosed = this.closed;
        this._clearTimers();
        if (!settled) {
          settled = true;
          reject(new Error('upstream closed before setup'));
          return;
        }
        if (!wasClosed && !this.reconnectAttempted) {
          this.reconnectAttempted = true;
          this._emitClient({ type: 'reconnecting' });
          this._connect().catch(() => {
            this._emitClient({ type: 'error', message: 'Lost connection to the tutor', code: 'upstream-closed' });
          });
        } else if (!wasClosed) {
          this._emitClient({ type: 'error', message: 'Lost connection to the tutor', code: 'upstream-closed' });
        }
      });
    });
  }

  private _sendPersonaTurn(): void {
    const prompt = buildSystemPrompt({
      scenario: this.scenario,
      level: this.level,
      nativeLanguage: this.nativeLanguage,
      feedbackDetail: this.feedbackDetail,
      learnerName: this.learnerName,
    });
    this.turn.silent = true;
    this._sendUpstream(textUpstreamFrame(prompt));
  }

  private _sendUpstream(frame: GeminiUpstreamFrame): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private _emitClient(message: LiveEventMessage): void {
    this.emit('client', message);
  }

  private _clearTimers(): void {
    clearTimeout(this._thinkingTimer);
    clearTimeout(this._resumeTimer);
    clearTimeout(this._nudgeTimer);
    this._thinkingTimer = undefined;
    this._resumeTimer = undefined;
    this._nudgeTimer = undefined;
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
    if (this.gate.isGated()) return false;
    this._armThinkingTimer();
    this._sendUpstream(audioUpstreamFrame(base64Data));
    return true;
  }

  sendText(text: string): void {
    this._disarmSilenceNudge();
    this._sendUpstream(textUpstreamFrame(text));
  }

  say(text: string): void {
    this.turn.silent = true;
    this._sendUpstream(textUpstreamFrame(text));
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
  // most once per arm (SilenceNudge.shouldFire), and only speaks via say(),
  // which is already silent (no review, no score history pollution).
  armSilenceNudge(): void {
    this.nudge.arm();
    clearTimeout(this._nudgeTimer);
    this._nudgeTimer = setTimeout(() => {
      if (this.nudge.shouldFire()) {
        this.say(SILENCE_NUDGE_TEXT);
      }
    }, this.nudge.delayMs);
  }

  private _disarmSilenceNudge(): void {
    this.nudge.disarm();
    clearTimeout(this._nudgeTimer);
    this._nudgeTimer = undefined;
  }

  stop(): void {
    this.closed = true;
    this._clearTimers();
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
    if (msg.goAway) {
      this._emitClient({ type: 'going-away', timeLeft: msg.goAway.timeLeft });
    }
    // sessionResumptionUpdate intentionally ignored.
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
    this.gate.onTurnComplete();
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
      this._emitClient({ type: 'turn-complete', user: userText, assistant: assistantText, durationMs });
      const payload: ReviewRequestPayload = { user: userText, assistant: assistantText, level: this.level, learnerName: this.learnerName };
      this.emit('review-request', payload);
    }

    this.turn = freshTurn();
    this._resumeTimer = setTimeout(() => {
      this._emitClient({ type: 'state', value: 'listening' });
    }, this.gate.tailGuardMs);
  }
}
