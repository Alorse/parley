import { setTimeout as delay } from 'node:timers/promises';

// Polls until predicate() is true or the deadline passes; resolves to its
// last value. Real timers run late on a loaded machine, so tests poll for
// an outcome instead of sleeping a fixed time.
export async function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}
