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
  root: string;
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
    geminiTextModel: env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash',
    geminiTextModelFallbacks: parseModelList(env.GEMINI_TEXT_MODEL_FALLBACKS, [
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-3.5-flash',
    ]),
    tutorVoice: env.TUTOR_VOICE || 'Kore',
    port: Number(env.PORT) || 8080,
    accessTokens: (env.ACCESS_TOKENS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    dataDir: env.DATA_DIR || '.data',
    maxSessions: Number(env.MAX_SESSIONS) || 4,
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
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const config: ParleyConfig = buildConfig();
