import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconMarkup, ICON_NAMES } from '../public/icons.js';

test('tag and alphabet icons are registered and render an svg', () => {
  for (const name of ['tag', 'alphabet']) {
    assert.ok(ICON_NAMES.includes(name), `${name} should be a known icon`);
    const markup = iconMarkup(name);
    assert.match(markup, /^<svg viewBox="0 0 24 24" aria-hidden="true">/);
    assert.match(markup, /stroke="currentColor"/);
  }
});

test('iconMarkup returns empty string for an unknown icon', () => {
  assert.equal(iconMarkup('does-not-exist'), '');
});
