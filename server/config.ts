import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

export interface ParleyConfig {
  googleApiKey: string;
  geminiLiveModel: string;
  geminiLiveModelFallbacks: string[];
  geminiTextModel: string;
  geminiTextModelFallbacks: string[];
  tutorVoice: string;
  port: number;
  accessTokens: string[];
  dataDir: string;
  maxSessions: number;
  warmupEnabled: boolean;
  // Upstream reconnects allowed per /live session, and the first backoff.
  liveMaxReconnects: number;
  liveReconnectBaseMs: number;
  // Upstream setup deadline, and how long past a reply's playback the
  // server waits for its turnComplete before completing the turn itself.
  liveSetupTimeoutMs: number;
  liveTurnWatchdogMs: number;
  root: string;
}

// Non-negative integer from the env, or the default when unset/invalid.
function parseCount(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Minimal .env parser: KEY=VALUE per line, '#' comments, blank lines ignored.
 * No quoting/escaping support — matches the simple values this project needs.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(): Record<string, string> {
  try {
    return parseEnv(readFileSync(ENV_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Comma-separated list, trimmed and empty-entries-filtered, falling back to
// `defaults` when the env var is unset/empty.
function parseModelList(value: string | undefined, defaults: string[]): string[] {
  if (!value) return defaults;
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : defaults;
}

export function buildConfig(env: Record<string, string> = { ...loadEnvFile(), ...filterProcessEnv() }): ParleyConfig {
  const googleApiKey = env.GOOGLE_API_KEY || '';
  if (!googleApiKey) {
    throw new Error('GOOGLE_API_KEY is required (set it in .env)');
  }
  return {
    googleApiKey,
    geminiLiveModel: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
    geminiLiveModelFallbacks: parseModelList(env.GEMINI_LIVE_MODEL_FALLBACKS, ['gemini-3.1-flash-live-preview']),
    geminiTextModel: env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash-lite',
    geminiTextModelFallbacks: parseModelList(env.GEMINI_TEXT_MODEL_FALLBACKS, [
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-3.6-flash',
    ]),
    tutorVoice: env.TUTOR_VOICE || 'Kore',
    port: Number(env.PORT) || 8080,
    accessTokens: (env.ACCESS_TOKENS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    dataDir: env.DATA_DIR || '.data',
    maxSessions: Number(env.MAX_SESSIONS) || 4,
    warmupEnabled: env.WARMUP !== '0',
    liveMaxReconnects: parseCount(env.PARLEY_MAX_RECONNECTS, 8),
    liveReconnectBaseMs: parseCount(env.PARLEY_RECONNECT_BASE_MS, 500),
    liveSetupTimeoutMs: parseCount(env.PARLEY_SETUP_TIMEOUT_MS, 15000),
    liveTurnWatchdogMs: parseCount(env.PARLEY_TURN_WATCHDOG_MS, 10000),
    root: ROOT,
  };
}

// process.env only overrides file values for keys that are actually set,
// so an empty shell env doesn't blank out .env values.
function filterProcessEnv(): Record<string, string> {
  const keys = [
    'GOOGLE_API_KEY',
    'GEMINI_LIVE_MODEL',
    'GEMINI_LIVE_MODEL_FALLBACKS',
    'GEMINI_TEXT_MODEL',
    'GEMINI_TEXT_MODEL_FALLBACKS',
    'TUTOR_VOICE',
    'PORT',
    'ACCESS_TOKENS',
    'DATA_DIR',
    'MAX_SESSIONS',
    'WARMUP',
    'PARLEY_MAX_RECONNECTS',
    'PARLEY_RECONNECT_BASE_MS',
    'PARLEY_SETUP_TIMEOUT_MS',
    'PARLEY_TURN_WATCHDOG_MS',
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const config: ParleyConfig = buildConfig();
