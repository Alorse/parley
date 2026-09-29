import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Announcer, finishedLine, stateCue } from '../public/announcer.js';

// #31: what a screen reader hears during a conversation.

test('each turn state has a short cue saying whose turn it is', () => {
  assert.equal(stateCue('listening'), 'Your turn.');
  assert.equal(stateCue('thinking'), 'Parley is thinking.');
  assert.equal(stateCue('speaking'), 'Parley is speaking.');
  assert.equal(stateCue('reconnecting'), 'Reconnecting to Parley.');
  assert.equal(stateCue('idle'), '');
});

test('a line is announced only once it is final, saying who spoke', () => {
  assert.equal(finishedLine({ type: 'output-text', text: 'How was your', final: false }), '');
  assert.equal(finishedLine({ type: 'output-text', text: ' How was your day? ', final: true }), 'Parley: How was your day?');
  assert.equal(finishedLine({ type: 'input-text', text: 'It was good', final: true }), 'You: It was good');
});

test('an empty final line (the tutor-only turns) is not announced', () => {
  assert.equal(finishedLine({ type: 'input-text', text: '', final: true }), '');
  assert.equal(finishedLine({ type: 'input-text', text: '  ', final: true }), '');
});

class FakeRegion {
  constructor() {
    this.children = [];
    this.ownerDocument = { createElement: () => ({ textContent: '', remove: () => this.children.shift() }) };
  }
  append(node) {
    this.children.push(node);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0];
  }
}

test('announcements are appended, so two lines landing together are both read, and only the last few are kept', () => {
  const region = new FakeRegion();
  const announcer = new Announcer(/** @type {any} */ (region), 3);
  announcer.say('');
  assert.equal(region.children.length, 0, 'nothing to say adds nothing');
  for (const line of ['You: one', 'Parley: two', 'You: three', 'Parley: four']) announcer.say(line);
  assert.deepEqual(region.children.map((c) => c.textContent), ['Parley: two', 'You: three', 'Parley: four']);
});
