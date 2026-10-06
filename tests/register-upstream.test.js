import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_MESSAGE, hasDatabase, startServer } from './helpers/harness.js';

/**
 * What registration answers when Keycloak is configured but not answering.
 *
 * The point is the STATUS. A 500 tells the caller this server is broken and invites a bug
 * report; the truth is that a dependency is down or a realm setting is wrong, and the fix is
 * somewhere else entirely. Getting that distinction wrong sends an operator hunting through
 * AeroCoreUpdate for a fault that was never here.
 *
 * Port 1 has nothing listening, so every call fails the same way every run.
 */
describe('registration when the IdP is unreachable', {
  skip: hasDatabase ? false : SKIP_MESSAGE,
}, () => {
  let server;

  before(async () => {
    server = await startServer({
      env: {
        // Production, because that is the mode the masking in errorHandler applies to and the
        // only mode where this went wrong. Nothing else in the server branches on it.
        NODE_ENV: 'production',
        ALLOW_SELF_REGISTRATION: '1',
        KEYCLOAK_BASE_URL: 'http://127.0.0.1:1',
        KEYCLOAK_REALM: 'test',
        KEYCLOAK_ADMIN_CLIENT_ID: 'unreachable',
        KEYCLOAK_ADMIN_CLIENT_SECRET: 'unreachable',
      },
    });
  });

  after(async () => { await server?.close(); });

  const post = (body) => server.request('/admin/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('the probe reports available — the flag and the config are both set', async () => {
    // It cannot know the realm is down without asking, and asking on every page load would
    // make the sign-in page wait on an IdP round trip.
    assert.equal((await server.request('/admin/api/auth/registration')).json().enabled, true);
  });

  test('an unreachable IdP is 503, not 500', async () => {
    const res = await post({ username: 'newcomer', password: 'chosen-password-1' });
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'maintenance');
  });

  /**
   * errorHandler masks 5xx messages in production so a raw throw cannot leak internals. It
   * used to mask by STATUS, which swallowed the deliberate wording of every HttpError above
   * 499 too — this 503 arrived saying "Internal server error", reading like a crash and
   * sending operators to hunt for a fault in a server that was working correctly.
   */
  test('a deliberate 5xx keeps its own message in production', async () => {
    const res = await post({ username: 'newcomer', password: 'chosen-password-1' });
    assert.notEqual(res.json().message, 'Internal server error');
    assert.match(res.json().message, /not reachable/i);
  });

  test('it tells the caller to retry rather than describing the misconfiguration', async () => {
    const res = await post({ username: 'newcomer', password: 'chosen-password-1' });
    assert.ok(res.headers['retry-after'], 'a 503 without Retry-After is a dead end');
    // The caller here is anonymous. Which client id, which secret and which realm are wrong
    // are all facts for the server log.
    const { message } = res.json();
    assert.doesNotMatch(message, /client_id|secret|KEYCLOAK_/i);
  });

  test('validation still runs first, so a bad request is 400 and never reaches the IdP', async () => {
    assert.equal((await post({ username: 'no spaces', password: 'chosen-password-1' })).status, 400);
  });
});
