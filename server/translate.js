const MAX_CACHE_ENTRIES = 50;
const translateCache = new Map();

async function generateText({ prompt, apiKey, model, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    },
  );
  if (!res.ok) {
    throw new Error(`text generation failed with status ${res.status}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('text generation response had no content');
  }
  return text.trim();
}

export async function translate({ text, to = 'es', apiKey, model, fetchImpl = fetch }) {
  const cacheKey = `${to}::${text}`;
  if (translateCache.has(cacheKey)) {
    return { text: translateCache.get(cacheKey) };
  }

  const prompt = `Translate the following English sentence into natural, conversational ${to === 'es' ? 'Spanish' : to}. Reply with only the translation, nothing else.\n\n"""${text}"""`;
  const translated = await generateText({ prompt, apiKey, model, fetchImpl });

  if (translateCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = translateCache.keys().next().value;
    translateCache.delete(oldestKey);
  }
  translateCache.set(cacheKey, translated);

  return { text: translated };
}

export async function hint({ scenario, level, lastTutorLine, apiKey, model, fetchImpl = fetch }) {
  const prompt = `An English learner at level ${level || 'B1'} is practising a conversation${
    scenario && scenario !== 'Just talk' ? ` about "${scenario}"` : ''
  }. The tutor just said: "${lastTutorLine || ''}". Suggest one short, natural English sentence the learner could say next. Reply with only that sentence, nothing else.`;
  const suggestion = await generateText({ prompt, apiKey, model, fetchImpl });
  return { hint: suggestion };
}
