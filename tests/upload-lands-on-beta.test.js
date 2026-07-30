import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  SKIP_MESSAGE, bundle, fakeArtifact, fleetHeaders, hasDatabase, legacyBundle, sha256Hex, signIn, startServer,
} from './helpers/harness.js';
import { targz } from './helpers/targz.js';

/**
 * The shipped default, with nothing configured: a fresh upload lands on `beta`.
 *
 * The variable is set explicitly here rather than left unset: the harness pins it to '' for
 * every suite, and `process.env` stringifies undefined, so "unset" cannot be expressed by
 * passing a value. That the SHIPPED default is this same `beta` is checked in config.test.js,
 * which reads it from a process where the variable genuinely does not exist.
 */
describe('a fresh upload lands on beta', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer({
      env: { AUTO_PROMOTE_CHANNEL: 'beta', REQUIRE_CUMULATIVE_CONFIG: '0' },
    });
    session = await signIn(server);
  });

  after(async () => { await server?.close(); });

  const upload = (body) => session.api('/admin/api/artifacts', {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body,
  });

  test('an upload nobody configured goes to beta, and beta is created for it', async () => {
    // A channel is only a pointer, so inventing one costs nothing — unlike a system, which is
    // a version line and must be created deliberately.
    const res = await upload(bundle({ version: '3.0.0', cores: [{ platform: 'linux-x86_64' }] }));

    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, 'beta');

    const { channels } = (await session.api('/admin/api/catalog')).json();
    const beta = channels.find((c) => c.name === 'beta');
    assert.ok(beta, 'created by the upload');
    assert.equal(beta.latest, '3.0.0');
  });

  test('stable is untouched — that is the whole point', async () => {
    // The fleet keeps getting what it was getting. Only devices an operator put on beta see
    // the new build, which is what makes it a test stage rather than a rollout.
    const { channels } = (await session.api('/admin/api/catalog')).json();
    assert.ok(!channels.some((c) => c.name === 'stable' && c.latest === '3.0.0'));
  });

  test('a node on stable is offered nothing new', async () => {
    const res = await server.request(
      '/api/v1/update/check?serial=SN-FLEET&platform=linux-x86_64&version=0.1.0&channel=stable',
      { headers: fleetHeaders() },
    );

    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false, 'the fleet waits for the promote');
  });

  test('a node on beta is offered it immediately', async () => {
    const res = await server.request(
      '/api/v1/update/check?serial=SN-TEST&platform=linux-x86_64&version=0.1.0&channel=beta',
      { headers: fleetHeaders() },
    );

    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, true);
    assert.equal(res.json().version, '3.0.0');
  });

  test('promoting it to stable takes it off beta', async () => {
    const res = await session.api('/admin/api/systems/default/channels/stable', {
      method: 'PUT', body: JSON.stringify({ latest: '3.0.0' }),
    });

    assert.equal(res.status, 200, res.text());
    assert.deepEqual(res.json().released, ['beta']);
  });
});
