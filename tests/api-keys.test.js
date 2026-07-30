import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_KEY, SKIP_MESSAGE, fleetHeaders, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * Handing an operator the fleet key, so a device can be provisioned without shell access.
 *
 * The key is a **shared** credential — every node presents the same string — so seeing it is
 * equivalent to being able to impersonate any node, and rotating it means re-provisioning the
 * whole fleet. That is why the read is audited even though the caller is already an admin.
 */
describe('fleet API keys', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer();
    session = await signIn(server);
  });

  after(async () => { await server?.close(); });

  test('an admin can read the key a node has to send', async () => {
    const res = await session.api('/admin/api/api-keys');

    assert.equal(res.status, 200);
    const body = res.json();
    assert.deepEqual(body.keys, [{ fleet: 'test-fleet', key: API_KEY }]);
    assert.equal(body.shared, true, 'the payload says so, not only the UI');
  });

  test('the key it returns is the one that actually authenticates', async () => {
    // The endpoint would be worse than useless if it printed something a node could not use:
    // an operator would provision a device that silently fails every check.
    const { keys } = (await session.api('/admin/api/api-keys')).json();

    const res = await server.request('/api/v1/health', {
      headers: { 'X-API-Key': keys[0].key },
    });
    assert.equal(res.status, 200);
  });

  test('reading it leaves an audit entry naming who looked', async () => {
    await session.api('/admin/api/api-keys');

    const { entries } = (await session.api('/admin/api/audit')).json();
    const entry = entries.find((row) => row.action === 'apikey.read');

    assert.ok(entry, 'a credential read that leaves no trace is not accountable');
    assert.equal(entry.actor, 'testadmin');
    assert.match(entry.subject, /test-fleet/);
  });

  test('it is admin-only — a fleet key cannot read the fleet keys', async () => {
    // Otherwise one leaked key would hand over every other one.
    const res = await server.request('/admin/api/api-keys', { headers: fleetHeaders() });
    assert.equal(res.status, 401);
  });

  test('an unauthenticated request gets nothing', async () => {
    const res = await server.request('/admin/api/api-keys');
    assert.equal(res.status, 401);
  });
});
