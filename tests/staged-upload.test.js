import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  SKIP_MESSAGE, bundle, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * The two-step upload: look, then commit.
 *
 * The whole reason it is two calls is that an operator reads the version, the plugins and the
 * config params BEFORE any of it is in the catalog. So the property that matters most here is
 * a negative one — step one must leave the database exactly as it found it.
 */
describe('staged upload', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer({ env: { REQUIRE_CUMULATIVE_CONFIG: '0' } });
    session = await signIn(server);
  });

  after(async () => { await server?.close(); });

  const stage = (body, query = '') => session.api(
    `/admin/api/uploads${query ? `?${query}` : ''}`,
    { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body },
  );

  const commit = (token) => session.api(`/admin/api/uploads/${token}`, { method: 'POST' });

  const catalogOf = async () => (await session.api('/admin/api/catalog')).json();
  const versions = async () => (await catalogOf()).releases.map((r) => r.version).sort();

  test('step one describes the bundle and stores nothing', async () => {
    const before = await versions();

    const res = await stage(bundle({
      version: '1.0.0',
      cores: [{ platform: 'linux-x86_64' }],
      plugins: [{ name: 'Camera', platform: 'linux-x86_64', version: '2.0.0' }],
      configs: [{ target: 'core', values: { web: { port: 9090 } } }],
    }));

    assert.equal(res.status, 200, res.text());
    const staged = res.json();

    // Everything an operator needs to decide, before deciding.
    assert.equal(staged.version, '1.0.0');
    assert.equal(staged.stored, false);
    assert.ok(staged.token);
    assert.deepEqual(staged.platforms, ['linux-x86_64']);
    assert.equal(staged.inspection.plugins[0].version, '2.0.0');
    assert.deepEqual(staged.inspection.configs[0].params.map((p) => p.param), ['web.port']);

    // And the point: nothing happened.
    assert.deepEqual(await versions(), before, 'no release may appear from a preview');
  });

  test('step two stores it and puts it on beta', async () => {
    const staged = (await stage(bundle({
      version: '1.1.0', cores: [{ platform: 'linux-x86_64' }],
    }))).json();

    const res = await commit(staged.token);
    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, 'beta');
    assert.equal(res.json().stored, true);

    const { channels } = await catalogOf();
    const of = (name) => channels.find((c) => c.system === 'default' && c.name === name).latest;
    assert.equal(of('beta'), '1.1.0');
    assert.notEqual(of('stable'), '1.1.0', 'the fleet waits for a promote');
  });

  test('a token works once', async () => {
    const staged = (await stage(bundle({
      version: '1.2.0', cores: [{ platform: 'linux-x86_64' }],
    }))).json();

    assert.equal((await commit(staged.token)).status, 201);
    assert.equal((await commit(staged.token)).status, 404, 'the bytes were renamed away');
  });

  test('a token that is not a token never reaches the filesystem', async () => {
    // This parameter is joined onto a path. Without the shape check it is a traversal straight
    // into the artifacts directory.
    // Two ways to be refused, and both are fine: the router declines to match a path with a
    // traversal in it, and the validator declines anything that is not the UUID the server
    // itself generated. What must never happen is a 2xx or a 5xx — the first would mean it
    // resolved to something, the second that it tried.
    for (const bad of ['..', '..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e']) {
      const res = await session.api(`/admin/api/uploads/${bad}`, { method: 'POST' });
      assert.ok(res.status === 400 || res.status === 404,
        `${bad} must be refused, got ${res.status}`);
    }

    // Well-formed path, wrong shape: this does reach the validator, and it says so.
    for (const bad of ['not-a-uuid', '0000', 'x'.repeat(64)]) {
      const res = await session.api(`/admin/api/uploads/${bad}`, { method: 'POST' });
      assert.equal(res.status, 400, `${bad} must be refused as malformed`);
      assert.equal(res.json().error, 'invalid_parameter');
    }
  });

  test('a token whose bytes are gone says so, rather than failing obscurely', async () => {
    const staged = (await stage(bundle({
      version: '1.3.0', cores: [{ platform: 'linux-x86_64' }],
    }))).json();

    // Exactly what the hourly pruner does to an upload nobody committed. The path comes from
    // the server rather than being guessed: a test that quietly skips itself when it guesses
    // wrong is worse than no test.
    // Imported here, not at the top: config/index.js reads process.env when it is first
    // imported, and startServer() sets that env — a static import would freeze the paths
    // before the server had chosen them.
    const { tempDir } = await import('../src/services/publish.service.js');
    const staleFile = path.join(tempDir(), `${staged.token}.part`);
    await fsp.access(staleFile);
    await fsp.rm(staleFile);

    const res = await commit(staged.token);
    assert.equal(res.status, 404);
    assert.match(res.json().message, /upload the file again/);
  });

  test('a preview is re-checked at commit, not trusted', async () => {
    // The catalog can move between the two calls. Here the same version is committed twice:
    // the second commit was previewed when it was legal and must still be refused.
    const first = (await stage(bundle({
      version: '1.4.0', cores: [{ platform: 'linux-x86_64' }],
    }))).json();
    const second = (await stage(bundle({
      version: '1.4.0', cores: [{ platform: 'linux-x86_64' }],
    }))).json();

    assert.equal((await commit(first.token)).status, 201);

    const res = await commit(second.token);
    assert.equal(res.status, 409, 'the duplicate check must run against the state right now');
  });

  test('a bundle the server refuses never gets a token', async () => {
    const res = await stage(bundle({
      version: '2.0.0',
      cores: [{ platform: 'linux-x86_64', version: '1.9.9' }], // slice disagrees on purpose
    }));

    assert.equal(res.status, 400);
    assert.equal(res.json().token, undefined, 'nothing to commit, so nothing to hold');
  });
});
