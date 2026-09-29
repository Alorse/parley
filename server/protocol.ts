// Shared wire-protocol types for the /live WebSocket, split into the two
// directions of travel. Mirrors test/protocol.test.js, which is the source
// of truth for the exact shapes below — keep the two in sync.
//
// Audio travels as binary WebSocket frames of raw PCM16 mono (#24): 16 kHz
// from the mic, 24 kHz from the tutor. Everything else is a JSON text frame.
// A client whose `start` doesn't say `binary: true` (a stale cached app from
// before binary frames) sends and gets `{type:'audio', data:<base64>}`
// instead; the server takes both.
import type { ReviewResult } from './review.js';

// --- browser -> server ------------------------------------------------------

export interface StartMessage {
  type: 'start';
  scenario?: string;
  level?: string;
  voice?: string;
  halfDuplex?: boolean;
  feedbackDetail?: string;
  name?: string;
  // A short line (or a few, cap-joined) from the learner's on-device memory
  // — see public/data.js's getMemoryNote — so the tutor can reference an
  // earlier conversation. Never stored server-side: forwarded straight into
  // the persona prompt and otherwise forgotten once the session ends.
  memoryNote?: string;
  // A random id the app keeps per device (per browser profile), shared by
  // its tabs and the installed app. A newer conversation with the same id
  // takes over from the older one (#19).
  clientId?: string;
  // The client takes the tutor's audio as binary frames (#24).
  binary?: boolean;
}

// A binary mic frame is decoded to this, same as the JSON form.
export interface AudioMessage {
  type: 'audio';
  data: string;
}

export interface TextMessage {
  type: 'text';
  text: string;
}

export interface SayMessage {
  type: 'say';
  text: string;
}

export interface InterruptMessage {
  type: 'interrupt';
}

export interface StopMessage {
  type: 'stop';
}

export type ClientMessage = StartMessage | AudioMessage | TextMessage | SayMessage | InterruptMessage | StopMessage;

// --- server -> browser -------------------------------------------------------

export interface ReadyMessage {
  type: 'ready';
}

export interface AudioServerMessage {
  type: 'audio';
  data: string;
}

export interface StateMessage {
  type: 'state';
  value: 'thinking' | 'speaking' | 'listening';
}

export interface InputTextMessage {
  type: 'input-text';
  text: string;
  final: boolean;
}

export interface OutputTextMessage {
  type: 'output-text';
  text: string;
  final: boolean;
}

export interface TurnCompleteMessage {
  type: 'turn-complete';
  user: string;
  assistant: string;
  durationMs: number;
}

export interface InterruptedMessage {
  type: 'interrupted';
}

export interface ReconnectingMessage {
  type: 'reconnecting';
}

export interface GoingAwayMessage {
  type: 'going-away';
  timeLeft?: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

// Emitted by GeminiLiveSession's 'client' event (see live.ts) — everything
// server->client except the review result, which index.ts sends separately
// once server/review.ts finishes grading the turn.
export type LiveEventMessage =
  | ReadyMessage
  | AudioServerMessage
  | StateMessage
  | InputTextMessage
  | OutputTextMessage
  | TurnCompleteMessage
  | InterruptedMessage
  | ReconnectingMessage
  | GoingAwayMessage
  | ErrorMessage;

export type ReviewMessage = ({ type: 'review' } & ReviewResult) | { type: 'review'; error: string };

export type ServerMessage = LiveEventMessage | ReviewMessage;

// --- codec --------------------------------------------------------------------

// One /live frame from the browser; null if it is not valid JSON.
export function parseClientFrame(raw: Buffer, isBinary: boolean): ClientMessage | null {
  // The upstream takes base64 in JSON, so the mic's bytes are encoded once
  // here, on the server, instead of in the browser and on the wire.
  if (isBinary) return { type: 'audio', data: raw.toString('base64') };
  try {
    return JSON.parse(raw.toString()) as ClientMessage;
  } catch {
    return null;
  }
}

// One /live frame to the browser: tutor audio as raw PCM for a client that
// announced `binary`, JSON for everything else.
export function encodeServerMessage(message: ServerMessage, binaryAudio: boolean): string | Buffer {
  if (binaryAudio && message.type === 'audio') return Buffer.from(message.data, 'base64');
  return JSON.stringify(message);
}

// --- Gemini Live upstream (server <-> generativelanguage) --------------------

export interface GeminiSetupFrame {
  setup: {
    model: string;
    systemInstruction?: { parts: { text: string }[] };
    sessionResumption: { handle?: string };
    generationConfig: {
      responseModalities: string[];
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
    };
    inputAudioTranscription: { languageCodes: string[] };
    outputAudioTranscription: Record<string, never>;
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: boolean;
        startOfSpeechSensitivity: string;
        endOfSpeechSensitivity: string;
        silenceDurationMs: number;
        prefixPaddingMs: number;
      };
    };
  };
}

export interface GeminiAudioUpstreamFrame {
  realtimeInput: { audio: { data: string; mimeType: string } };
}

export interface GeminiTextUpstreamFrame {
  clientContent: { turns: { role: string; parts: { text: string }[] }[]; turnComplete: boolean };
}

export type GeminiUpstreamFrame = GeminiAudioUpstreamFrame | GeminiTextUpstreamFrame;

export interface GeminiInlineData {
  mimeType?: string;
  data: string;
}

export interface GeminiPart {
  inlineData?: GeminiInlineData;
}

export interface GeminiServerContent {
  interrupted?: boolean;
  modelTurn?: { parts?: GeminiPart[] };
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  turnComplete?: boolean;
}

export interface GeminiGoAway {
  timeLeft?: string;
}

export interface GeminiSessionResumptionUpdate {
  newHandle?: string;
  resumable?: boolean;
}

// The downstream frame received over the raw upstream WebSocket.
// setupComplete is only ever checked for presence, so it's left `unknown`.
export interface GeminiServerFrame {
  setupComplete?: unknown;
  serverContent?: GeminiServerContent;
  goAway?: GeminiGoAway;
  sessionResumptionUpdate?: GeminiSessionResumptionUpdate;
}
