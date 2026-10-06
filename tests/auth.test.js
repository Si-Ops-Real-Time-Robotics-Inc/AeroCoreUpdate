import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_KEY, SKIP_MESSAGE, fleetHeaders, hasDatabase, startServer,
} from './helpers/harness.js';

/**
 * What is left of admin authentication after the local account was removed
 * (feature 002): the realm is the only source of identity, and nothing this
 * server holds opens it.
 *
 * The suite this replaced tested password sign-in, refresh rotation, family
 * revocation and lockout — every one of those described a mechanism that no
 * longer exists. Keeping them passing would have meant keeping the mechanism.
 */
describe('admin authentication', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server?.close(); });

  test('there is no password sign-in to reach', async () => {
    const res = await server.request('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ username: 'testadmin', password: 'test-admin-password-123' }),
    });
    // 404 rather than 401: the route is gone, not guarded. A 401 would mean the
    // door is still there and merely locked.
    assert.equal(res.status, 404);
  });

  test('neither is the password-change or sign-out-everywhere route', async () => {
    for (const path of ['/admin/api/auth/password', '/admin/api/auth/logout-all']) {
      const res = await server.request(path, {
        method: 'POST', headers: { 'X-Requested-With': 'fetch' },
      });
      assert.equal(res.status, 404, path);
    }
  });

  test('protected endpoints require a bearer token', async () => {
    for (const headers of [{}, { Authorization: 'Bearer nonsense' }, { Authorization: 'Basic x' }]) {
      const res = await server.request('/admin/api/catalog', { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
  });

  test('a token this realm did not issue is simply not a credential', async () => {
    // Before feature 002 an unrecognised token fell through to be re-judged as a
    // locally-issued one. There is no second judge now.
    const res = await server.request('/admin/api/auth/me', {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.nope' },
    });
    assert.equal(res.status, 401);
  });

  test('refresh answers 401 without a session cookie, and never falls back', async () => {
    const res = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { 'X-Requested-With': 'fetch' },
    });
    assert.equal(res.status, 401);

    // The anti-CSRF header is still required: this endpoint sets a cookie, and a
    // plain HTML form cannot send a custom header.
    const noHeader = await server.request('/admin/api/auth/refresh', { method: 'POST' });
    assert.equal(noHeader.status, 400);
  });

  test('a refusal never points at a door that was removed', async () => {
    // The message an operator sees when their account holds no recognised role
    // used to end "or sign in with the local break-glass account". Sending
    // someone to a door that no longer exists, at the moment they are already
    // stuck, is worse than simply saying no.
    const res = await server.request('/admin/api/auth/me', {
      headers: { Authorization: `Bearer ${server.token({ aud: 'aeroserver-admin', roles: [] })}` },
    });
    assert.equal(res.status, 403);
    const { message } = res.json();
    assert.match(message, /administrator must grant one/i, message);
    assert.doesNotMatch(message, /break-glass|local account/i, message);
  });

  test('the fleet credential does not open the admin API', async () => {
    // The two surfaces were always separate; this asserts that removing one way
    // in did not quietly widen the other.
    const res = await server.request('/admin/api/catalog', { headers: fleetHeaders(API_KEY) });
    assert.equal(res.status, 401);
  });
});
