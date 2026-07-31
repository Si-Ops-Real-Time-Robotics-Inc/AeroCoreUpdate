import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OIDC_AUDIENCE_ADMIN, OIDC_AUDIENCE_FLEET, SKIP_MESSAGE, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * Admin sign-in with a Keycloak token, alongside the local password path.
 *
 * The local path stays as break-glass: an IdP outage during a bad rollout is exactly when
 * someone needs to reach this server, so it must not depend on Keycloak being up.
 */
describe('admin auth via Keycloak', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  const admin = (token) => server.request('/admin/api/catalog', {
    headers: { Authorization: `Bearer ${token}` },
  });

  before(async () => { server = await startServer(); });
  after(async () => { await server?.close(); });

  test('an admin-audience token is accepted', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_ADMIN }));
    assert.equal(res.status, 200);
  });

  test('a first sign-in creates the local row the rest of the server refers to', async () => {
    const token = server.token({ aud: OIDC_AUDIENCE_ADMIN, sub: 'brand-new-subject', username: 'newcomer' });
    assert.equal((await admin(token)).status, 200);
    // Second call goes down the ON CONFLICT branch; a unique-violation would surface here.
    assert.equal((await admin(token)).status, 200);
  });

  // The mirror of the fleet test: audiences are per-surface precisely so a token minted for
  // the nodes is not also a key to administer the server.
  test('a fleet-audience token is refused on the admin API', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_FLEET }));
    assert.equal(res.status, 401);
  });

  test('an expired token is refused', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_ADMIN, expiresIn: -3600 }));
    assert.equal(res.status, 401);
  });

  test('alg: none is refused', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_ADMIN, alg: 'none' }));
    assert.equal(res.status, 401);
  });

  test('a token signed by an unknown key is refused', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_ADMIN, stranger: true }));
    assert.equal(res.status, 401);
  });

  // Break-glass: this is the path that has to keep working when Keycloak does not.
  test('local password sign-in still works', async () => {
    const session = await signIn(server);
    const res = await session.api('/admin/api/catalog');
    assert.equal(res.status, 200);
  });
});
