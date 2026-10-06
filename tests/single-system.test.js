import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_MESSAGE, bundle, fleetHeaders, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * Its own file because startServer() may be called only once per process: config/index.js
 * reads process.env on first import, so a second call silently reuses the first call's
 * settings — including its schema. Sharing a file with the multi-system suite meant this one
 * inherited its releases, and a version it expected to publish was already taken.
 */

/**
 * The single-system case, which is what every existing installation is and what the migration
 * leaves behind.
 *
 * A bundle that names no system goes to the only one there is. A node always names its own —
 * the check requires it — so a device flashed at the factory, on a version this server never
 * published, is placed by what it says and never waits for review, however many systems exist.
 */
describe('one system leaves nothing to disambiguate',
  { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
    let server;
    let session;

    before(async () => {
      server = await startServer();
      session = await signIn(server);

      const res = await session.api('/admin/api/artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip' },
        body: bundle({ version: '2.0.0', cores: [{ platform: 'linux-x86_64' }] }),
      });
      assert.equal(res.status, 201, res.text());

      await session.api('/admin/api/systems/default/channels/stable', {
        method: 'PUT', body: JSON.stringify({ latest: '2.0.0' }),
      });
    });

    after(async () => { await server?.close(); });

    test('a bundle that names no system joins the default one', async () => {
      const { releases } = (await session.api('/admin/api/catalog')).json();
      assert.equal(releases.find((r) => r.version === '2.0.0').system, 'default');
    });

    test('a factory-fresh node on an unpublished version is still served', async () => {
      const res = await server.request(
        '/api/v1/update/check?system=default&serial=SN-NEW&platform=linux-x86_64&version=0.1.0&channel=stable',
        { headers: fleetHeaders() },
      );

      assert.equal(res.status, 200);
      assert.equal(res.json().update_available, true);
      assert.equal(res.json().version, '2.0.0');
    });

    test('and it is not added to the review queue', async () => {
      const { nodes } = (await session.api('/admin/api/unclassified')).json();
      assert.deepEqual(nodes, [], 'it said what it is, so there is nothing to review');
    });

    test('a second system changes nothing for a node that says which it is', async () => {
      // This used to start the review queue: with two systems, a version nobody published could
      // belong to either. The node's own claim settles it, so there is nothing to review.
      await session.api('/admin/api/systems', {
        method: 'POST', body: JSON.stringify({ name: 'gcs' }),
      });

      const res = await server.request(
        '/api/v1/update/check?system=default&serial=SN-NEW2&platform=linux-x86_64&version=0.1.0&channel=stable',
        { headers: fleetHeaders() },
      );
      assert.equal(res.json().version, '2.0.0');

      const { nodes } = (await session.api('/admin/api/unclassified?filter=pending')).json();
      assert.deepEqual(nodes, []);
    });
  });
