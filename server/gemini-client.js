import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRYABLE_STATUSES = new Set([429, 503]);

// Google's generateContent endpoint occasionally answers with a documented
// transient 503 ("high demand ... try again later") or 429 (rate limit /
// quota exhausted), independent of request shape — retry a couple of times
// with backoff before giving up on a given model.
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

// Tries each model in `models` (falling back to the single `model`) in
// order, moving to the next candidate whenever one exhausts its retries.
// This is what lets a per-model free-tier quota (429) or an overloaded
// model (503) fail over to a working model instead of surfacing an error.
export async function generateContent({ apiKey, model, models, prompt, responseSchema, fetchImpl = fetch, retries = 2 }) {
  const chain = models && models.length ? models : [model];
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (responseSchema) {
    body.generationConfig = { responseMimeType: 'application/json', responseSchema };
  }

  let lastError;
  for (const candidate of chain) {
    const res = await requestModel({ apiKey, model: candidate, body, fetchImpl, retries });
    if (!res.ok) {
      lastError = new Error(`Gemini generateContent failed with status ${res.status} (model ${candidate})`);
      continue;
    }
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
