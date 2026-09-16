import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRYABLE_STATUSES = new Set([429, 503]);

// Google's generateContent endpoint occasionally answers with a documented
// transient 503 ("high demand ... try again later") or 429 (rate limit),
// independent of request shape — retry a couple of times with backoff
// before giving up.
export async function generateContent({ apiKey, model, prompt, responseSchema, fetchImpl = fetch, retries = 2 }) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (responseSchema) {
    body.generationConfig = { responseMimeType: 'application/json', responseSchema };
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(`${ENDPOINT_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= retries) break;
    await delay(1000 * (attempt + 1));
  }

  if (!res.ok) {
    throw new Error(`Gemini generateContent failed with status ${res.status}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini generateContent response had no content');
  }
  return text;
}
