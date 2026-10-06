import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  SKIP_MESSAGE, bundle, fakeArtifact, fleetHeaders, hasDatabase, sha256Hex, signIn,
  startServer, publish,
} from './helpers/harness.js';

describe('artifact upload', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;
  let artifactsDir;

  // A small limit so the oversize path can be exercised with a few kilobytes instead of
  // half a gigabyte. Every other upload in this file stays well under it.
  const UPLOAD_LIMIT = 4096;

  before(async () => {
    server = await startServer({ env: { UPLOAD_MAX_BYTES: String(UPLOAD_LIMIT) } });
    session = await signIn(server);
    artifactsDir = path.join(server.dir, 'artifacts');

    const res = await session.api('/admin/api/systems/default/releases', {
      method: 'POST',
      body: JSON.stringify({ version: '0.15.0', min_version: '0.13.0', notes: 'test' }),
    });
    assert.equal(res.status, 201);
  });

  after(async () => { await server?.close(); });

  const uploadTo = (query, body, headers = {}) =>
    session.api(`/admin/api/systems/default/releases/0.15.0/artifacts?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', ...headers },
      body,
    });

  const listVersionDir = async () => {
    try {
      return await fsp.readdir(path.join(artifactsDir, 'default', '0.15.0'));
    } catch {
      return [];
    }
  };

  test('a good upload derives version and platforms from the bundle', async () => {
    const body = bundle({ version: '0.15.0', cores: [{ platform: 'linux-x86_64' }] });
    // Note the query names neither the platform nor the kind: the bundle supplies both.
    const res = await uploadTo('', body, { 'X-Expected-Sha256': sha256Hex(body) });

    assert.equal(res.status, 201);
    const artifact = res.json();
    assert.equal(artifact.size, body.length);
    assert.equal(artifact.sha256, sha256Hex(body));
    assert.equal(artifact.version, '0.15.0', 'version read from the bundle manifest');
    assert.deepEqual(artifact.platforms, ['linux-x86_64'], 'platforms read from the bundle');
    assert.equal(artifact.kind, 'slim', 'one platform derives slim');
    assert.equal(artifact.bundle_format, 'bundle');
    // By field, not as an exact object: the core report has since grown `system`,
    // `bundled_plugins` and `shipped_config`, and pinning the whole shape here breaks on
    // anything added without saying what the test actually cares about.
    assert.equal(artifact.inspection.cores.length, 1);
    const [core] = artifact.inspection.cores;
    assert.equal(core.platform, 'linux-x86_64');
    assert.equal(core.path, 'core/linux-x86_64');
    assert.equal(core.slice_version, '0.15.0', 'the version the node will compare against');

    const onDisk = await fsp.readFile(path.join(artifactsDir, 'default', '0.15.0', 'linux-x86_64.tar.gz'));
    assert.ok(onDisk.equals(body), 'the stored bytes must be identical');
  });

  // fakeArtifact is not a gzip, but that does not matter: the sha256 gate runs BEFORE
  // inspection so a corrupted transfer is never misreported as a bundle-format fault.
  test('a sha256 mismatch is rejected and leaves nothing behind', async () => {
    const body = fakeArtifact(1024, 17);
    const before = await listVersionDir();

    const res = await uploadTo('', body, { 'X-Expected-Sha256': 'f'.repeat(64) });

    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'invalid_parameter');
    assert.match(res.json().message, /sha256 mismatch/);

    assert.deepEqual(await listVersionDir(), before, 'no partial file may survive');

    const tmp = await fsp.readdir(path.join(artifactsDir, '.tmp')).catch(() => []);
    assert.deepEqual(tmp.filter((f) => f.endsWith('.part')), [], 'the temp file must be cleaned up');
  });

  test('a duplicate artifact is a 409, not a silent overwrite', async () => {
    const body = bundle({ version: '0.15.0', cores: [{ platform: 'linux-x86_64' }] });
    const res = await uploadTo('', body, { 'X-Expected-Sha256': sha256Hex(body) });

    assert.equal(res.status, 409);
  });

  // Dies inside receiveToTempFile, so the content never reaches inspection either.
  test('an oversized upload is refused with 413 and stores nothing', async () => {
    const before = await listVersionDir();
    const body = fakeArtifact(UPLOAD_LIMIT * 2, 3);

    const res = await uploadTo('', body);

    assert.equal(res.status, 413);
    assert.equal(res.json().error, 'invalid_parameter');
    assert.deepEqual(await listVersionDir(), before, 'nothing may be stored');

    const tmp = await fsp.readdir(path.join(artifactsDir, '.tmp')).catch(() => []);
    assert.deepEqual(tmp.filter((f) => f.endsWith('.part')), [], 'the temp file must be removed');
  });

  test('an empty upload is rejected', async () => {
    const res = await uploadTo('', Buffer.alloc(0));
    assert.equal(res.status, 400);
  });

  // `kind=slim` with no platform is legitimate now — the bundle names the platform. What
  // still has to hold is that a bad query is refused without writing anything at all.
  test('a malformed query is refused and stores nothing', async () => {
    const body = fakeArtifact(128, 9);

    for (const query of [
      'kind=slim&platform=plan9-vax',
      'platforms=plan9-vax',
      'kind=bogus',
    ]) {
      const res = await uploadTo(query, body);
      assert.equal(res.status, 400, query);
      assert.equal(res.json().error, 'invalid_parameter', query);
    }

    const tmp = await fsp.readdir(path.join(artifactsDir, '.tmp')).catch(() => []);
    assert.deepEqual(tmp.filter((f) => f.endsWith('.part')), [], 'no temp file may survive');
  });

  test('an upload for an unknown release creates it', async () => {
    // The bundle version is machine-generated and cross-checked against every core slice, so
    // it is a better source than a hand-typed URL. No node sees the release until a channel
    // points at it.
    const body = bundle({ version: '9.9.9', cores: [{ platform: 'linux-x86_64' }] });
    const res = await session.api('/admin/api/artifacts', {
      method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body,
    });

    assert.equal(res.status, 201);
    assert.equal(res.json().release_created, true);
    assert.equal(res.json().version, '9.9.9');
  });

  test('an upload bumps the catalog revision, changing every check ETag', async () => {
    const beforeRev = (await session.api('/admin/api/catalog')).json().revision;

    await session.api('/admin/api/systems/default/channels/stable', {
      method: 'PUT', body: JSON.stringify({ latest: '0.15.0' }),
    });

    const etagBefore = (await server.request(
      '/api/v1/update/check?system=default&serial=SN-1&platform=linux-x86_64&version=0.13.0',
      { headers: fleetHeaders() },
    )).headers.etag;

    const body = bundle({
      version: '0.15.0',
      cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
    });
    const upload = await uploadTo('', body, { 'X-Expected-Sha256': sha256Hex(body) });
    assert.equal(upload.status, 201);

    const afterRev = (await session.api('/admin/api/catalog')).json().revision;
    assert.notEqual(afterRev, beforeRev, 'catalog_rev must advance');

    const etagAfter = (await server.request(
      '/api/v1/update/check?system=default&serial=SN-1&platform=linux-x86_64&version=0.13.0',
      { headers: fleetHeaders() },
    )).headers.etag;
    assert.notEqual(etagAfter, etagBefore, 'a stale validator must stop matching');
  });

  test('deleting an artifact removes its file', async () => {
    // From a release NO channel serves. This used to remove the fleet artifact of 0.15.0 — which
    // the next test shows is a channel's latest — and expect 200: it asserted, as correct, the
    // removal that leaves every device on that channel told there is no update. Removing from a
    // served release is now refused; that case lives in tests/delete-build.test.js.
    const artifact = await publish(session, { version: '0.16.0', kind: 'fleet' });

    const res = await session.api(`/admin/api/artifacts/${artifact.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200, res.text());

    const files = await fsp.readdir(path.join(artifactsDir, 'default', '0.16.0')).catch(() => []);
    assert.ok(!files.includes('fleet.tar.gz'), 'the file must go with the row');
  });

  test('a release that is a channel latest cannot be deleted', async () => {
    const res = await session.api('/admin/api/systems/default/releases/0.15.0', { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.match(res.json().message, /latest/);
  });
});
