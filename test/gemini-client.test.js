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

test('generateContent falls through the chain in order on 429 (quota exhausted)', async () => {
  const calledModels = [];
  const text = await generateContent({
    apiKey: 'k',
    models: ['model-a', 'model-b', 'model-c'],
    prompt: 'hi',
    retries: 0,
    fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      if (model !== 'model-c') return errorResponse(429);
      return okResponse('from model-c');
    },
  });
  assert.equal(text, 'from model-c');
  assert.deepEqual(calledModels, ['model-a', 'model-b', 'model-c']);
});

test('generateContent falls through on 503 (overloaded) the same way as 429', async () => {
  const calledModels = [];
  const text = await generateContent({
    apiKey: 'k',
    models: ['model-a', 'model-b'],
    prompt: 'hi',
    retries: 0,
    fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      if (model === 'model-a') return errorResponse(503);
      return okResponse('from model-b');
    },
  });
  assert.equal(text, 'from model-b');
  assert.deepEqual(calledModels, ['model-a', 'model-b']);
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
