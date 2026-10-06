import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  SKIP_MESSAGE, bundle, fleetHeaders, hasDatabase, publish, setChannel, signIn, startServer,
} from './helpers/harness.js';

describe('GET /api/v1/update/check', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  const SLIM = bundle({ version: '0.15.0', cores: [{ platform: 'linux-x86_64' }] });
  // Must be the version it is published as: the server cross-checks the URL against the
  // bundle's own manifest and refuses a mismatch, which is the whole point of that rule.
  const FLEET = bundle({
    version: '0.16.0',
    cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
  });

  before(async () => {
    server = await startServer();
    session = await signIn(server);

    await publish(session, { version: '0.15.0', platform: 'linux-x86_64', body: SLIM, minVersion: '0.13.0', notes: 'Adds ZMQ bus self-description.' });
    await publish(session, { version: '0.16.0', kind: 'fleet', platforms: ['android-aarch64', 'linux-x86_64'], body: FLEET });
    await setChannel(session, 'stable', { latest: '0.15.0' });
    await setChannel(session, 'beta', { latest: '0.16.0' });
  });

  after(async () => { await server?.close(); });

  const check = (query, headers = {}) => server.request(
    `/api/v1/update/check?${new URLSearchParams(query)}`, { headers: fleetHeaders(headers) },
  );

  const base = { serial: 'SN-42', platform: 'linux-x86_64', version: '0.13.3', system: 'default' };

  test('offers a newer release with the full manifest field set', async () => {
    const res = await check(base);
    assert.equal(res.status, 200);

    const body = res.json();
    assert.equal(body.update_available, true);
    assert.equal(body.version, '0.15.0');
    // The system rides in the URL the server hands out, so a node fetches bytes of the
    // product it was placed in without the client having to know the concept exists.
    assert.equal(body.url,
      '/api/v1/update/download/0.15.0?platform=linux-x86_64&system=default');
    assert.equal(body.system, 'default', 'and the answer says which product it is for');
    assert.equal(body.size, SLIM.length);
    assert.equal(body.target, 'linux-x86_64');
    assert.equal(body.min_version, '0.13.0');
    assert.equal(body.mandatory, false);
    assert.equal(body.published_at, '2026-07-28T00:00:00Z');
    assert.equal(body.signature.alg, 'ed25519');
    assert.match(body.signature.value, /^[A-Za-z0-9+/]{86}==$/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.ok(res.headers.etag);
  });

  test('the signature verifies the way a node would verify it', async () => {
    const body = (await check(base)).json();

    // Rebuild the six-field payload from the JSON alone, exactly as the node does.
    const payload = [
      body.version, String(body.size), body.sha256, body.target,
      body.min_version ?? '', body.published_at ?? '',
    ].join('\n');

    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(server.publicKey, 'base64').toString('base64url') },
      format: 'jwk',
    });

    assert.ok(
      crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey,
        Buffer.from(body.signature.value, 'base64')),
      'the manifest must verify against the public key the server publishes',
    );

    // Step 2 of section 7: the node's own platform must be inside the target set.
    assert.ok(body.target.split(',').includes('linux-x86_64'));
  });

  test('a current or newer node is told there is no update', async () => {
    assert.equal((await check({ ...base, version: '0.15.0' })).json().update_available, false);
    assert.equal((await check({ ...base, version: '0.99.0' })).json().update_available, false);

    const body = (await check({ ...base, version: '0.15.0' })).json();

    // Two keys, and only two. `channels` is part of the protocol — a node stuck on a channel
    // this server does not have receives exactly this body forever, and the list is what lets
    // it be corrected. Anything BEYOND these two would be leaking catalog detail to a node
    // that is being told there is nothing for it.
    assert.deepEqual(Object.keys(body).sort(), ['channels', 'update_available'],
      'nothing else is disclosed');
  });

  test('0.9.0 is offered 0.10.0 — the string-comparison trap', async () => {
    await publish(session, { version: '0.10.0', platform: 'linux-aarch64' });
    await setChannel(session, 'edge', { latest: '0.10.0' });

    const body = (await check({
      serial: 'SN-OLD', platform: 'linux-aarch64', version: '0.9.0', channel: 'edge',
      system: 'default',
    })).json();

    assert.ok('0.9.0' > '0.10.0', 'lexically the offer would be suppressed');
    assert.equal(body.update_available, true, 'numerically it must be offered');
    assert.equal(body.version, '0.10.0');
  });

  test('missing and malformed parameters are distinguished', async () => {
    for (const [query, code] of [
      [{ platform: 'linux-x86_64', version: '0.1.0' }, 'missing_parameter'],
      [{ serial: 'SN-42', version: '0.1.0' }, 'missing_parameter'],
      [{ serial: 'SN-42', platform: 'linux-x86_64' }, 'missing_parameter'],
      // Required since two systems may share a version number: the number cannot place a node.
      [{ serial: 'SN-42', platform: 'linux-x86_64', version: '0.1.0' }, 'missing_parameter'],
      [{ ...base, serial: '' }, 'missing_parameter'],
      [{ ...base, version: 'v1.0' }, 'invalid_parameter'],
      [{ ...base, platform: 'plan9-vax' }, 'invalid_parameter'],
      [{ ...base, plugins: 'Broken@' }, 'invalid_parameter'],
    ]) {
      const res = await check(query);
      assert.equal(res.status, 400, JSON.stringify(query));
      assert.equal(res.json().error, code, JSON.stringify(query));
    }
  });

  test('a parameter the protocol no longer has is ignored, not refused', async () => {
    // `role` was a constant the node hardcoded, so it distinguished nothing and has been
    // dropped. Devices in the field keep sending it until they are rebuilt, and refusing them
    // over a field the server does not read would take a working fleet offline.
    const res = await check({ ...base, role: 'ROBOT' });
    assert.equal(res.status, 200);
  });

  test('If-None-Match yields a bodyless 304', async () => {
    const first = await check(base);
    const etag = first.headers.etag;

    const second = await check(base, { 'If-None-Match': etag });
    assert.equal(second.status, 304);
    assert.equal(second.buffer.length, 0);
    assert.equal(second.headers['content-length'], undefined);

    const stale = await check(base, { 'If-None-Match': '"chk-stale"' });
    assert.equal(stale.status, 200);
  });

  test('the ETag varies by platform and channel, and covers the false answer too', async () => {
    const a = (await check(base)).headers.etag;
    const b = (await check({ ...base, channel: 'beta' })).headers.etag;
    assert.notEqual(a, b, 'channel must be part of the ETag');

    const current = await check({ ...base, version: '0.15.0' });
    assert.equal(current.json().update_available, false);
    assert.ok(current.headers.etag, 'a steady-state poll should be able to get a 304');

    const revalidated = await check({ ...base, version: '0.15.0' },
      { 'If-None-Match': current.headers.etag });
    assert.equal(revalidated.status, 304);
  });

  test('an unknown channel is withheld, not rejected', async () => {
    const res = await check({ ...base, channel: 'does-not-exist' });
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);
  });

  test('a platform with no artifact gets false, not 404', async () => {
    const res = await check({ ...base, platform: 'macos-aarch64' });
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);
  });

  test('with no slim artifact the fleet bundle is offered, with the sorted target', async () => {
    const body = (await check({
      serial: 'SN-AND', platform: 'android-aarch64', version: '0.13.0', channel: 'beta',
      system: 'default',
    })).json();

    assert.equal(body.update_available, true);
    assert.equal(body.version, '0.16.0');
    assert.equal(body.target, 'android-aarch64,linux-x86_64', 'sorted, comma-joined, no spaces');
    // Even a fleet answer names the platform: the download validates that the package covers
    // it, so the parameter is what the server checks against, not merely how it selects.
    assert.equal(body.url,
      '/api/v1/update/download/0.16.0?platform=android-aarch64&system=default');
  });
});
