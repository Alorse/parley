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

test('buildSystemPrompt mandates a recognizable retry invitation and forbids stacking a question onto a correction, in either feedback cadence', () => {
  for (const feedbackDetail of ['every-turn', 'mistakes-only']) {
    const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1', feedbackDetail });
    // The mandated invitation phrase — live.ts's compliance check keys off this.
    assert.match(prompt, /try saying|give that one a go/i);
    // A correction turn must end with the invitation, not a new question.
    assert.match(prompt, /do not ask a new question in the same turn/i);
    assert.match(prompt, /stop your turn right there/i);
  }
});

test('buildSystemPrompt gives the retry attempt a short acknowledgment instead of a fresh correction cycle, in either feedback cadence', () => {
  for (const feedbackDetail of ['every-turn', 'mistakes-only']) {
    const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1', feedbackDetail });
    assert.match(prompt, /retrying a phrase you had just corrected/i);
    assert.match(prompt, /short, warm acknowledgment/i);
    assert.match(prompt, /do not correct them again/i);
  }
});

test('buildSystemPrompt still asks a follow-up question when there is nothing to correct, in either feedback cadence', () => {
  for (const feedbackDetail of ['every-turn', 'mistakes-only']) {
    const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1', feedbackDetail });
    assert.match(prompt, /when you have nothing to correct.*ask one natural follow-up question/i);
  }
});

// --- learner name ------------------------------------------------------

test('buildSystemPrompt tells the tutor to ask for the learner\'s name when it is unknown', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1' });
  assert.match(prompt, /don't know the learner's name yet/i);
  assert.match(prompt, /ask for their name/i);
  assert.doesNotMatch(prompt, /The learner's name is/);
});

test('buildSystemPrompt tells the tutor the learner\'s name when known, and not to ask again', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1', learnerName: 'Marisol' });
  assert.match(prompt, /The learner's name is Marisol/);
  assert.match(prompt, /Do not ask for their name again/i);
  assert.doesNotMatch(prompt, /don't know the learner's name yet/i);
});

test('buildSystemPrompt instructs occasional, not constant, use of a known name', () => {
  const prompt = buildSystemPrompt({ scenario: 'Just talk', level: 'B1', learnerName: 'Kenji' });
  assert.match(prompt, /now and then/i);
  assert.match(prompt, /never in every turn/i);
});
