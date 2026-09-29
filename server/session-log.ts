import { randomUUID } from 'node:crypto';

// Structured, one-line lifecycle records for /live sessions, written to
// stdout so they land in the service journal (`journalctl -u parley`). Each
// line is `live-session {json}` with a short random session id, so one
// conversation can be followed from open to end with a single grep.
//
// Only lifecycle metadata belongs here: ids, models, close codes, counts and
// durations. Never learner speech, audio, the API key or a resumption handle.

export type SessionLogFields = Record<string, string | number | boolean | null | undefined>;
export type SessionLogger = (event: string, fields?: SessionLogFields) => void;

const MAX_REASON_LENGTH = 120;

export function newSessionId(): string {
  return randomUUID().slice(0, 8);
}

// Upstream close reasons are free text chosen by the remote end; keep them
// short and on one line.
export function cleanReason(reason: unknown): string {
  return String(reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_LENGTH);
}

export function formatSessionLog(sid: string, event: string, fields: SessionLogFields = {}): string {
  return `live-session ${JSON.stringify({ sid, event, ...fields })}`;
}

export function createSessionLogger(sid: string, write: (line: string) => void = console.log): SessionLogger {
  return (event, fields) => write(formatSessionLog(sid, event, fields));
}

export const noopSessionLogger: SessionLogger = () => {};
