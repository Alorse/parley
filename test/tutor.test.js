import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/tutor.js';

test('buildSystemPrompt injects the scenario', () => {
  const prompt = buildSystemPrompt({ scenario: 'A café', level: 'B1' });
  assert.match(prompt, /A café/);
});

test('buildSystemPrompt injects the level guidance', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'A1' });
  assert.match(prompt, /level A1/);
  assert.match(prompt, /very simple, short sentences/);
});

test('buildSystemPrompt falls back to B1 for an unknown level', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'not-a-level' });
  assert.match(prompt, /level B1/);
});

test('buildSystemPrompt describes an open conversation when scenario is "Just talk"', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1' });
  assert.match(prompt, /no fixed scenario/);
});

test('buildSystemPrompt is English-only (no CJK characters)', () => {
  const prompt = buildSystemPrompt({ scenario: 'Job interview', level: 'C1', nativeLanguage: 'Spanish' });
  // Reject any CJK Unified Ideographs / Hiragana / Katakana code points.
  assert.doesNotMatch(prompt, /[一-鿿぀-ヿ]/);
});

test('buildSystemPrompt never instructs the model to break character or reveal it is an AI', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1' });
  assert.match(prompt, /Never mention being an AI/);
  assert.match(prompt, /Never break character/);
});

test('buildSystemPrompt never instructs the model to speak a score, in either feedback cadence', () => {
  for (const feedbackDetail of ['every-turn', 'mistakes-only']) {
    const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1', feedbackDetail });
    assert.doesNotMatch(prompt, /score out loud/i);
    assert.doesNotMatch(prompt, /0-100/);
    assert.doesNotMatch(prompt, /about eighty/i);
    assert.doesNotMatch(prompt, /and a score/i);
    assert.match(prompt, /non-evaluative encouragement/i);
    assert.match(prompt, /never a score, a number, a percentage/i);
  }
});
