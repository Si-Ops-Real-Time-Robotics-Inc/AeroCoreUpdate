import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRange } from '../src/core/range.js';
import { etagMatches } from '../src/core/http.js';

const SIZE = 12582912;

test('section 6: bytes=N- is the form a resuming node sends', () => {
  assert.deepEqual(parseRange('bytes=4194304-', SIZE),
    { type: 'satisfiable', start: 4194304, end: SIZE - 1 });
  assert.deepEqual(parseRange('bytes=0-', SIZE),
    { type: 'satisfiable', start: 0, end: SIZE - 1 });
});

test('a start at or past the end is unsatisfiable', () => {
  assert.equal(parseRange(`bytes=${SIZE}-`, SIZE).type, 'unsatisfiable');
  assert.equal(parseRange(`bytes=${SIZE + 100}-`, SIZE).type, 'unsatisfiable');
});

test('multi-range is refused with 416, as section 6 permits', () => {
  assert.equal(parseRange('bytes=0-99,200-299', SIZE).type, 'unsatisfiable');
});

test('closed and suffix ranges work, and the end is clamped', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { type: 'satisfiable', start: 0, end: 99 });
  assert.deepEqual(parseRange(`bytes=0-${SIZE + 500}`, SIZE),
    { type: 'satisfiable', start: 0, end: SIZE - 1 });
  assert.deepEqual(parseRange('bytes=-500', SIZE),
    { type: 'satisfiable', start: SIZE - 500, end: SIZE - 1 });
  assert.deepEqual(parseRange('bytes=-999999999', 100),
    { type: 'satisfiable', start: 0, end: 99 }, 'suffix larger than the file clamps to 0');
  assert.equal(parseRange('bytes=-0', SIZE).type, 'unsatisfiable');
});

test('a malformed Range is ignored (RFC 9110), giving a full 200 body', () => {
  for (const header of ['bytes=abc-', 'bytes=', 'bytes=-', 'bytes=1-x', 'garbage']) {
    assert.equal(parseRange(header, SIZE).type, 'none', header);
  }
});

test('an unknown range unit is ignored, not rejected', () => {
  assert.equal(parseRange('items=0-99', SIZE).type, 'none');
  assert.equal(parseRange('', SIZE).type, 'none');
  assert.equal(parseRange(undefined, SIZE).type, 'none');
});

test('every range over an empty resource is unsatisfiable', () => {
  assert.equal(parseRange('bytes=0-', 0).type, 'unsatisfiable');
});

test('etagMatches handles multi-value lists and weak prefixes', () => {
  const etag = '"chk-0.15.0-linux-x86_64"';

  assert.ok(etagMatches(etag, etag));
  assert.ok(etagMatches('"other", "chk-0.15.0-linux-x86_64"', etag), 'multi-value list');
  assert.ok(etagMatches(`W/${etag}`, etag), 'weak prefix on the request side');
  assert.ok(etagMatches(etag, `W/${etag}`), 'weak prefix on the response side');
  assert.ok(etagMatches('*', etag));

  assert.ok(!etagMatches('"stale"', etag));
  assert.ok(!etagMatches('', etag));
  assert.ok(!etagMatches(undefined, etag));
  assert.ok(!etagMatches(etag, ''));
});
