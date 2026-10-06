import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OIDC_ADMIN_ROLE, OIDC_AUDIENCE_ADMIN, SKIP_MESSAGE, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * Authorisation on the admin API: who may upload, and who may ship.
 *
 * The distinction this file exists for is upload vs publish. An artifact in the catalog
 * reaches nobody; a channel pointed at it reaches every aircraft following that channel. A
 * publisher may do the first and not the second, so a build can be prepared by the person who
 * wrote it and approved by someone else.
 */

// The config defaults, which the harness does not override.
const PUBLISHER_ROLE = 'aeroserver-publisher';
const VIEWER_ROLE = 'aeroserver-viewer';

describe('admin authorisation: scopes', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server?.close(); });

  const as = (roles) => ({
    Authorization: `Bearer ${server.token({ aud: OIDC_AUDIENCE_ADMIN, roles })}`,
  });

  const CHANNEL = '/admin/api/systems/default/channels/stable';
  const RELEASE = { method: 'POST', body: JSON.stringify({ version: '9.9.9' }) };

  /**
   * Deny by default, enforced rather than promised. A route added under plain `requireAuth`
   * would be reachable by every signed-in account — including the `viewer` this server hands
   * out — and nothing else in the suite would notice.
   */
  test('every authenticated admin route declares a scope', async () => {
    // Imported here, not at the top of the file: a static import would evaluate
    // config/index.js before startServer() has set the environment it reads.
    const { adminRoutes } = await import('../src/routes/admin.routes.js');

    const PUBLIC = new Set([
      'POST /api/auth/refresh', 'GET /api/auth/registration',
      'POST /api/auth/register', 'POST /api/auth/logout',
      // How a browser obtains a credential; there is nothing to check yet.
      'GET /api/auth/oidc', 'GET /api/auth/oidc/start', 'GET /api/auth/oidc/callback',
    ]);
    const undeclared = adminRoutes.routes
      .filter((route) => !PUBLIC.has(`${route.method} ${route.pattern}`))
      .filter((route) => typeof route.handler.scope !== 'string')
      .map((route) => `${route.method} ${route.pattern}`);
    assert.deepEqual(undeclared, []);
  });

  test('a publisher may add to the catalog', async () => {
    const res = await server.request('/admin/api/systems/default/releases', {
      ...RELEASE, headers: { ...as([PUBLISHER_ROLE]), 'Content-Type': 'application/json' },
    });
    assert.notEqual(res.status, 403);
  });

  // The line the whole model is drawn for.
  test('a publisher may NOT move a channel', async () => {
    const res = await server.request(CHANNEL, {
      method: 'PUT',
      headers: { ...as([PUBLISHER_ROLE]), 'Content-Type': 'application/json' },
      body: JSON.stringify({ latest: '9.9.9' }),
    });
    assert.equal(res.status, 403);
    assert.match(res.json().message, /channel:write/);
  });

  test('an admin may move a channel', async () => {
    const res = await server.request(CHANNEL, {
      method: 'PUT',
      headers: { ...as([OIDC_ADMIN_ROLE]), 'Content-Type': 'application/json' },
      body: JSON.stringify({ latest: null }),
    });
    assert.notEqual(res.status, 403);
  });

  test('a viewer reads the catalog and writes nothing', async () => {
    assert.equal((await server.request('/admin/api/catalog', { headers: as([VIEWER_ROLE]) })).status, 200);
    const res = await server.request('/admin/api/systems/default/releases', {
      ...RELEASE, headers: { ...as([VIEWER_ROLE]), 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 403);
  });

  // Credentials and accounts are not a publisher's business even though both sit behind the
  // same sign-in.
  test('neither lesser role reaches the signing key or the user list', async () => {
    for (const roles of [[PUBLISHER_ROLE], [VIEWER_ROLE]]) {
      assert.equal((await server.request('/admin/api/signing-key', { headers: as(roles) })).status, 403);
      assert.equal((await server.request('/admin/api/users', { headers: as(roles) })).status, 403);
    }
  });

  test('a role this server does not know grants nothing at all', async () => {
    const res = await server.request('/admin/api/catalog', { headers: as(['customer']) });
    assert.equal(res.status, 403);
  });

  /** Break-glass: the account that exists for Keycloak being down cannot depend on it. */
  test('the local admin keeps every scope', async () => {
    const session = await signIn(server);
    const res = await session.api('/admin/api/auth/me');
    assert.equal(res.status, 200);
    assert.ok(res.json().scopes.includes('channel:write'));
  });

  test('/me reports the scopes a Keycloak session actually has', async () => {
    const res = await server.request('/admin/api/auth/me', { headers: as([PUBLISHER_ROLE]) });
    assert.deepEqual(res.json().scopes, ['artifact:write', 'catalog:read', 'self']);
  });
});
