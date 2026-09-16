import { generateContent } from './gemini-client.js';

export interface WarmUpParams {
  apiKey: string;
  /** Primary model first, optionally one fallback — at most 2 API calls. */
  models: string[];
  fetchImpl?: typeof fetch;
}

// Fire-and-forget: makes one cheap call to the primary text model (with at
// most one fall-through to the next model in the chain, never a retry) so
// the first real request after a restart doesn't pay Gemini's occasional
// cold-start latency. A failed warm-up must look exactly like no warm-up
// ever ran — it never throws, and it logs at most one line.
export async function warmUp({ apiKey, models, fetchImpl = fetch }: WarmUpParams): Promise<void> {
  try {
    await generateContent({
      apiKey,
      models: models.slice(0, 2),
      prompt: 'Reply with the single word: ok',
      fetchImpl,
      retries: 0,
    });
  } catch (err) {
    console.error('warm-up call failed (ignored):', err instanceof Error ? err.message : String(err));
  }
}
