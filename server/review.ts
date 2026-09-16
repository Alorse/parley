import { generateContent, type GeminiSchema } from './gemini-client.js';

export interface ReviewCorrection {
  from: string;
  to: string;
  why: string;
}

export interface ReviewWord {
  word: string;
  meaning: string;
}

// The shape generateContent's REVIEW_SCHEMA-constrained JSON is parsed into
// below — kept next to REVIEW_SCHEMA so the two can't silently drift apart.
export interface ReviewResult {
  understood: boolean;
  score: number;
  scores: {
    pronunciation: number;
    grammar: number;
    fluency: number;
  };
  corrections: ReviewCorrection[];
  tip: string;
  words: ReviewWord[];
}

const REVIEW_SCHEMA: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    understood: { type: 'BOOLEAN' },
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
  required: ['understood', 'score', 'scores', 'corrections', 'tip', 'words'],
};

function emptyReview(): ReviewResult {
  return {
    understood: false,
    score: 0,
    scores: { pronunciation: 0, grammar: 0, fluency: 0 },
    corrections: [],
    tip: 'Say something out loud and I will give you a pronunciation tip.',
    words: [],
  };
}

export interface BuildReviewPromptParams {
  user: string;
  assistant?: string;
  level?: string;
}

export function buildReviewPrompt({ user, assistant, level }: BuildReviewPromptParams): string {
  return `You are grading one turn of an English-speaking practice conversation for a learner at level ${level || 'B1'}.

The learner's transcribed speech (ground truth for what they said):
"""${user}"""

The tutor's own reply, for context only (not ground truth about what the learner said):
"""${assistant || ''}"""

Judge pronunciation, grammar, and fluency only from the learner's transcript above and the conversational context. Only report real errors that are actually present in the learner's text — never invent a correction. If the learner's transcript is not intelligible speech at all (empty, gibberish, or noise), set understood to false and score to 0, with no corrections — never guess a middle-of-the-range score for speech you could not actually understand.

Respond with JSON matching the required schema: whether the learner's speech was actually understood (boolean), an overall 0-100 score, per-category scores (pronunciation, grammar, fluency), at most 3 corrections (from/to/why), one short actionable pronunciation tip, and 0-4 notable words worth saving (word + short English meaning).`;
}

export interface ParseReviewPayloadOptions {
  user?: string;
}

// Pure parsing/validation of the model's JSON text, so it is unit-testable
// without a network call. `data` is deliberately untyped past JSON.parse —
// it's untrusted model output, validated field-by-field below rather than
// trusted via a cast.
export function parseReviewPayload(rawJsonText: string, { user }: ParseReviewPayloadOptions = {}): ReviewResult {
  const data = JSON.parse(rawJsonText);
  const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const scores = data.scores || {};

  const result: ReviewResult = {
    understood: Boolean(data.understood),
    score: clamp(data.score),
    scores: {
      pronunciation: clamp(scores.pronunciation),
      grammar: clamp(scores.grammar),
      fluency: clamp(scores.fluency),
    },
    corrections: Array.isArray(data.corrections)
      ? data.corrections
          .slice(0, 3)
          .map((c: { from?: unknown; to?: unknown; why?: unknown }) => ({
            from: String(c.from ?? ''),
            to: String(c.to ?? ''),
            why: String(c.why ?? ''),
          }))
      : [],
    tip: typeof data.tip === 'string' ? data.tip : '',
    words: Array.isArray(data.words)
      ? data.words
          .slice(0, 4)
          .map((w: { word?: unknown; meaning?: unknown }) => ({ word: String(w.word ?? ''), meaning: String(w.meaning ?? '') }))
      : [],
  };

  if (!user || !user.trim()) {
    result.understood = false;
  }

  // Never trust the model's own score when it says (or the text implies) it
  // didn't understand the turn — a hallucinated transcript can otherwise
  // still carry a plausible-looking score straight through.
  if (!result.understood) {
    result.score = 0;
    result.corrections = [];
  }

  return result;
}

export interface ReviewParams {
  user: string;
  assistant?: string;
  level?: string;
  apiKey: string;
  model?: string;
  models?: string[];
  fetchImpl?: typeof fetch;
}

export async function review({ user, assistant, level, apiKey, model, models, fetchImpl = fetch }: ReviewParams): Promise<ReviewResult> {
  const result = await (async () => {
    if (!user || !user.trim()) {
      return emptyReview();
    }

    const prompt = buildReviewPrompt({ user, assistant, level });
    const text = await generateContent({ apiKey, model, models, prompt, responseSchema: REVIEW_SCHEMA, fetchImpl });
    return parseReviewPayload(text, { user });
  })();

  if (!result.understood) {
    console.warn('review: turn not understood, flooring score to 0', { user });
  }

  return result;
}

export { REVIEW_SCHEMA };
