import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRYABLE_STATUSES = new Set([429, 503]);

/**
 * Google's generateContent endpoint occasionally answers with a documented
 * transient 503 ("high demand ... try again later") or 429 (rate limit /
 * quota exhausted), independent of request shape — retry a couple of times
 * with backoff before giving up on a given model.
 * @param {{ apiKey: string, model: string, body: object, fetchImpl: typeof fetch, retries: number }} params
 * @returns {Promise<Response>}
 */
async function requestModel({ apiKey, model, body, fetchImpl, retries }) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(`${ENDPOINT_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= retries) return res;
    await delay(1000 * (attempt + 1));
  }
}

/**
 * Tries each model in `models` (falling back to the single `model`) in
 * order, moving to the next candidate whenever one exhausts its retries.
 * This is what lets a per-model free-tier quota (429) or an overloaded
 * model (503) fail over to a working model instead of surfacing an error.
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.model] - single model to use when `models` is not given.
 * @param {string[]} [params.models] - ordered fallback chain, tried in order until one succeeds.
 * @param {string} params.prompt
 * @param {object} [params.responseSchema] - Gemini structured-output schema; when set, forces JSON output.
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.retries]
 * @returns {Promise<string>}
 */
export async function generateContent({ apiKey, model, models, prompt, responseSchema, fetchImpl = fetch, retries = 2 }) {
  const chain = models && models.length ? models : [model];
  /** @type {{ contents: object[], generationConfig?: { responseMimeType: string, responseSchema: object } }} */
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (responseSchema) {
    body.generationConfig = { responseMimeType: 'application/json', responseSchema };
  }

  /** @type {Error | undefined} */
  let lastError;
  for (const candidate of chain) {
    const res = await requestModel({ apiKey, model: candidate, body, fetchImpl, retries });
    if (!res.ok) {
      lastError = new Error(`Gemini generateContent failed with status ${res.status} (model ${candidate})`);
      continue;
    }
    /** @type {{ candidates?: { content?: { parts?: { text?: string }[] } }[] }} */
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      lastError = new Error(`Gemini generateContent response had no content (model ${candidate})`);
      continue;
    }
    return text;
  }
  throw lastError;
}
