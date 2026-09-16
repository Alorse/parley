import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, buildConfig } from '../server/config.js';

test('parseEnv reads KEY=VALUE lines', () => {
  const env = parseEnv('FOO=bar\nBAZ=qux\n');
  assert.equal(env.FOO, 'bar');
  assert.equal(env.BAZ, 'qux');
});

test('parseEnv skips blank lines and comments', () => {
  const env = parseEnv('# a comment\n\nFOO=bar\n  # indented comment\nBAZ=qux\n');
  assert.deepEqual(env, { FOO: 'bar', BAZ: 'qux' });
});

test('parseEnv strips surrounding quotes', () => {
  const env = parseEnv('FOO="bar baz"\nQUX=\'single\'\n');
  assert.equal(env.FOO, 'bar baz');
  assert.equal(env.QUX, 'single');
});

test('parseEnv trims whitespace around key and value', () => {
  const env = parseEnv('  FOO  =  bar  \n');
  assert.equal(env.FOO, 'bar');
});

test('buildConfig applies defaults when only the required key is set', () => {
  const cfg = buildConfig({ GOOGLE_API_KEY: 'test-key' });
  assert.equal(cfg.googleApiKey, 'test-key');
  assert.equal(cfg.geminiLiveModel, 'gemini-3.8-live');
  assert.equal(cfg.geminiTextModel, 'gemini-3.5-flash-lite');
  assert.equal(cfg.tutorVoice, 'Kore');
  assert.equal(cfg.port, 8080);
  assert.deepEqual(cfg.accessTokens, []);
  assert.equal(cfg.dataDir, '.data');
  assert.deepEqual(cfg.geminiLiveModelFallbacks, ['gemini-3.1-flash-live-preview']);
  assert.deepEqual(cfg.geminiTextModelFallbacks, ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.6-flash']);
});

test('buildConfig overrides defaults from env', () => {
  const cfg = buildConfig({
    GOOGLE_API_KEY: 'k',
    GEMINI_LIVE_MODEL: 'custom-live',
    PORT: '9000',
    ACCESS_TOKENS: 'a, b ,c',
  });
  assert.equal(cfg.geminiLiveModel, 'custom-live');
  assert.equal(cfg.port, 9000);
  assert.deepEqual(cfg.accessTokens, ['a', 'b', 'c']);
});

test('buildConfig parses the text/live model fallback chains from env, preserving order', () => {
  const cfg = buildConfig({
    GOOGLE_API_KEY: 'k',
    GEMINI_TEXT_MODEL_FALLBACKS: ' model-a, model-b ,model-c',
    GEMINI_LIVE_MODEL_FALLBACKS: 'live-fallback-1,live-fallback-2',
  });
  assert.deepEqual(cfg.geminiTextModelFallbacks, ['model-a', 'model-b', 'model-c']);
  assert.deepEqual(cfg.geminiLiveModelFallbacks, ['live-fallback-1', 'live-fallback-2']);
});

test('buildConfig falls back to defaults when the fallback env vars are empty', () => {
  const cfg = buildConfig({ GOOGLE_API_KEY: 'k', GEMINI_TEXT_MODEL_FALLBACKS: '', GEMINI_LIVE_MODEL_FALLBACKS: '  ' });
  assert.deepEqual(cfg.geminiTextModelFallbacks, ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.6-flash']);
  assert.deepEqual(cfg.geminiLiveModelFallbacks, ['gemini-3.1-flash-live-preview']);
});

test('buildConfig throws without an API key', () => {
  assert.throws(() => buildConfig({}), /GOOGLE_API_KEY/);
});
