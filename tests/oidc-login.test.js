import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OIDC_ADMIN_ROLE, OIDC_AUDIENCE_ADMIN, SKIP_MESSAGE, hasDatabase, startServer,
} from './helpers/harness.js';

/**
 * Signing in to the admin UI with a Keycloak account.
 *
 * The whole flow is server-side on purpose and not for tidiness: /admin is HTTPS-only while
 * Keycloak is commonly plain HTTP on the same LAN, and a browser will not let an HTTPS page
 * POST to an HTTP token endpoint. Only the redirects cross that line, so only they happen in
 * the browser — which also keeps the client confidential and leaves the page with the same
 * session shape a local sign-in gives it.
 */
describe('admin sign-in via Keycloak', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  before(async () => {
    server = await startServer({
      env: { OIDC_WEB_CLIENT_ID: 'aerocore-server', OIDC_WEB_CLIENT_SECRET: 'test-secret' },
    });
  });
  after(async () => { await server?.close(); });

  const cookieOf = (res, name) => (res.setCookie ?? [])
    .find((value) => value.startsWith(`${name}=`));

  /** Start a sign-in and return the state and the cookie the browser would carry back. */
  async function beginSignIn() {
    const res = await server.request('/admin/api/auth/oidc/start');
    assert.equal(res.status, 302);
    const location = new URL(res.headers.location);
    const raw = cookieOf(res, 'aerocoreupdate_oidc_tx');
    return { location, cookie: raw.split(';')[0], state: location.searchParams.get('state') };
  }

  test('the sign-in page is told Keycloak is configured and answering', async () => {
    const res = await server.request('/admin/api/auth/oidc');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { enabled: true, reachable: true });
  });

  test('start redirects to the issuer, with PKCE and a state', async () => {
    const { location } = await beginSignIn();

    assert.ok(location.href.startsWith(server.idp.issuer), 'the ISSUER, not an internal address');
    assert.equal(location.pathname.endsWith('/protocol/openid-connect/auth'), true);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    // The whole URL, not just its tail: the first version of this built
    // `https://undefined/admin/api/auth/oidc/callback`, because HTTP/2 carries no `host`
    // header and the authority lives in `:authority`. Keycloak answered
    // `invalid_redirect_uri`, which names the setting rather than the mistake.
    const redirect = new URL(location.searchParams.get('redirect_uri'));
    assert.equal(redirect.pathname, '/admin/api/auth/oidc/callback');
    assert.match(redirect.host, /^(localhost|127\.0\.0\.1):\d+$/,
      'a real authority, taken from the request rather than a missing header');
  });

  /**
   * Lax rather than Strict, and this is the one that would be silently wrong: the browser
   * reaches the callback by a redirect FROM Keycloak, and Strict withholds the cookie on
   * exactly that navigation — every sign-in would fail as a state mismatch.
   */
  test('the in-flight cookie is HttpOnly and SameSite=Lax', async () => {
    const res = await server.request('/admin/api/auth/oidc/start');
    const raw = cookieOf(res, 'aerocoreupdate_oidc_tx');

    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /Secure/);
  });

  test('a completed sign-in leaves a session the page can refresh', async () => {
    const { cookie, state } = await beginSignIn();

    const back = await server.request(`/admin/api/auth/oidc/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(back.status, 302);
    assert.equal(back.headers.location, '/admin/');

    const session = cookieOf(back, 'aerocoreupdate_oidc');
    assert.match(session, /HttpOnly/);

    // The page calls exactly this on load and cannot tell which kind of sign-in it was.
    const refreshed = await server.request('/admin/api/auth/refresh', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Cookie: session.split(';')[0] },
    });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json().access_token);
    assert.ok(refreshed.json().user.username);
  });

  test('a code that belongs to no sign-in started here is refused', async () => {
    const { cookie } = await beginSignIn();
    const res = await server.request('/admin/api/auth/oidc/callback?code=abc&state=not-the-state', {
      headers: { Cookie: cookie },
    });

    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/admin\/login\.html\?error=/);
    assert.match(decodeURIComponent(res.headers.location), /could not be matched/);
  });

  test('Keycloak refusing the sign-in comes back as a message, not a stack trace', async () => {
    const res = await server.request(
      '/admin/api/auth/oidc/callback?error=access_denied&error_description=Nope',
    );
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Nope/);
  });

  /**
   * The account exists and Keycloak is happy; this server is not. Refused at the callback so
   * the reason lands on the sign-in page — rather than admitting them to an app whose every
   * panel then answers 403.
   */
  test('an account with no role this server knows is turned away at the callback', async () => {
    server.idp.setTokenHandler(() => [200, {
      access_token: server.token({ aud: OIDC_AUDIENCE_ADMIN, roles: ['customer'] }),
      refresh_token: 'refresh-customer',
      expires_in: 300,
    }]);

    const { cookie, state } = await beginSignIn();
    const res = await server.request(`/admin/api/auth/oidc/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    });

    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /realm roles this server recognises/);
    assert.equal(cookieOf(res, 'aerocoreupdate_oidc'), undefined, 'and no session is left behind');
  });

  test('a refresh Keycloak refuses ends the session rather than looping', async () => {
    server.idp.setTokenHandler(() => [400, { error: 'invalid_grant' }]);

    const res = await server.request('/admin/api/auth/refresh', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Cookie: 'aerocoreupdate_oidc=stale-token' },
    });

    assert.equal(res.status, 401);
    assert.match(cookieOf(res, 'aerocoreupdate_oidc'), /Max-Age=0/, 'the dead cookie is cleared');

    // Put the good handler back for anything that runs after this.
    server.idp.setTokenHandler(() => [200, {
      access_token: server.token({ aud: OIDC_AUDIENCE_ADMIN, roles: [OIDC_ADMIN_ROLE] }),
      refresh_token: 'refresh-again',
      expires_in: 300,
    }]);
  });

  test('signing out clears the Keycloak session cookie too', async () => {
    const res = await server.request('/admin/api/auth/logout', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Cookie: 'aerocoreupdate_oidc=whatever' },
    });

    assert.equal(res.status, 200);
    assert.match(cookieOf(res, 'aerocoreupdate_oidc'), /Max-Age=0/);
  });

  /**
   * The page redirects to Keycloak without waiting for a click, which is only safe while
   * Keycloak answers. If it does not, the page has to stay put and offer the local account —
   * an automatic redirect into an outage is exactly what would strand an operator during the
   * incident the break-glass account exists for.
   *
   * Last in the file on purpose: an unreachable answer is remembered for ten seconds, so any
   * test after this one would inherit the outage.
   */
  test('an unreachable Keycloak is reported, so the page does not redirect into it', async () => {
    server.idp.setWellKnownStatus(503);

    const res = await server.request('/admin/api/auth/oidc');
    assert.deepEqual(res.json(), { enabled: true, reachable: false });
  });
});
