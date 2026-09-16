import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateContent } from '../server/gemini-client.js';

function okResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  };
}

function errorResponse(status) {
  return { ok: false, status };
}

test('generateContent uses the single `model` when no `models` chain is given', async () => {
  const calledUrls = [];
  const text = await generateContent({
    apiKey: 'k',
    model: 'only-model',
    prompt: 'hi',
    fetchImpl: async (url) => {
      calledUrls.push(url);
      return okResponse('ok');
    },
  });
  assert.equal(text, 'ok');
  assert.equal(calledUrls.length, 1);
  assert.match(calledUrls[0], /\/only-model:generateContent/);
});

test('generateContent falls through the chain in order on 429 (quota exhausted), one request per model', async () => {
  const calledModels = [];
  const text = await generateContent({
    apiKey: 'k',
    models: ['model-a', 'model-b', 'model-c'],
    prompt: 'hi',
    retries: 2,
    fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      if (model !== 'model-c') return errorResponse(429);
      return okResponse('from model-c');
    },
  });
  assert.equal(text, 'from model-c');
  // A 429 is not retried — exactly one request per exhausted model, then
  // the chain moves on immediately.
  assert.deepEqual(calledModels, ['model-a', 'model-b', 'model-c']);
});

test('generateContent reaches the second model after a single request when the first is 429', async () => {
  const calledModels = [];
  const text = await generateContent({
    apiKey: 'k',
    models: ['exhausted', 'working'],
    prompt: 'hi',
    retries: 2,
    fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      if (model === 'exhausted') return errorResponse(429);
      return okResponse('from working');
    },
  });
  assert.equal(text, 'from working');
  assert.deepEqual(calledModels, ['exhausted', 'working']);
});

test('generateContent retries a 503 (overloaded) model before falling through', async () => {
  const calledModels = [];
  const text = await generateContent({
    apiKey: 'k',
    models: ['model-a', 'model-b'],
    prompt: 'hi',
    retries: 1,
    fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      if (model === 'model-a') return errorResponse(503);
      return okResponse('from model-b');
    },
  });
  assert.equal(text, 'from model-b');
  // Unlike 429, a 503 is retried (up to `retries` times) before the chain
  // advances — two attempts on model-a here (initial + 1 retry).
  assert.deepEqual(calledModels, ['model-a', 'model-a', 'model-b']);
});

test('generateContent stops at the first model that works and never calls later ones', async () => {
  const calledModels = [];
  await generateContent({
    apiKey: 'k',
    models: ['model-a', 'model-b'],
    prompt: 'hi',
    fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      return okResponse('from model-a');
    },
  });
  assert.deepEqual(calledModels, ['model-a']);
});

test('generateContent throws the last error when every model in the chain fails', async () => {
  await assert.rejects(
    () =>
      generateContent({
        apiKey: 'k',
        models: ['model-a', 'model-b'],
        prompt: 'hi',
        retries: 0,
        fetchImpl: async () => errorResponse(429),
      }),
    /model-b/,
  );
});
