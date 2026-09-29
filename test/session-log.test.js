import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReason, createSessionLogger, formatSessionLog, newSessionId } from '../server/session-log.js';

test('session ids are short and unique', () => {
  const a = newSessionId();
  const b = newSessionId();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('a lifecycle record is one greppable line of JSON', () => {
  const line = formatSessionLog('abcd1234', 'upstream-close', { code: 1011, reason: 'Internal error encountered.' });
  assert.ok(line.startsWith('live-session {'));
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line.slice('live-session '.length)), {
    sid: 'abcd1234',
    event: 'upstream-close',
    code: 1011,
    reason: 'Internal error encountered.',
  });
});

test('createSessionLogger stamps every record with its session id', () => {
  const lines = [];
  const log = createSessionLogger('s1', (l) => lines.push(l));
  log('open', { active: 1 });
  log('end');
  assert.deepEqual(
    lines.map((l) => JSON.parse(l.slice('live-session '.length))),
    [
      { sid: 's1', event: 'open', active: 1 },
      { sid: 's1', event: 'end' },
    ],
  );
});

test('close reasons are flattened to one short line', () => {
  assert.equal(cleanReason('a\n  b\tc'), 'a b c');
  assert.equal(cleanReason(undefined), '');
  assert.equal(cleanReason('x'.repeat(500)).length, 120);
});
