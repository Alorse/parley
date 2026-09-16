import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRYABLE_STATUSES = new Set([429, 503]);

// Gemini's structured-output schema format (a restricted JSON Schema
// subset) — shared by REVIEW_SCHEMA in review.js and generateContent's
// responseSchema param below, so a mismatch between what's requested and
// what's parsed becomes a compile error instead of a silent drift.
export interface GeminiSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN';
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
}

interface GenerateContentBody {
  contents: { role: string; parts: { text: string }[] }[];
  generationConfig?: { responseMimeType: string; responseSchema: GeminiSchema };
}

export interface GenerateContentParams {
  apiKey: string;
  /** Single model to use when `models` is not given. */
  model?: string;
  /** Ordered fallback chain, tried in order until one succeeds. */
  models?: string[];
  prompt: string;
  /** Gemini structured-output schema; when set, forces JSON output. */
  responseSchema?: GeminiSchema;
  fetchImpl?: typeof fetch;
  retries?: number;
}

interface GeminiGenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

// Google's generateContent endpoint occasionally answers with a documented
// transient 503 ("high demand ... try again later") or 429 (rate limit /
// quota exhausted), independent of request shape — retry a couple of times
// with backoff before giving up on a given model.
async function requestModel({
  apiKey,
  model,
  body,
  fetchImpl,
  retries,
}: {
  apiKey: string;
  model: string;
  body: GenerateContentBody;
  fetchImpl: typeof fetch;
  retries: number;
}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`${ENDPOINT_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= retries) return res;
    await delay(1000 * (attempt + 1));
  }
}

// Tries each model in `models` (falling back to the single `model`) in
// order, moving to the next candidate whenever one exhausts its retries.
// This is what lets a per-model free-tier quota (429) or an overloaded
// model (503) fail over to a working model instead of surfacing an error.
export async function generateContent({
  apiKey,
  model,
  models,
  prompt,
  responseSchema,
  fetchImpl = fetch,
  retries = 2,
}: GenerateContentParams): Promise<string> {
  const chain: string[] = models && models.length ? models : model ? [model] : [];
  if (chain.length === 0) {
    throw new Error('generateContent requires at least one of `model` or `models`');
  }
  const body: GenerateContentBody = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (responseSchema) {
    body.generationConfig = { responseMimeType: 'application/json', responseSchema };
  }

  let lastError: Error | undefined;
  for (const candidate of chain) {
    const res = await requestModel({ apiKey, model: candidate, body, fetchImpl, retries });
    if (!res.ok) {
      lastError = new Error(`Gemini generateContent failed with status ${res.status} (model ${candidate})`);
      continue;
    }
    const data = (await res.json()) as GeminiGenerateContentResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      lastError = new Error(`Gemini generateContent response had no content (model ${candidate})`);
      continue;
    }
    return text;
  }
  throw lastError;
}
