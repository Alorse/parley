import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewPayload, review, buildReviewPrompt } from '../server/review.js';

test('parseReviewPayload parses a well-formed JSON payload', () => {
  const raw = JSON.stringify({
    understood: true,
    score: 82,
    scores: { pronunciation: 80, grammar: 90, fluency: 76 },
    corrections: [{ from: 'I go to…', to: 'I went to…', why: 'past tense' }],
    tip: 'Link the final consonant to the next word.',
    words: [{ word: 'appointment', meaning: 'a scheduled meeting' }],
  });
  const result = parseReviewPayload(raw, { user: 'I go to the doctor yesterday' });
  assert.equal(result.understood, true);
  assert.equal(result.score, 82);
  assert.deepEqual(result.scores, { pronunciation: 80, grammar: 90, fluency: 76 });
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].to, 'I went to…');
  assert.equal(result.words[0].word, 'appointment');
});

test('parseReviewPayload clamps out-of-range scores', () => {
  const raw = JSON.stringify({
    understood: true,
    score: 150,
    scores: { pronunciation: -20, grammar: 999, fluency: 50.6 },
    corrections: [],
    tip: 'Nice work.',
    words: [],
  });
  const result = parseReviewPayload(raw, { user: 'hello' });
  assert.equal(result.score, 100);
  assert.equal(result.scores.pronunciation, 0);
  assert.equal(result.scores.grammar, 100);
  assert.equal(result.scores.fluency, 51);
});

test('parseReviewPayload caps corrections at 3 and words at 4', () => {
  const raw = JSON.stringify({
    understood: true,
    score: 50,
    scores: { pronunciation: 50, grammar: 50, fluency: 50 },
    corrections: [1, 2, 3, 4, 5].map((i) => ({ from: `f${i}`, to: `t${i}`, why: `w${i}` })),
    tip: 'ok',
    words: [1, 2, 3, 4, 5, 6].map((i) => ({ word: `w${i}`, meaning: `m${i}` })),
  });
  const result = parseReviewPayload(raw, { user: 'hello' });
  assert.equal(result.corrections.length, 3);
  assert.equal(result.words.length, 4);
});

test('parseReviewPayload forces score 0 and no corrections when the user text is empty', () => {
  const raw = JSON.stringify({
    score: 90,
    scores: { pronunciation: 90, grammar: 90, fluency: 90 },
    corrections: [{ from: 'a', to: 'b', why: 'c' }],
    tip: 'Try speaking next time.',
    words: [],
  });
  const result = parseReviewPayload(raw, { user: '   ' });
  assert.equal(result.understood, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.corrections, []);
});

test('parseReviewPayload throws on invalid JSON', () => {
  assert.throws(() => parseReviewPayload('not json', { user: 'hi' }));
});

test('parseReviewPayload reports understood=true for a normal, intelligible transcript', () => {
  const raw = JSON.stringify({
    understood: true,
    score: 65,
    scores: { pronunciation: 65, grammar: 65, fluency: 65 },
    corrections: [],
    tip: 'Nice pacing.',
    words: [],
  });
  const result = parseReviewPayload(raw, { user: 'I went to the market this morning' });
  assert.equal(result.understood, true);
  assert.equal(result.score, 65);
});

test('parseReviewPayload reports understood=false and floors score to 0 when the model says the speech was not intelligible', () => {
  const raw = JSON.stringify({
    understood: false,
    score: 60,
    scores: { pronunciation: 60, grammar: 60, fluency: 60 },
    corrections: [],
    tip: '',
    words: [],
  });
  // Non-empty transcript (e.g. hallucinated/partial ASR) but the model itself
  // says it did not understand it — the reported score must still floor to 0
  // even though the model's own `score` field disagreed.
  const result = parseReviewPayload(raw, { user: 'mmmff garble noise' });
  assert.equal(result.understood, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.corrections, []);
});

test('review() short-circuits to a zero score without calling the network for empty user text', async () => {
  let called = false;
  const result = await review({
    user: '',
    assistant: 'Hi there!',
    level: 'B1',
    apiKey: 'unused',
    model: 'unused',
    fetchImpl: async () => {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(called, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.corrections, []);
});

test('review() parses the model response text from the generateContent envelope', async () => {
  const payload = {
    understood: true,
    score: 70,
    scores: { pronunciation: 70, grammar: 70, fluency: 70 },
    corrections: [],
    tip: 'Watch your vowel length.',
    words: [],
  };
  const result = await review({
    user: 'I would like a coffee please',
    assistant: 'Sure, one coffee coming up!',
    level: 'A2',
    apiKey: 'unused',
    model: 'unused',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    }),
  });
  assert.equal(result.score, 70);
  assert.equal(result.tip, 'Watch your vowel length.');
});

// --- name capture -------------------------------------------------------

test('parseReviewPayload reports a captured name from the model payload', () => {
  const raw = JSON.stringify({
    understood: true,
    score: 80,
    scores: { pronunciation: 80, grammar: 80, fluency: 80 },
    corrections: [],
    tip: 'Nice pacing.',
    words: [],
    name: 'Marisol',
  });
  const result = parseReviewPayload(raw, { user: "Hi, I'm Marisol, nice to meet you" });
  assert.equal(result.name, 'Marisol');
});

test('parseReviewPayload defaults name to an empty string when absent from the payload', () => {
  const raw = JSON.stringify({
    understood: true,
    score: 80,
    scores: { pronunciation: 80, grammar: 80, fluency: 80 },
    corrections: [],
    tip: 'Nice pacing.',
    words: [],
  });
  const result = parseReviewPayload(raw, { user: 'I went for a walk' });
  assert.equal(result.name, '');
});

test('parseReviewPayload drops a captured name when the turn was not understood', () => {
  const raw = JSON.stringify({
    understood: false,
    score: 40,
    scores: { pronunciation: 40, grammar: 40, fluency: 40 },
    corrections: [],
    tip: '',
    words: [],
    name: 'Marisol',
  });
  const result = parseReviewPayload(raw, { user: 'mmmff garble noise' });
  assert.equal(result.understood, false);
  assert.equal(result.name, '', 'a misheard/hallucinated turn must not (re)write the learner identity');
});

test('buildReviewPrompt asks the model to extract the learner\'s name when it is not yet known', () => {
  const prompt = buildReviewPrompt({ user: "I'm Kenji", level: 'B1' });
  assert.match(prompt, /states their own name/i);
  assert.doesNotMatch(prompt, /already known/i);
});

test('buildReviewPrompt tells the model to leave name empty once it is already known', () => {
  const prompt = buildReviewPrompt({ user: 'Hello again', level: 'B1', learnerName: 'Kenji' });
  assert.match(prompt, /already known/i);
  assert.match(prompt, /leave "name" as an empty string/i);
});

test('review() forwards learnerName into the prompt sent to the model', async () => {
  let sentPrompt = '';
  const payload = {
    understood: true,
    score: 70,
    scores: { pronunciation: 70, grammar: 70, fluency: 70 },
    corrections: [],
    tip: 'ok',
    words: [],
    name: '',
  };
  await review({
    user: 'hello again',
    assistant: '',
    level: 'B1',
    learnerName: 'Kenji',
    apiKey: 'unused',
    model: 'unused',
    fetchImpl: async (_url, opts) => {
      sentPrompt = JSON.parse(opts.body).contents[0].parts[0].text;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) };
    },
  });
  assert.match(sentPrompt, /already known/i);
});

test('review() throws when the upstream request fails', async () => {
  await assert.rejects(() =>
    review({
      user: 'hello',
      assistant: '',
      level: 'B1',
      apiKey: 'unused',
      model: 'unused',
      fetchImpl: async () => ({ ok: false, status: 500 }),
    }),
  );
});
