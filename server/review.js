import { generateContent } from './gemini-client.js';

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER' },
    scores: {
      type: 'OBJECT',
      properties: {
        pronunciation: { type: 'INTEGER' },
        grammar: { type: 'INTEGER' },
        fluency: { type: 'INTEGER' },
      },
      required: ['pronunciation', 'grammar', 'fluency'],
    },
    corrections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          from: { type: 'STRING' },
          to: { type: 'STRING' },
          why: { type: 'STRING' },
        },
        required: ['from', 'to', 'why'],
      },
    },
    tip: { type: 'STRING' },
    words: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          meaning: { type: 'STRING' },
        },
        required: ['word', 'meaning'],
      },
    },
  },
  required: ['score', 'scores', 'corrections', 'tip', 'words'],
};

function emptyReview() {
  return {
    score: 0,
    scores: { pronunciation: 0, grammar: 0, fluency: 0 },
    corrections: [],
    tip: 'Say something out loud and I will give you a pronunciation tip.',
    words: [],
  };
}

export function buildReviewPrompt({ user, assistant, level }) {
  return `You are grading one turn of an English-speaking practice conversation for a learner at level ${level || 'B1'}.

The learner's transcribed speech (ground truth for what they said):
"""${user}"""

The tutor's own reply, for context only (not ground truth about what the learner said):
"""${assistant || ''}"""

Judge pronunciation, grammar, and fluency only from the learner's transcript above and the conversational context. Only report real errors that are actually present in the learner's text — never invent a correction. If the learner's text is empty or gibberish, return a score of 0 and no corrections.

Respond with JSON matching the required schema: an overall 0-100 score, per-category scores (pronunciation, grammar, fluency), at most 3 corrections (from/to/why), one short actionable pronunciation tip, and 0-4 notable words worth saving (word + short English meaning).`;
}

// Pure parsing/validation of the model's JSON text, so it is unit-testable
// without a network call.
export function parseReviewPayload(rawJsonText, { user } = {}) {
  const data = JSON.parse(rawJsonText);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const scores = data.scores || {};

  const result = {
    score: clamp(data.score),
    scores: {
      pronunciation: clamp(scores.pronunciation),
      grammar: clamp(scores.grammar),
      fluency: clamp(scores.fluency),
    },
    corrections: Array.isArray(data.corrections)
      ? data.corrections
          .slice(0, 3)
          .map((c) => ({ from: String(c.from ?? ''), to: String(c.to ?? ''), why: String(c.why ?? '') }))
      : [],
    tip: typeof data.tip === 'string' ? data.tip : '',
    words: Array.isArray(data.words)
      ? data.words.slice(0, 4).map((w) => ({ word: String(w.word ?? ''), meaning: String(w.meaning ?? '') }))
      : [],
  };

  if (!user || !user.trim()) {
    result.score = 0;
    result.corrections = [];
  }

  return result;
}

export async function review({ user, assistant, level, apiKey, model, fetchImpl = fetch }) {
  if (!user || !user.trim()) {
    return emptyReview();
  }

  const prompt = buildReviewPrompt({ user, assistant, level });
  const text = await generateContent({ apiKey, model, prompt, responseSchema: REVIEW_SCHEMA, fetchImpl });
  return parseReviewPayload(text, { user });
}

export { REVIEW_SCHEMA };
