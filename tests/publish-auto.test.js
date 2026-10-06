import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  SKIP_MESSAGE, bundle, fakeArtifact, fleetHeaders, hasDatabase, legacyBundle, sha256Hex, signIn, startServer,
} from './helpers/harness.js';
import { targz } from './helpers/targz.js';

describe('publishing in one action', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    // These tests are about AUTO_PROMOTE_CHANNEL, which is empty by default — the shipped
    // behaviour is that an upload is staged and confirmed in the UI. Its own file because
    // startServer() may be called only once per process, and because leaving the cumulative
    // rule on chains unrelated uploads together.
    server = await startServer({
      env: { AUTO_PROMOTE_CHANNEL: 'stable', REQUIRE_CUMULATIVE_CONFIG: '0' },
    });
    session = await signIn(server);
  });

  after(async () => { await server?.close(); });

  const upload = (body, query = '') => session.api(
    `/admin/api/artifacts${query ? `?${query}` : ''}`,
    { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body },
  );

  // ── one action, nothing typed by hand ────────────────────────────────────────────────────

  test('an upload publishes, describes and promotes in one call', async () => {
    const body = bundle({
      version: '1.0.0',
      cores: [{ platform: 'linux-x86_64' }],
      plugins: [{ name: 'SRTunnel_Plugin', platform: 'linux-x86_64', version: '1.3.0' }],
      configs: [{ target: 'core', values: { web: { port: 9090 } } }],
      release: { min_version: '0.13.0', mandatory: true, notes: 'Adds ZMQ bus.' },
    });

    const res = await upload(body);
    assert.equal(res.status, 201, res.text());
    const created = res.json();

    // Release created, with the metadata read out of release.json.
    assert.equal(created.release_created, true);
    // The three fields release.json exists to carry. Asserted by name rather than as an exact
    // object: the report has since grown `system` and `configDropped`, and pinning the whole
    // shape here only breaks when something unrelated is added.
    const meta = created.inspection.release;
    assert.equal(meta.minVersion, '0.13.0');
    assert.equal(meta.mandatory, true);
    assert.equal(meta.notes, 'Adds ZMQ bus.');

    // Plugin versions from the plugin slice manifests.
    assert.deepEqual(created.plugins, { 'linux-x86_64': { SRTunnel_Plugin: '1.3.0' } });

    // Config params flattened out of the slim payload.
    assert.deepEqual(created.config, {
      'linux-x86_64': [{ target: 'core', param: 'web.port', to: 9090 }],
    });

    // And promoted, so the fleet sees it at the next poll.
    assert.equal(created.promoted_to, 'stable');

    const catalog = (await session.api('/admin/api/catalog')).json();
    const release = catalog.releases.find((r) => r.version === '1.0.0');
    assert.equal(release.minVersion, '0.13.0');
    assert.equal(release.mandatory, true);
    assert.equal(release.notes, 'Adds ZMQ bus.');
    assert.equal(catalog.channels.find((c) => c.name === 'stable').latest, '1.0.0');
  });

  test('the promoted release is immediately what a node is offered', async () => {
    const body = bundle({ version: '1.1.0', cores: [{ platform: 'linux-x86_64' }] });
    assert.equal((await upload(body)).status, 201);

    const check = await server.request(
      '/api/v1/update/check?system=default&serial=SN-AUTO&platform=linux-x86_64&version=0.13.0',
      { headers: { 'X-API-Key': 'test-fleet-key-0123456789' } },
    );

    assert.equal(check.status, 200);
    assert.equal(check.json().update_available, true);
    assert.equal(check.json().version, '1.1.0', 'no separate promote step was needed');
  });

  test('?channel= targets another channel, and an empty one publishes without promoting', async () => {
    const beta = bundle({ version: '1.2.0', cores: [{ platform: 'linux-x86_64' }] });
    assert.equal((await upload(beta, 'channel=beta')).json().promoted_to, 'beta');

    const quiet = bundle({ version: '1.3.0', cores: [{ platform: 'linux-x86_64' }] });
    const res = await upload(quiet, 'channel=');
    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, null);

    const catalog = (await session.api('/admin/api/catalog')).json();
    assert.equal(catalog.channels.find((c) => c.name === 'stable').latest, '1.1.0',
      'stable must not have moved');
    assert.equal(catalog.channels.find((c) => c.name === 'beta').latest, '1.2.0');
  });

  test('release metadata already edited by an operator is not overwritten', async () => {
    const first = bundle({
      version: '1.4.0',
      cores: [{ platform: 'linux-x86_64' }],
      release: { notes: 'from the bundle' },
    });
    assert.equal((await upload(first, 'channel=')).status, 201);

    await session.api('/admin/api/systems/default/releases/1.4.0', {
      method: 'PATCH', body: JSON.stringify({ notes: 'edited by hand' }),
    });

    // A second artifact for the same release must not silently revert that edit.
    const second = bundle({
      version: '1.4.0',
      cores: [{ platform: 'android-aarch64' }],
      release: { notes: 'from the bundle' },
    });
    assert.equal((await upload(second, 'channel=')).status, 201);

    const catalog = (await session.api('/admin/api/catalog')).json();
    assert.equal(catalog.releases.find((r) => r.version === '1.4.0').notes, 'edited by hand');
  });
});
