import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManifestBody, noUpdate, signingPayload } from '../src/domain/manifest.js';
import { canonicalTarget, isAndroid, targetIncludes } from '../src/domain/platform.js';

const SHA = '87224aca0ca2bfd6391dd4a3c8d51355ad6c90615a966b11874e58c252ea04f9';

test('section 7 worked example: the payload is exactly 121 bytes', () => {
  const payload = signingPayload({
    version: '0.15.0',
    size: 12582912,
    sha256: SHA,
    target: 'linux-x86_64',
    minVersion: '0.13.0',
    publishedAt: '2026-07-28T00:00:00Z',
  });

  assert.equal(
    payload.toString('utf8'),
    `0.15.0\n12582912\n${SHA}\nlinux-x86_64\n0.13.0\n2026-07-28T00:00:00Z`,
  );
  assert.equal(payload.length, 121, 'the spec states 121 bytes');
  assert.ok(!payload.toString('utf8').endsWith('\n'), 'no trailing newline');
});

test('section 7: absent optional fields contribute the empty string, keeping separators', () => {
  const payload = signingPayload({
    version: '0.15.0', size: 12582912, sha256: SHA, target: 'linux-x86_64',
    minVersion: null, publishedAt: undefined,
  });

  assert.equal(payload.toString('utf8'), `0.15.0\n12582912\n${SHA}\nlinux-x86_64\n\n`);
  assert.equal(payload.toString('utf8').split('\n').length, 6, 'still exactly six fields');
});

test('section 7: a fleet bundle changes only line 4, sorted and comma-joined', () => {
  const target = canonicalTarget(['linux-x86_64', 'android-aarch64']);
  assert.equal(target, 'android-aarch64,linux-x86_64', 'sorted ascending, no spaces');

  const lines = signingPayload({
    version: '0.15.0', size: 24117248, sha256: SHA, target,
    minVersion: '0.13.0', publishedAt: '2026-07-28T00:00:00Z',
  }).toString('utf8').split('\n');

  assert.equal(lines[3], 'android-aarch64,linux-x86_64');
  assert.deepEqual([lines[0], lines[1], lines[2], lines[4], lines[5]],
    ['0.15.0', '24117248', SHA, '0.13.0', '2026-07-28T00:00:00Z']);
});

test('canonicalTarget sorts and dedupes so two servers derive the same string', () => {
  assert.equal(canonicalTarget(['linux-x86_64']), 'linux-x86_64');
  assert.equal(
    canonicalTarget(['linux-x86_64', 'android-aarch64', 'linux-x86_64']),
    'android-aarch64,linux-x86_64',
  );
  // Order of the input must not matter.
  assert.equal(
    canonicalTarget(['android-aarch64', 'linux-x86_64']),
    canonicalTarget(['linux-x86_64', 'android-aarch64']),
  );
});

test('targetIncludes implements verification step 2', () => {
  assert.ok(targetIncludes('android-aarch64,linux-x86_64', 'linux-x86_64'));
  assert.ok(!targetIncludes('android-aarch64', 'linux-x86_64'));
  // A prefix must not count as a member.
  assert.ok(!targetIncludes('linux-x86_64', 'linux-x86'));
});

test('isAndroid drives the section 5 core block', () => {
  assert.ok(isAndroid('android-aarch64'));
  assert.ok(!isAndroid('linux-x86_64'));
});

test('size must be a safe integer: a float would change the signed bytes', () => {
  const base = { version: '1.0.0', sha256: SHA, target: 'linux-x86_64' };
  assert.throws(() => signingPayload({ ...base, size: 1.5 }), TypeError);
  assert.throws(() => signingPayload({ ...base, size: -1 }), TypeError);
  assert.throws(() => signingPayload({ ...base, size: Number.MAX_SAFE_INTEGER + 2 }), TypeError);
});

test('buildManifestBody omits absent optionals but always emits mandatory', () => {
  const signature = { alg: 'ed25519', key_id: 'rtr-ota-2026', value: 'x' };
  const full = buildManifestBody({
    version: '0.15.0', url: '/d', size: 1, sha256: SHA, target: 'linux-x86_64',
    minVersion: '0.13.0', mandatory: true, notes: 'n', publishedAt: '2026-07-28T00:00:00Z',
    signature,
  });
  assert.deepEqual(Object.keys(full), [
    'update_available', 'version', 'url', 'size', 'sha256', 'target',
    'min_version', 'mandatory', 'notes', 'published_at', 'signature',
  ]);

  const slim = buildManifestBody({
    version: '0.15.0', url: '/d', size: 1, sha256: SHA, target: 'linux-x86_64', signature,
  });
  assert.deepEqual(Object.keys(slim), [
    'update_available', 'version', 'url', 'size', 'sha256', 'target', 'mandatory', 'signature',
  ]);
  assert.equal(slim.mandatory, false);
});

// ── channels ride alongside the signature, never inside it ────────────────────────────────

test('adding channels changes no signed byte', () => {
  // The node syncs its update.channel dropdown from this field, so it appears on every
  // manifest. The signature is over six fixed fields; if a sibling key could reach the signed
  // payload, every node in the fleet would reject the manifest as forged.
  const fields = {
    version: '0.16.0',
    size: 1234,
    sha256: 'a'.repeat(64),
    target: 'linux-x86_64',
    minVersion: '0.13.0',
    publishedAt: '2026-07-28T00:00:00Z',
  };

  const withChannels = signingPayload({ ...fields, channels: ['stable', 'beta'] });
  const without = signingPayload(fields);

  assert.deepEqual(withChannels, without);
});

test('the manifest body carries channels outside the signed fields', () => {
  const body = buildManifestBody({
    version: '0.16.0',
    url: 'https://example.test/x.tar.gz',
    size: 1234,
    sha256: 'a'.repeat(64),
    target: 'linux-x86_64',
    signature: 'sig',
    channels: ['stable', 'beta'],
  });

  assert.deepEqual(body.channels, ['stable', 'beta']);
  // Six fields plus url/mandatory/signature — channels is not among what gets signed.
  assert.equal(body.update_available, true);
});

test('an empty channel list is omitted rather than sent as []', () => {
  // The node treats an empty array as "server listed nothing" and leaves the dropdown alone
  // (sync_channel_options returns early). Sending [] would be indistinguishable but larger,
  // and it invites a reader to think the system genuinely has no channels.
  const body = buildManifestBody({
    version: '0.16.0',
    url: 'https://example.test/x.tar.gz',
    size: 1,
    sha256: 'a'.repeat(64),
    target: 'linux-x86_64',
    signature: 'sig',
    channels: [],
  });

  assert.ok(!('channels' in body));
});

test('the no-update shape carries channels too', () => {
  // This is the shape a node stuck on a nonexistent channel receives forever, so it is the
  // one that has to carry the list that lets it be corrected.
  assert.deepEqual(noUpdate(['stable', 'beta']), {
    update_available: false,
    channels: ['stable', 'beta'],
  });
  assert.deepEqual(noUpdate(), { update_available: false });
});
