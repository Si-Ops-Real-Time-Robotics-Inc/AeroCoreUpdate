import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OIDC_ADMIN_ROLE, OIDC_AUDIENCE_ADMIN, OIDC_AUDIENCE_FLEET, SKIP_MESSAGE, hasDatabase, signIn,
  startServer,
} from './helpers/harness.js';

/**
 * Admin sign-in, which since feature 002 means a Keycloak token and nothing else.
 *
 * The local password path this file used to test alongside it was removed with the account
 * it served: this server holds no credential that opens itself (Constitution I, 2.0.0).
 */
describe('admin auth via Keycloak', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  const admin = (token) => server.request('/admin/api/catalog', {
    headers: { Authorization: `Bearer ${token}` },
  });

  before(async () => { server = await startServer(); });
  after(async () => { await server?.close(); });

  const adminToken = (extra = {}) =>
    server.token({ aud: OIDC_AUDIENCE_ADMIN, roles: [OIDC_ADMIN_ROLE], ...extra });

  test('an admin-audience token carrying the admin role is accepted', async () => {
    const res = await admin(adminToken());
    assert.equal(res.status, 200);
  });

  test('a first sign-in creates the local row the rest of the server refers to', async () => {
    const token = adminToken({ sub: 'brand-new-subject', username: 'newcomer' });
    assert.equal((await admin(token)).status, 200);
    // Second call goes down the ON CONFLICT branch; a unique-violation would surface here.
    assert.equal((await admin(token)).status, 200);
  });

  /**
   * The whole point of the role check. A `customer` — the role this server grants every
   * account it creates, and every self-service sign-up — holds a perfectly valid token for
   * the admin audience. Authentication succeeds; authorisation is what must refuse it.
   */
  test('a valid admin-audience token WITHOUT the admin role is refused', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_ADMIN, roles: ['customer'] }));
    assert.equal(res.status, 403);
  });

  test('a token carrying no roles at all is refused', async () => {
    const res = await admin(server.token({ aud: OIDC_AUDIENCE_ADMIN }));
    assert.equal(res.status, 403);
  });

  /** An unauthorised sign-in must not leave an admin_user row behind to be granted later. */
  test('a refused sign-in creates no local account', async () => {
    const sub = 'unauthorised-subject';
    assert.equal((await admin(server.token({
      aud: OIDC_AUDIENCE_ADMIN, sub, username: 'nobody', roles: ['customer'],
    }))).status, 403);

    // Granting the role afterwards is the only thing that admits them, and it works.
    assert.equal((await admin(server.token({
      aud: OIDC_AUDIENCE_ADMIN, sub, username: 'nobody', roles: [OIDC_ADMIN_ROLE],
    }))).status, 200);
  });

  /**
   * The browser sign-in is a separate switch from accepting Keycloak tokens: this suite
   * configures the second and not the first, and the page must then draw no button rather
   * than one that leads nowhere.
   */
  test('without a web client configured, the page is told there is no button', async () => {
    const res = await server.request('/admin/api/auth/oidc');
    assert.equal(res.json().enabled, false);
  });

  // ── cutting sessions ────────────────────────────────────────────────────────────────────

  /**
   * Removing a role in Keycloak does not reach a token already minted: the roles are inside
   * it, and it stays valid for its full lifetime. Cutting is what makes a demotion bite now,
   * and it is deliberately not a demotion itself — the account signs in again immediately,
   * with whatever it is entitled to at that point.
   */
  test('a token minted before a cut is refused; a fresh one is not', async () => {
    const who = { sub: 'demoted-subject', username: 'demoted' };
    const before = adminToken({ ...who, issuedAgo: 120 });
    assert.equal((await admin(before)).status, 200, 'sanity: it works before the cut');

    const session = await signIn(server);
    const cut = await session.api('/admin/api/users/demoted/sessions', { method: 'DELETE' });
    assert.equal(cut.status, 200);

    assert.equal((await admin(before)).status, 401, 'the old token is dead');
    assert.equal((await admin(adminToken(who))).status, 200, 'signing in again still works');
  });

  test('cutting an account that has never signed in here is a 404', async () => {
    const session = await signIn(server);
    const res = await session.api('/admin/api/users/nobody-at-all/sessions', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  /** Cutting yourself while cutting somebody else is a slip, not an intention. */
  test('cutting your own sessions is refused', async () => {
    // There is no self-service equivalent any more, so this simply says no rather
    // than naming another route.
    const session = await signIn(server);
    const res = await session.api(`/admin/api/users/${session.user.username}/sessions`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 400);
    assert.match(res.json().message, /cannot be used on your own/i);
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

});
