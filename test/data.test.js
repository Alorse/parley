import { test } from 'node:test';
import assert from 'node:assert/strict';

// public/data.js is plain browser JS backed by localStorage, which Node
// doesn't provide — a tiny in-memory shim is enough to exercise the pure
// read/write logic without a browser. Module-body code in data.js never
// touches localStorage (only the exported functions do), so it's safe to
// install this before the static import below runs its module body.
class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

globalThis.localStorage = new MemoryStorage();

const { getProfile, setProfileName, addConversationMemory, getMemoryNote, forgetProfile, buildConversationMemory, MEMORY_CAP } = await import(
  '../public/data.js'
);

test('addConversationMemory keeps only the last MEMORY_CAP lines, dropping the oldest', () => {
  localStorage.clear();
  let profile = getProfile();
  for (let i = 1; i <= MEMORY_CAP + 3; i += 1) {
    profile = addConversationMemory(profile, `conversation ${i}`);
  }
  assert.equal(profile.memories.length, MEMORY_CAP, 'the store never grows past the hard cap');
  assert.deepEqual(
    profile.memories,
    Array.from({ length: MEMORY_CAP }, (_, i) => `conversation ${i + 4}`),
    'the oldest lines are dropped first, newest kept',
  );

  // And it's actually persisted, not just the in-memory return value.
  assert.deepEqual(getProfile().memories, profile.memories);
});

test('addConversationMemory ignores an empty line', () => {
  localStorage.clear();
  let profile = getProfile();
  profile = addConversationMemory(profile, '   ');
  assert.deepEqual(profile.memories, []);
});

test('getMemoryNote is empty with nothing remembered, and carries the stored lines otherwise', () => {
  localStorage.clear();
  let profile = getProfile();
  assert.equal(getMemoryNote(profile), '');

  profile = addConversationMemory(profile, 'talked about the weekend; the past tense was hard');
  assert.match(getMemoryNote(profile), /the weekend/);
});

test('forgetProfile wipes the name and every stored memory line, and persists the wipe', () => {
  localStorage.clear();
  let profile = getProfile();
  profile = setProfileName(profile, 'Kenji');
  profile = addConversationMemory(profile, 'talked about food');
  assert.notEqual(profile.name, '');
  assert.ok(profile.memories.length > 0);

  const fresh = forgetProfile();
  assert.equal(fresh.name, '');
  assert.deepEqual(fresh.memories, []);
  assert.deepEqual(getProfile(), { name: '', memories: [] }, 'the wipe is persisted, not just returned');
});

test('buildConversationMemory notes the topic and a recurring mistake theme from the corrections', () => {
  const line = buildConversationMemory('The weekend', [
    { from: 'I go', to: 'I went', why: 'past tense of go is went' },
    { from: 'she go', to: 'she went', why: 'past tense agreement' },
  ]);
  assert.match(line, /^talked about the weekend/);
  assert.match(line, /past tense/);
});

test('buildConversationMemory falls back to just the topic when there were no corrections', () => {
  assert.equal(buildConversationMemory('Just talk', []), 'talked about a free conversation');
  assert.equal(buildConversationMemory('The weekend', []), 'talked about the weekend');
});
