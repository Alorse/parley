// Themes catalogue and the localStorage-backed word store (mastery tracking).

export const SCENARIOS = [
  { id: 'cafe', title: 'A café', subtitle: 'Something warm, please', icon: 'cup', category: 'Everyday', pastel: 'peach' },
  { id: 'weekend', title: 'The weekend', subtitle: 'Tell me about yours', icon: 'sun', category: 'Everyday', pastel: 'lavender' },
  { id: 'walk', title: 'A little walk', subtitle: 'Out and about', icon: 'tree', category: 'Everyday', pastel: 'sage' },
  { id: 'interview', title: 'Job interview', subtitle: 'Show what you can do', icon: 'briefcase', category: 'Work', pastel: 'butter' },
  { id: 'airport', title: 'At the airport', subtitle: 'Gate, seat, delays', icon: 'plane', category: 'Travel', pastel: 'peach' },
  { id: 'hotel', title: 'Hotel check-in', subtitle: 'I have a booking', icon: 'key', category: 'Travel', pastel: 'lavender' },
  { id: 'smalltalk', title: 'Small talk', subtitle: "Nice weather, isn't it?", icon: 'bubble', category: 'Social', pastel: 'sage' },
  { id: 'dinner', title: 'Dinner out', subtitle: 'What are you having?', icon: 'utensils', category: 'Social', pastel: 'butter' },
  { id: 'phone', title: 'On the phone', subtitle: 'Can you hear me now?', icon: 'phone', category: 'Everyday', pastel: 'peach' },
  { id: 'plans', title: 'Making plans', subtitle: 'Friday, maybe?', icon: 'calendar', category: 'Social', pastel: 'lavender' },
];

export const SCENARIO_CATEGORIES = ['All', 'Everyday', 'Work', 'Travel', 'Social'];

export const JUST_TALK = 'Just talk';

// --- word store --------------------------------------------------------

const WORDS_KEY = 'parley.words.v1';

function loadWordStore() {
  try {
    const raw = localStorage.getItem(WORDS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveWordStore(store) {
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify(store));
  } catch {
    // storage full or unavailable — the conversation still works, we just
    // won't remember this word.
  }
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
