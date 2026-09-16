import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warmUp } from '../server/warmup.js';

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

test('warmUp makes a single call to the primary model on success', async () => {
  const calledModels = [];
  await warmUp({
    apiKey: 'k',
    models: ['primary', 'fallback'],
    fetchImpl: async (url) => {
      calledModels.push(url.match(/models\/([^:]+):/)[1]);
      return okResponse('ok');
    },
  });
  assert.deepEqual(calledModels, ['primary']);
});

test('warmUp never throws and logs at most once when every model fails', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const calledModels = [];
    await assert.doesNotReject(() =>
      warmUp({
        apiKey: 'k',
        models: ['primary', 'fallback'],
        fetchImpl: async (url) => {
          calledModels.push(url.match(/models\/([^:]+):/)[1]);
          return errorResponse(429);
        },
      }),
    );
    // No retry on 429, one fall-through to the next model: 2 calls max.
    assert.deepEqual(calledModels, ['primary', 'fallback']);
    assert.equal(logs.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('warmUp does not retry a 503 and still never throws', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const calledModels = [];
    await warmUp({
      apiKey: 'k',
      models: ['primary'],
      fetchImpl: async (url) => {
        calledModels.push(url.match(/models\/([^:]+):/)[1]);
        return errorResponse(503);
      },
    });
    assert.deepEqual(calledModels, ['primary']);
    assert.equal(logs.length, 1);
  } finally {
    console.error = originalError;
  }
});
