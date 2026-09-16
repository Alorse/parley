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
  // The learner's own name, only when they actually stated it in this turn
  // and it wasn't already known — empty string otherwise. See
  // buildReviewPrompt's nameInstruction for why this never overwrites a name
  // that's already known.
  name: string;
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
    name: { type: 'STRING' },
  },
  required: ['understood', 'score', 'scores', 'corrections', 'tip', 'words', 'name'],
};

function emptyReview(): ReviewResult {
  return {
    understood: false,
    score: 0,
    scores: { pronunciation: 0, grammar: 0, fluency: 0 },
    corrections: [],
    tip: 'Say something out loud and I will give you a pronunciation tip.',
    words: [],
    name: '',
  };
}

export interface BuildReviewPromptParams {
  user: string;
  assistant?: string;
  level?: string;
  learnerName?: string;
}

export function buildReviewPrompt({ user, assistant, level, learnerName }: BuildReviewPromptParams): string {
  const nameInstruction = learnerName
    ? 'The learner\'s name is already known, so always leave "name" as an empty string.'
    : 'If the learner states their own name in this turn (e.g. "My name is X", "I\'m X", "Call me X"), report it in "name". Otherwise leave "name" as an empty string. Never guess or invent a name, and never report anyone\'s name but the learner\'s own.';

  return `You are grading one turn of an English-speaking practice conversation for a learner at level ${level || 'B1'}.

The learner's transcribed speech (ground truth for what they said):
"""${user}"""

The tutor's own reply, for context only (not ground truth about what the learner said):
"""${assistant || ''}"""

Judge pronunciation, grammar, and fluency only from the learner's transcript above and the conversational context. Only report real errors that are actually present in the learner's text — never invent a correction. If the learner's transcript is not intelligible speech at all (empty, gibberish, or noise), set understood to false and score to 0, with no corrections — never guess a middle-of-the-range score for speech you could not actually understand.

${nameInstruction}

Respond with JSON matching the required schema: whether the learner's speech was actually understood (boolean), an overall 0-100 score, per-category scores (pronunciation, grammar, fluency), at most 3 corrections (from/to/why), one short actionable pronunciation tip, 0-4 notable words worth saving (word + short English meaning), and the learner's own name if captured this turn (see above).`;
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
    name: typeof data.name === 'string' ? data.name.trim() : '',
  };

  if (!user || !user.trim()) {
    result.understood = false;
  }

  // Never trust the model's own score when it says (or the text implies) it
  // didn't understand the turn — a hallucinated transcript can otherwise
  // still carry a plausible-looking score straight through. Same reasoning
  // applies to a "captured" name: a misheard/hallucinated turn is not
  // grounds to (re)write the learner's identity.
  if (!result.understood) {
    result.score = 0;
    result.corrections = [];
    result.name = '';
  }

  return result;
}

export interface ReviewParams {
  user: string;
  assistant?: string;
  level?: string;
  learnerName?: string;
  apiKey: string;
  model?: string;
  models?: string[];
  fetchImpl?: typeof fetch;
}

export async function review({
  user,
  assistant,
  level,
  learnerName,
  apiKey,
  model,
  models,
  fetchImpl = fetch,
}: ReviewParams): Promise<ReviewResult> {
  const result = await (async () => {
    if (!user || !user.trim()) {
      return emptyReview();
    }

    const prompt = buildReviewPrompt({ user, assistant, level, learnerName });
    const text = await generateContent({ apiKey, model, models, prompt, responseSchema: REVIEW_SCHEMA, fetchImpl });
    return parseReviewPayload(text, { user });
  })();

  if (!result.understood) {
    console.warn('review: turn not understood, flooring score to 0', { user });
  }

  return result;
}

export { REVIEW_SCHEMA };
