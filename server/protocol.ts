// Shared wire-protocol types for the /live WebSocket, split into the two
// directions of travel. Mirrors test/protocol.test.js, which is the source
// of truth for the exact shapes below — keep the two in sync.
import type { ReviewResult } from './review.js';

// --- browser -> server ------------------------------------------------------

export interface StartMessage {
  type: 'start';
  scenario?: string;
  level?: string;
  voice?: string;
  halfDuplex?: boolean;
  feedbackDetail?: string;
}

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

// --- Gemini Live upstream (server <-> generativelanguage) --------------------

export interface GeminiSetupFrame {
  setup: {
    model: string;
    generationConfig: {
      responseModalities: string[];
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
    };
    inputAudioTranscription: Record<string, never>;
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

// The downstream frame received over the raw upstream WebSocket. setupComplete
// and sessionResumptionUpdate are only ever checked for presence, never read
// into, so they're left as `unknown`.
export interface GeminiServerFrame {
  setupComplete?: unknown;
  serverContent?: GeminiServerContent;
  goAway?: GeminiGoAway;
  sessionResumptionUpdate?: unknown;
}
