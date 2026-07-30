import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions, isNewer, isValidVersion, parseVersion,
} from '../src/domain/version.js';

test('section 1: components compare as integers, not as strings', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.13.3', '0.13.10'), -1);

  // The exact trap the spec warns about: lexically "0.9.0" > "0.10.0", which would
  // silently invert the rollout.
  assert.ok('0.9.0' > '0.10.0', 'string comparison really does give the wrong answer');
  assert.ok(isNewer('0.10.0', '0.9.0'), 'numeric comparison gives the right one');
});

test('section 1: the shorter side is zero-padded', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('0.15.0', '0.15.0.1'), -1);
  assert.equal(compareVersions('2', '1.9.9'), 1);
});

test('isNewer is strict and asymmetric', () => {
  assert.equal(isNewer('0.15.0', '0.15.0'), false);
  assert.equal(isNewer('0.15.1', '0.15.0'), true);
  assert.equal(isNewer('0.15.0', '0.15.1'), false);
});

test('parseVersion produces the int array used for the SQL sort key', () => {
  assert.deepEqual(parseVersion('0.13.3'), [0, 13, 3]);
  assert.deepEqual(parseVersion('1'), [1]);
});

test('malformed versions are rejected rather than silently coerced', () => {
  for (const bad of ['', '1..2', '1.0.0-beta', 'v1.0', 'a.b', '1.x.3', ' 1.0', null, 42]) {
    assert.equal(isValidVersion(bad), false, `${JSON.stringify(bad)} must be invalid`);
    assert.throws(() => parseVersion(bad), TypeError);
  }
});
