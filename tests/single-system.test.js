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
 * A device flashed at the factory reports a version this server never published, so on a new
 * fleet the version lookup places nobody. Parking all of them for review is the right answer
 * only when there is something to confuse them with — with one system there is no wrong
 * answer, and making an operator confirm the same decision once per device would be the
 * feature making things worse.
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
        '/api/v1/update/check?serial=SN-NEW&platform=linux-x86_64&version=0.1.0&channel=stable',
        { headers: fleetHeaders() },
      );

      assert.equal(res.status, 200);
      assert.equal(res.json().update_available, true);
      assert.equal(res.json().version, '2.0.0');
    });

    test('and it is not added to the review queue', async () => {
      const { nodes } = (await session.api('/admin/api/unclassified')).json();
      assert.deepEqual(nodes, [], 'nothing to review while one system exists');
    });

    test('creating a second system is what starts the review queue', async () => {
      await session.api('/admin/api/systems', {
        method: 'POST', body: JSON.stringify({ name: 'gcs' }),
      });

      const res = await server.request(
        '/api/v1/update/check?serial=SN-NEW2&platform=linux-x86_64&version=0.1.0&channel=stable',
        { headers: fleetHeaders() },
      );
      assert.equal(res.json().update_available, false, 'now there is something to confuse it with');

      const { nodes } = (await session.api('/admin/api/unclassified?filter=pending')).json();
      assert.ok(nodes.some((node) => node.serial === 'SN-NEW2'));
    });
  });
