import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_MESSAGE, bundle, fakeArtifact, fleetHeaders, hasDatabase, publish, setChannel, sha256Hex,
  signIn, startServer,
} from './helpers/harness.js';

describe('GET /api/v1/update/download/{version}', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  // A real bundle, padded with incompressible bytes so the .tar.gz stays large enough to
  // exercise streaming and Range. Every size assertion is derived from body.length.
  const SLIM = bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    filler: fakeArtifact(5 * 1024 * 1024 + 137, 19),
  });
  const FLEET = bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
  });

  before(async () => {
    server = await startServer();
    session = await signIn(server);

    await publish(session, { version: '0.15.0', platform: 'linux-x86_64', body: SLIM });
    await publish(session, {
      version: '0.15.0', kind: 'fleet', platforms: ['linux-x86_64', 'android-aarch64'], body: FLEET,
    });
    await setChannel(session, 'stable', { latest: '0.15.0' });
  });

  after(async () => { await server?.close(); });

  const get = (pathname, headers = {}) =>
    server.request(pathname, { headers: fleetHeaders(headers) });

  // `system` is required: these bytes are a firmware image for one product, and a request
  // that cannot name it is refused rather than served. The check response hands the whole URL
  // over, so a real client never composes one without it.
  const SLIM_URL = '/api/v1/update/download/0.15.0?platform=linux-x86_64&system=default';

  test('serves the exact bytes with an exact Content-Length', async () => {
    const res = await get(SLIM_URL);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/gzip');
    assert.equal(res.headers['content-length'], String(SLIM.length));
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['transfer-encoding'], undefined, 'never chunked');
    assert.match(res.headers['content-disposition'],
      /attachment; filename="aerocore-0\.15\.0-linux-x86_64\.tar\.gz"/);
    assert.ok(res.buffer.equals(SLIM), 'the 5 MB body must stream through byte for byte');
  });

  test('the served bytes hash to the sha256 the check response signed', async () => {
    const manifest = (await get(
      '/api/v1/update/check?serial=SN-1&platform=linux-x86_64&version=0.13.0',
    )).json();

    const body = await get(SLIM_URL);
    assert.equal(sha256Hex(body.buffer), manifest.sha256);
    assert.equal(body.buffer.length, manifest.size);
  });

  test('Range: bytes=N- resumes with a 206', async () => {
    const start = 4 * 1024 * 1024;
    const res = await get(SLIM_URL, { Range: `bytes=${start}-` });

    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${SLIM.length - 1}/${SLIM.length}`);
    assert.equal(res.headers['content-length'], String(SLIM.length - start));
    assert.ok(res.buffer.equals(SLIM.subarray(start)), 'the tail must match exactly');
  });

  test('a closed range works too', async () => {
    const res = await get(SLIM_URL, { Range: 'bytes=100-199' });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-length'], '100');
    assert.ok(res.buffer.equals(SLIM.subarray(100, 200)));
  });

  test('a range past the end is 416 with the resource size', async () => {
    const res = await get(SLIM_URL, { Range: `bytes=${SLIM.length}-` });

    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], `bytes */${SLIM.length}`);
    assert.equal(res.json().error, 'range_not_satisfiable');
  });

  test('multi-range is refused with 416', async () => {
    const res = await get(SLIM_URL, { Range: 'bytes=0-9,20-29' });
    assert.equal(res.status, 416);
  });

  test('a malformed Range is ignored and the full body is served', async () => {
    const res = await get(SLIM_URL, { Range: 'items=0-99' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(SLIM.length));
  });

  test('If-None-Match gives a bodyless 304, and wins over Range', async () => {
    const first = await get(SLIM_URL);
    const etag = first.headers.etag;
    assert.ok(etag);

    const res = await get(SLIM_URL, { 'If-None-Match': etag });
    assert.equal(res.status, 304);
    assert.equal(res.buffer.length, 0);
    assert.equal(res.headers['content-length'], undefined);

    const withRange = await get(SLIM_URL, { 'If-None-Match': etag, Range: 'bytes=0-9' });
    assert.equal(withRange.status, 304, 'conditional requests take precedence over Range');
  });

  test('a fleet artifact is served to any platform it covers', async () => {
    // `platform` is always required — it is what the server checks the package against, not
    // just what it selects by. A fleet artifact covering this platform answers it.
    // android-aarch64 has no slim artifact, so the fleet bundle is what covers it. Asking with
    // linux-x86_64 would get the slim one instead — the more specific package wins.
    const res = await get(
      '/api/v1/update/download/0.15.0?platform=android-aarch64&system=default',
    );

    assert.equal(res.status, 200);
    assert.ok(res.buffer.equals(FLEET));
    assert.match(res.headers['content-disposition'], /aerocore-0\.15\.0-android-aarch64\.tar\.gz/);
  });

  test('HEAD returns the headers with no body', async () => {
    const res = await server.request(SLIM_URL, { method: 'HEAD', headers: fleetHeaders() });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(SLIM.length));
    assert.equal(res.buffer.length, 0);
  });

  test('unknown version or platform is 404', async () => {
    const unknownVersion = '/api/v1/update/download/9.9.9?platform=linux-x86_64&system=default';
    assert.equal((await get(unknownVersion)).status, 404);

    const missing = '/api/v1/update/download/0.15.0?platform=macos-aarch64&system=default';
    assert.equal((await get(missing)).status, 404);
    assert.equal((await get(missing)).json().error, 'not_found');
  });

  test('a download missing system or platform is refused before anything is looked up', async () => {
    // Both are keys, not hints. A caller never composes this URL — the check response hands it
    // over complete — so a request missing either is something that built the URL itself.
    for (const url of [
      '/api/v1/update/download/0.15.0?platform=linux-x86_64',
      '/api/v1/update/download/0.15.0?system=default',
      '/api/v1/update/download/0.15.0',
    ]) {
      const res = await get(url);
      assert.equal(res.status, 400, url);
      assert.equal(res.json().error, 'missing_parameter', url);
    }
  });

  test('a platform the package does not cover is 404, not bytes it cannot use', async () => {
    // Serving it would be the `no_variant_for_platform` skip: the node applies nothing and
    // reports success, so the update looks done and the device never moved.
    const res = await get('/api/v1/update/download/0.15.0?platform=macos-aarch64&system=default');
    assert.equal(res.status, 404);
  });

  test('naming another system is 404, not another product\'s bytes', async () => {
    // Indistinguishable from a version that does not exist, on purpose: telling the two apart
    // would leak which version numbers other systems use.
    const res = await get(
      '/api/v1/update/download/0.15.0?platform=linux-x86_64&system=drone',
    );
    assert.equal(res.status, 404);
  });

  test('path traversal cannot escape the artifact root', async () => {
    for (const attempt of [
      '/api/v1/update/download/..%2f..%2fpackage.json',
      '/api/v1/update/download/%2e%2e%2f%2e%2e%2fpackage.json',
      '/api/v1/update/download/0.15.0%2f..%2f..%2fpackage.json?system=default',
    ]) {
      const res = await get(attempt);
      assert.ok([400, 404].includes(res.status), `${attempt} -> ${res.status}`);
      assert.ok(!res.text().includes('"name": "aeroserver"'), 'must never serve a repo file');
    }
  });

  test('a malformed percent-escape is a 400, not a 500', async () => {
    const res = await get('/api/v1/update/download/%E0%A4%A');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'invalid_parameter');
  });
});
