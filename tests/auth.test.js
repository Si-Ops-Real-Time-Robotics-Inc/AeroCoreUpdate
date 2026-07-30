import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_PASSWORD, ADMIN_USER, API_KEY, SKIP_MESSAGE, fleetHeaders, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

describe('admin authentication', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server?.close(); });

  const login = (username, password) => server.request('/admin/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username, password }),
  });

  test('a valid sign-in returns an access token and a hardened refresh cookie', async () => {
    const res = await login(ADMIN_USER, ADMIN_PASSWORD);
    assert.equal(res.status, 200);

    const body = res.json();
    assert.ok(body.access_token);
    assert.equal(body.user.username, ADMIN_USER);

    const cookie = res.setCookie.find((value) => value.startsWith('aeroserver_refresh='));
    assert.ok(cookie, 'a refresh cookie must be set');
    assert.match(cookie, /HttpOnly/, 'JavaScript must never read it');
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/admin\/api\/auth/);
    assert.ok(!body.refresh_token, 'the refresh token must not also come back in the body');
  });

  test('a wrong password and an unknown user are indistinguishable', async () => {
    const wrongPassword = await login(ADMIN_USER, 'not-the-password');
    const unknownUser = await login('nobody', 'not-the-password');

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.json().message, unknownUser.json().message);
    assert.equal(wrongPassword.json().error, 'invalid_api_key');
  });

  test('protected endpoints require a bearer token', async () => {
    for (const headers of [{}, { Authorization: 'Bearer nonsense' }, { Authorization: 'Basic x' }]) {
      const res = await server.request('/admin/api/catalog', { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
  });

  test('refresh rotates the token and requires the anti-CSRF header', async () => {
    const session = await signIn(server);

    const noHeader = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { Cookie: session.cookie },
    });
    assert.equal(noHeader.status, 400, 'a plain HTML form cannot set X-Requested-With');

    const res = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { Cookie: session.cookie, 'X-Requested-With': 'fetch' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json().access_token);
    assert.ok(res.setCookie.length, 'a rotated refresh cookie must be issued');
  });

  test('reusing a rotated refresh token kills the whole family', async () => {
    const session = await signIn(server);
    const original = session.cookie;

    const rotated = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { Cookie: original, 'X-Requested-With': 'fetch' },
    });
    assert.equal(rotated.status, 200);
    const newCookie = rotated.setCookie.map((v) => v.split(';')[0]).join('; ');

    // Presenting the old one means it leaked.
    const reuse = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { Cookie: original, 'X-Requested-With': 'fetch' },
    });
    assert.equal(reuse.status, 401);

    // ...and the legitimate holder is cut off too, which is the point.
    const afterBreach = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { Cookie: newCookie, 'X-Requested-With': 'fetch' },
    });
    assert.equal(afterBreach.status, 401, 'the whole family must be revoked');
  });

  test('logout revokes the refresh token', async () => {
    const session = await signIn(server);

    await server.request('/admin/api/auth/logout', {
      method: 'POST', headers: { Cookie: session.cookie, 'X-Requested-With': 'fetch' },
    });

    const res = await server.request('/admin/api/auth/refresh', {
      method: 'POST', headers: { Cookie: session.cookie, 'X-Requested-With': 'fetch' },
    });
    assert.equal(res.status, 401);
  });

  test('the two credentials never open each other\'s routes', async () => {
    const session = await signIn(server);
    const FLEET_URL = '/api/v1/update/check?serial=S&platform=linux-x86_64&version=0.1.0';

    // An API key is useless on the admin surface.
    const adminWithApiKey = await server.request('/admin/api/catalog', { headers: fleetHeaders() });
    assert.equal(adminWithApiKey.status, 401);

    // A JWT is useless on the fleet surface.
    const fleetWithJwt = await server.request(FLEET_URL, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(fleetWithJwt.status, 401);
    assert.equal(fleetWithJwt.json().error, 'invalid_api_key');

    // The API key alone does open it, proving the refusal is about the credential type and
    // not a blanket rejection.
    const fleetWithKey = await server.request(FLEET_URL, { headers: { 'X-API-Key': API_KEY } });
    assert.equal(fleetWithKey.status, 200);
  });

  // Runs last on purpose: it locks the shared account out for the rest of the window, so any
  // test after it could not sign in.
  test('repeated failures lock the account out with Retry-After', async () => {
    let locked = null;

    for (let attempt = 0; attempt < 8 && !locked; attempt += 1) {
      const res = await login(ADMIN_USER, `wrong-${attempt}`);
      if (res.status === 429) locked = res;
    }

    assert.ok(locked, 'five failures inside the window must trigger a lockout');
    assert.equal(locked.json().error, 'rate_limited');
    assert.ok(Number(locked.headers['retry-after']) > 0);

    // The correct password is refused too until the window passes — that is what makes the
    // lockout worth anything.
    assert.equal((await login(ADMIN_USER, ADMIN_PASSWORD)).status, 429);
  });
});
