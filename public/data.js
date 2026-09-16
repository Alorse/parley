// Themes catalogue and the localStorage-backed word store (mastery tracking).

export const SCENARIOS = [
  { id: 'cafe', title: 'A café', subtitle: 'Something warm, please', icon: 'cup', category: 'Everyday', tone: 'rose' },
  { id: 'weekend', title: 'The weekend', subtitle: 'Tell me about yours', icon: 'sun', category: 'Everyday', tone: 'plum' },
  { id: 'walk', title: 'A little walk', subtitle: 'Out and about', icon: 'tree', category: 'Everyday', tone: 'moss' },
  { id: 'interview', title: 'Job interview', subtitle: 'Show what you can do', icon: 'briefcase', category: 'Work', tone: 'amber' },
  { id: 'airport', title: 'At the airport', subtitle: 'Gate, seat, delays', icon: 'plane', category: 'Travel', tone: 'rose' },
  { id: 'hotel', title: 'Hotel check-in', subtitle: 'I have a booking', icon: 'key', category: 'Travel', tone: 'plum' },
  { id: 'smalltalk', title: 'Small talk', subtitle: "Nice weather, isn't it?", icon: 'bubble', category: 'Social', tone: 'moss' },
  { id: 'dinner', title: 'Dinner out', subtitle: 'What are you having?', icon: 'utensils', category: 'Social', tone: 'amber' },
  { id: 'phone', title: 'On the phone', subtitle: 'Can you hear me now?', icon: 'phone', category: 'Everyday', tone: 'rose' },
  { id: 'plans', title: 'Making plans', subtitle: 'Friday, maybe?', icon: 'calendar', category: 'Social', tone: 'plum' },
];

export const SCENARIO_CATEGORIES = ['All', 'Everyday', 'Work', 'Travel', 'Social'];

export const JUST_TALK = 'Just talk';

// --- localStorage JSON helper, shared by the stores below ----------------

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable — the app still works, we just won't
    // persist this value.
  }
}

// --- word store --------------------------------------------------------

const WORDS_KEY = 'parley.words.v1';

function loadWordStore() {
  return loadJson(WORDS_KEY, {});
}

function saveWordStore(store) {
  saveJson(WORDS_KEY, store);
}

export function masteryTier(count) {
  if (count >= 3) return 'Steady';
  if (count === 2) return 'Growing';
  return 'Fragile';
}

// Records one sighting of a word (from review.words), bumping its counter
// and keeping the learner's own sentence it appeared in.
export function recordWordSighting({ word, meaning, sentence }) {
  if (!word || !word.trim()) return;
  const key = word.trim().toLowerCase();
  const store = loadWordStore();
  const entry = store[key] || { word: word.trim(), meaning: meaning || '', count: 0, sentences: [] };
  entry.count += 1;
  entry.meaning = meaning || entry.meaning;
  if (sentence && !entry.sentences.includes(sentence)) {
    entry.sentences.push(sentence);
  }
  store[key] = entry;
  saveWordStore(store);
  return entry;
}

export function getAllWords() {
  const store = loadWordStore();
  return Object.values(store).sort((a, b) => a.word.localeCompare(b.word));
}

export function searchWords(query) {
  const all = getAllWords();
  if (!query || !query.trim()) return all;
  const q = query.trim().toLowerCase();
  return all.filter((w) => w.word.toLowerCase().includes(q) || w.meaning.toLowerCase().includes(q));
}

// --- learner profile ----------------------------------------------------
// Small and separate from the settings blob on purpose: this is where
// whatever the app learns about the learner themselves lives (starting with
// their name), as opposed to how they've configured the app.

const PROFILE_KEY = 'parley-profile-v1';
// A "handful of facts", per the issue this implements — not a transcript,
// and never something that grows forever. Kept small enough that the whole
// note still reads as one short reminder when handed to the tutor prompt.
export const MEMORY_CAP = 5;
const DEFAULT_PROFILE = { name: '', memories: [] };

function loadProfile() {
  return loadJson(PROFILE_KEY, DEFAULT_PROFILE);
}

function saveProfile(profile) {
  saveJson(PROFILE_KEY, profile);
}

export function getProfile() {
  return loadProfile();
}

// Takes the caller's already-loaded profile rather than re-reading storage —
// app.js always has one in memory (from getProfile() at boot) by the time it
// needs to update the name.
export function setProfileName(profile, name) {
  profile.name = (name || '').trim();
  saveProfile(profile);
  return profile;
}

// Appends one short line about a finished conversation, dropping the oldest
// once there are more than MEMORY_CAP — the hard cap that keeps this from
// ever becoming a big accumulated thing.
export function addConversationMemory(profile, line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return profile;
  const memories = Array.isArray(profile.memories) ? profile.memories.slice() : [];
  memories.push(trimmed);
  profile.memories = memories.slice(-MEMORY_CAP);
  saveProfile(profile);
  return profile;
}

// The short note handed to the tutor at the start of a new conversation —
// empty when there's nothing remembered yet.
export function getMemoryNote(profile) {
  const memories = Array.isArray(profile.memories) ? profile.memories : [];
  return memories.join(' | ');
}

// The "forget everything" control in Settings: wipes the name and every
// stored memory line, so the app behaves as if it had never met the learner.
export function forgetProfile() {
  const fresh = { name: '', memories: [] };
  saveProfile(fresh);
  return fresh;
}

// --- conversation memory line ---------------------------------------------
// Builds the one short line saved when a conversation ends, e.g. "talked
// about the weekend; the past tense was hard". Deliberately deterministic —
// it reuses the corrections already returned by the per-turn review instead
// of asking the model to summarize the conversation with a separate call.

const MISTAKE_KEYWORDS = [
  { pattern: /\bpast tense\b|\bwas\/were\b/i, label: 'the past tense was hard' },
  { pattern: /\bpresent (?:simple|continuous|tense)\b/i, label: 'the present tense was hard' },
  { pattern: /\barticles?\b|\ba\/an\b/i, label: 'articles were tricky' },
  { pattern: /\bprepositions?\b/i, label: 'prepositions were tricky' },
  { pattern: /\bplurals?\b/i, label: 'plurals were tricky' },
  { pattern: /\bword order\b/i, label: 'word order was tricky' },
  { pattern: /\bagreement\b/i, label: 'subject-verb agreement was tricky' },
  { pattern: /\bpronunciation\b/i, label: 'pronunciation needs more practice' },
];

function summarizeMistake(corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) return '';
  const counts = new Map();
  let best = '';
  let bestCount = 0;
  for (const c of corrections) {
    const text = `${c?.why || ''} ${c?.from || ''} ${c?.to || ''}`;
    for (const { pattern, label } of MISTAKE_KEYWORDS) {
      if (!pattern.test(text)) continue;
      const count = (counts.get(label) || 0) + 1;
      counts.set(label, count);
      if (count > bestCount) {
        best = label;
        bestCount = count;
      }
    }
  }
  return best || 'a few grammar mistakes came up';
}

export function buildConversationMemory(topic, corrections) {
  const topicPhrase = topic && topic !== JUST_TALK ? topic.toLowerCase() : 'a free conversation';
  const mistake = summarizeMistake(corrections);
  return mistake ? `talked about ${topicPhrase}; ${mistake}` : `talked about ${topicPhrase}`;
}
