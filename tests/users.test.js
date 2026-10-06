import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_MESSAGE, hasDatabase, signIn, startServer } from './helpers/harness.js';

/**
 * Account creation through Keycloak's admin API.
 *
 * Keycloak is not stood up for the test suite, so what is pinned here is the behaviour
 * that does not depend on it: the endpoint is authenticated, it validates its input before
 * reaching out, and it degrades to `configured: false` rather than erroring when the realm
 * is not wired up. The Keycloak round trip itself is exercised by hand against the real
 * server — see docs.
 */
describe('POST /admin/api/users', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer();
    session = await signIn(server);
  });

  after(async () => { await server?.close(); });

  test('listing degrades gracefully when Keycloak is not configured', async () => {
    const res = await session.api('/admin/api/users');
    assert.equal(res.status, 200);
    const body = res.json();
    // The admin UI hides the panel on this rather than showing broken controls.
    assert.equal(body.configured, false);
    assert.deepEqual(body.users, []);
  });

  test('creating requires authentication', async () => {
    const res = await server.request('/admin/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'temporary-123' }),
    });
    assert.equal(res.status, 401);
  });

  // Validation runs before Keycloak is contacted, so these answer the same way whether or
  // not a realm exists — and a bad username should never become a confusing Keycloak error.
  test('a missing username is rejected', async () => {
    const res = await session.api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ password: 'temporary-123' }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'missing_parameter');
  });

  test('a malformed username is rejected', async () => {
    const res = await session.api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'no spaces allowed', password: 'temporary-123' }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'invalid_parameter');
  });

  test('a short temporary password is rejected', async () => {
    const res = await session.api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'validname', password: 'short' }),
    });
    assert.equal(res.status, 400);
  });

  test('a malformed email is rejected', async () => {
    const res = await session.api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'validname', email: 'not-an-email', password: 'temporary-123' }),
    });
    assert.equal(res.status, 400);
  });

  test('a valid request says Keycloak is not configured rather than half-creating', async () => {
    const res = await session.api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'validname', email: 'a@b.co', password: 'temporary-123' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.json().message, /not configured/i);
  });

  /**
   * Self-service sign-up is OFF unless ALLOW_SELF_REGISTRATION says otherwise, and this suite
   * does not set it. The open case is register.test.js — config reads process.env once, so a
   * file gets one configuration.
   */
  test('self-service registration is off by default', async () => {
    const probe = await server.request('/admin/api/auth/registration');
    assert.equal(probe.status, 200);
    assert.equal(probe.json().enabled, false);

    const res = await server.request('/admin/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'stranger', password: 'chosen-password-1' }),
    });
    assert.equal(res.status, 403);
  });

  /** Refused before the body is parsed: a disabled endpoint does not describe its schema. */
  test('a disabled endpoint refuses without validating', async () => {
    const res = await server.request('/admin/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'no spaces', password: 'x' }),
    });
    assert.equal(res.status, 403);
  });
});
