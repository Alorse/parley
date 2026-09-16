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
  assert.equal(cfg.geminiTextModel, 'gemini-3.8-flash');
  assert.equal(cfg.tutorVoice, 'Kore');
  assert.equal(cfg.port, 8322);
  assert.deepEqual(cfg.accessTokens, []);
  assert.equal(cfg.dataDir, '.data');
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

test('buildConfig throws without an API key', () => {
  assert.throws(() => buildConfig({}), /GOOGLE_API_KEY/);
});
