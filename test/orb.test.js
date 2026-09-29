import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Orb, MicWaveform } from '../public/orb.js';

// #22: the orb only redraws as often as it visibly changes, and not at all
// while its screen or the page is hidden. The canvas, window, document and
// requestAnimationFrame are minimal stand-ins; setTimeout is mocked.

let frames; // pending requestAnimationFrame callbacks
let now;
let reduce;

function fakeCanvas() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const ctx = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' ? () => gradient : noop), set: () => true });
  return /** @type {any} */ ({ width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 200, height: 200 }) });
}

beforeEach(() => {
  frames = new Map();
  now = 0;
  reduce = false;
  let id = 0;
  globalThis.window = /** @type {any} */ ({
    devicePixelRatio: 1,
    addEventListener() {},
    matchMedia: () => ({
      get matches() {
        return reduce;
      },
    }),
  });
  globalThis.document = /** @type {any} */ ({ hidden: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (cb) => (frames.set(++id, cb), id);
  globalThis.cancelAnimationFrame = (i) => frames.delete(i);
  mock.method(performance, 'now', () => now);
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

/** Runs the pending animation frames at time `ms`; returns how many ran. */
function frameAt(ms) {
  now = ms;
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(ms);
  return due.length;
}

/** Advances by `ms` in 16 ms display frames; returns how many frames drew. */
function run(ms) {
  let drawn = 0;
  const end = now + ms;
  while (now < end) {
    const t = now + 16;
    mock.timers.tick(16);
    drawn += frameAt(t);
  }
  return drawn;
}

test('at rest the orb draws about 20 frames a second, not 60', () => {
  const orb = new Orb(fakeCanvas());
  orb.start();
  const drawn = run(1000);
  assert.ok(drawn >= 15 && drawn <= 21, `drew ${drawn} frames in 1 s`);
});

test('the orb draws every frame while it reacts to sound or a state', () => {
  const orb = new Orb(fakeCanvas());
  orb.start();
  orb.setState('thinking');
  run(50);
  assert.ok(run(1000) >= 55, 'thinking animates at full rate');

  orb.setState('idle');
  let level = 0.4;
  orb.setLevelSource(() => level);
  run(50);
  assert.ok(run(1000) >= 55, 'a level (the tutor or the learner) animates at full rate');
  assert.ok(orb.level > 0.3, 'the level source is read every frame');

  level = 0;
  run(3000); // the level eases back down
  assert.ok(run(1000) <= 21, 'back to the gentle rate once it is still again');
});

test('with reduced motion the orb draws about 10 frames a second and keeps real time', () => {
  reduce = true;
  const orb = new Orb(fakeCanvas());
  orb.start();
  orb.setState('speaking');
  const drawn = run(1000);
  assert.ok(drawn >= 8 && drawn <= 11, `drew ${drawn} frames in 1 s`);
  assert.ok(Math.abs(orb.time - 1) < 0.15, `animation time ${orb.time.toFixed(2)} s after 1 s`);
});

test('turning reduced motion on or off takes effect without a reload', () => {
  const orb = new Orb(fakeCanvas());
  orb.start();
  run(100);
  reduce = true;
  run(100);
  assert.ok(run(1000) <= 11, 'paced for reduced motion');
});

test('a hidden orb draws nothing until it is shown again', () => {
  const orb = new Orb(fakeCanvas());
  orb.start();
  run(100);
  orb.setVisible(false);
  assert.equal(run(1000), 0, 'nothing drawn while its screen is hidden');
  orb.setVisible(true);
  assert.ok(run(1000) > 0, 'drawing again once shown');
});

test('the orb does not start drawing in a background tab', () => {
  const orb = new Orb(fakeCanvas());
  orb.pause();
  /** @type {any} */ (document).hidden = true;
  orb.resume();
  assert.equal(run(1000), 0);
});

test('the mic line draws only between start and stop', () => {
  const wave = new MicWaveform(fakeCanvas(), () => null);
  assert.equal(run(500), 0, 'not drawn before it is shown');
  wave.start();
  assert.ok(run(500) > 25);
  wave.stop();
  assert.equal(run(500), 0, 'not drawn once hidden again');
});
