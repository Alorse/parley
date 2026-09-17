import { generateContent } from './gemini-client.js';
import { isRoleplayScenario } from './tutor.js';

const MAX_CACHE_ENTRIES = 50;
const translateCache = new Map<string, string>();

export interface TranslateParams {
  text: string;
  to?: string;
  apiKey: string;
  model?: string;
  models?: string[];
  fetchImpl?: typeof fetch;
}

export interface TranslateResult {
  text: string;
}

export async function translate({ text, to = 'es', apiKey, model, models, fetchImpl = fetch }: TranslateParams): Promise<TranslateResult> {
  const cacheKey = `${to}::${text}`;
  const cached = translateCache.get(cacheKey);
  if (cached !== undefined) {
    return { text: cached };
  }

  const prompt = `Translate the following English sentence into natural, conversational ${to === 'es' ? 'Spanish' : to}. Reply with only the translation, nothing else.\n\n"""${text}"""`;
  const translated = (await generateContent({ apiKey, model, models, prompt, fetchImpl })).trim();

  if (translateCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = translateCache.keys().next().value;
    if (oldestKey !== undefined) translateCache.delete(oldestKey);
  }
  translateCache.set(cacheKey, translated);

  return { text: translated };
}

export interface HintParams {
  scenario?: string;
  level?: string;
  lastTutorLine?: string;
  apiKey: string;
  model?: string;
  models?: string[];
  fetchImpl?: typeof fetch;
}

export interface HintResult {
  hint: string;
}

export async function hint({ scenario, level, lastTutorLine, apiKey, model, models, fetchImpl = fetch }: HintParams): Promise<HintResult> {
  const prompt = `An English learner at level ${level || 'B1'} is practising a conversation${
    isRoleplayScenario(scenario) ? ` about "${scenario}"` : ''
  }. The tutor just said: "${lastTutorLine || ''}". Suggest one short, natural English sentence the learner could say next. Reply with only that sentence, nothing else.`;
  const suggestion = (await generateContent({ apiKey, model, models, prompt, fetchImpl })).trim();
  return { hint: suggestion };
}
