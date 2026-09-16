import { generateContent } from './gemini-client.js';

const MAX_CACHE_ENTRIES = 50;
const translateCache = new Map();

export async function translate({ text, to = 'es', apiKey, model, models, fetchImpl = fetch }) {
  const cacheKey = `${to}::${text}`;
  if (translateCache.has(cacheKey)) {
    return { text: translateCache.get(cacheKey) };
  }

  const prompt = `Translate the following English sentence into natural, conversational ${to === 'es' ? 'Spanish' : to}. Reply with only the translation, nothing else.\n\n"""${text}"""`;
  const translated = (await generateContent({ apiKey, model, models, prompt, fetchImpl })).trim();

  if (translateCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = translateCache.keys().next().value;
    translateCache.delete(oldestKey);
  }
  translateCache.set(cacheKey, translated);

  return { text: translated };
}

export async function hint({ scenario, level, lastTutorLine, apiKey, model, models, fetchImpl = fetch }) {
  const prompt = `An English learner at level ${level || 'B1'} is practising a conversation${
    scenario && scenario !== 'Just talk' ? ` about "${scenario}"` : ''
  }. The tutor just said: "${lastTutorLine || ''}". Suggest one short, natural English sentence the learner could say next. Reply with only that sentence, nothing else.`;
  const suggestion = (await generateContent({ apiKey, model, models, prompt, fetchImpl })).trim();
  return { hint: suggestion };
}
