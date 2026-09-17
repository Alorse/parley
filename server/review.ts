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
  // True only when this exchange is BOTH the learner signalling they are
  // leaving AND the tutor answering with its own closing goodbye — see
  // buildReviewPrompt's endInstruction. index.ts/live.ts end the session on
  // this exact pair, never on either half alone.
  endConversation: boolean;
}

// The base grading schema, without the "name" field — used once the
// learner's name is already known, so the model isn't asked (and doesn't
// spend output tokens) to re-report it on every single turn for the rest
// of the session.
const REVIEW_SCHEMA_BASE: GeminiSchema = {
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
    endConversation: { type: 'BOOLEAN' },
  },
  required: ['understood', 'score', 'scores', 'corrections', 'tip', 'words', 'endConversation'],
};

const REVIEW_SCHEMA: GeminiSchema = {
  ...REVIEW_SCHEMA_BASE,
  properties: { ...REVIEW_SCHEMA_BASE.properties, name: { type: 'STRING' } },
  required: [...REVIEW_SCHEMA_BASE.required!, 'name'],
};

function reviewSchemaFor(learnerName?: string): GeminiSchema {
  return learnerName ? REVIEW_SCHEMA_BASE : REVIEW_SCHEMA;
}

function emptyReview(): ReviewResult {
  return {
    understood: false,
    score: 0,
    scores: { pronunciation: 0, grammar: 0, fluency: 0 },
    corrections: [],
    tip: 'Say something out loud and I will give you a pronunciation tip.',
    words: [],
    name: '',
    endConversation: false,
  };
}

export interface BuildReviewPromptParams {
  user: string;
  assistant?: string;
  level?: string;
  learnerName?: string;
  scenario?: string;
}

// Once the learner's name is already known, nothing about it belongs in
// the prompt or the response schema (see reviewSchemaFor) — there's
// nothing left to ask the model to do.
export function buildReviewPrompt({ user, assistant, level, learnerName, scenario }: BuildReviewPromptParams): string {
  const nameInstruction = learnerName
    ? ''
    : 'If the learner states their own name in this turn (e.g. "My name is X", "I\'m X", "Call me X"), report it in "name". Otherwise leave "name" as an empty string. Never guess or invent a name, and never report anyone\'s name but the learner\'s own.';
  const nameMention = learnerName ? '' : ", and the learner's own name if captured this turn (see above)";
  const isRoleplay = Boolean(scenario) && scenario !== 'Just talk';
  const endInstruction = `Also decide "endConversation": set it to true only when BOTH halves of this exact exchange are true — (1) the learner's line clearly signals they are leaving or ending this practice session for real (e.g. "I have to go", "I need to leave now", "goodbye", "talk to you later"), in English, AND (2) the tutor's reply is itself a closing goodbye with no new question (a warm sign-off, not a normal conversational turn). If either half is missing, or the farewell is not in English, set it to false.${
    isRoleplay
      ? ` The current scenario is a role-play ("${scenario}") — a goodbye said as part of playing out that scene (e.g. saying bye to a waiter, hotel clerk, or other character) is NOT the learner ending the real session, so set endConversation to false for that, even if it sounds like a genuine goodbye.`
      : ''
  }`;

  const paragraphs = [
    `You are grading one turn of an English-speaking practice conversation for a learner at level ${level || 'B1'}.`,
    `The learner's transcribed speech (ground truth for what they said):\n"""${user}"""`,
    `The tutor's own reply, for context only (not ground truth about what the learner said):\n"""${assistant || ''}"""`,
    `Judge pronunciation, grammar, and fluency only from the learner's transcript above and the conversational context. Only report real errors that are actually present in the learner's text — never invent a correction. If the learner's transcript is not intelligible speech at all (empty, gibberish, or noise), set understood to false and score to 0, with no corrections — never guess a middle-of-the-range score for speech you could not actually understand.`,
    nameInstruction,
    endInstruction,
    `Respond with JSON matching the required schema: whether the learner's speech was actually understood (boolean), an overall 0-100 score, per-category scores (pronunciation, grammar, fluency), at most 3 corrections (from/to/why), one short actionable pronunciation tip, 0-4 notable words worth saving (word + short English meaning)${nameMention}, and endConversation (see above).`,
  ];

  return paragraphs.filter(Boolean).join('\n\n');
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
    endConversation: Boolean(data.endConversation),
  };

  if (!user || !user.trim()) {
    result.understood = false;
  }

  // Never trust the model's own score when it says (or the text implies) it
  // didn't understand the turn — a hallucinated transcript can otherwise
  // still carry a plausible-looking score straight through. Same reasoning
  // applies to a "captured" name: a misheard/hallucinated turn is not
  // grounds to (re)write the learner's identity. An unintelligible turn is
  // also never grounds to end the session.
  if (!result.understood) {
    result.score = 0;
    result.corrections = [];
    result.name = '';
    result.endConversation = false;
  }

  return result;
}

export interface ReviewParams {
  user: string;
  assistant?: string;
  level?: string;
  learnerName?: string;
  scenario?: string;
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
  scenario,
  apiKey,
  model,
  models,
  fetchImpl = fetch,
}: ReviewParams): Promise<ReviewResult> {
  const result = await (async () => {
    if (!user || !user.trim()) {
      return emptyReview();
    }

    const prompt = buildReviewPrompt({ user, assistant, level, learnerName, scenario });
    const text = await generateContent({ apiKey, model, models, prompt, responseSchema: reviewSchemaFor(learnerName), fetchImpl });
    return parseReviewPayload(text, { user });
  })();

  if (!result.understood) {
    console.warn('review: turn not understood, flooring score to 0', { user });
  }

  return result;
}

export { REVIEW_SCHEMA };
