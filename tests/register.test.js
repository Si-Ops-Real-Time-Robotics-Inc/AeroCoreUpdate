import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_MESSAGE, hasDatabase, startServer } from './helpers/harness.js';

/**
 * Self-service sign-up from the login page (ALLOW_SELF_REGISTRATION=1).
 *
 * Keycloak is not stood up for the suite, so what is pinned here is everything that does not
 * need it: the endpoint is reachable without a credential, it validates before reaching out,
 * it refuses rather than half-creating when the realm is not wired up, and the rate-limit
 * ledger counts what it is supposed to.
 *
 * config/index.js reads process.env once, at first import, so one file gets one configuration
 * — the DISABLED case lives in users.test.js instead.
 */
describe('self-service registration', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  const post = (body) => server.request('/admin/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => { server = await startServer({ env: { ALLOW_SELF_REGISTRATION: '1' } }); });
  after(async () => { await server?.close(); });

  test('the endpoint needs no credential to reach', async () => {
    // Anything but 401 proves the route is not behind requireAuth; the specific refusal below
    // is what this deployment happens to answer.
    const res = await post({ username: 'newcomer', password: 'chosen-password-1' });
    assert.notEqual(res.status, 401);
  });

  test('the probe reports unavailable while Keycloak admin is not configured', async () => {
    const res = await server.request('/admin/api/auth/registration');
    assert.equal(res.status, 200);
    // The flag alone is not enough — accounts live in Keycloak, so the login page must not
    // draw a form that cannot possibly work.
    assert.equal(res.json().enabled, false);
  });

  test('a valid request refuses rather than half-creating', async () => {
    const res = await post({ username: 'newcomer', email: 'a@b.co', password: 'chosen-password-1' });
    assert.equal(res.status, 400);
    assert.match(res.json().message, /Keycloak admin API/i);
  });

  // Validation runs before Keycloak is contacted, so these answer the same either way.
  test('a malformed username is rejected', async () => {
    assert.equal((await post({ username: 'no spaces', password: 'chosen-password-1' })).status, 400);
  });

  test('a short password is rejected', async () => {
    assert.equal((await post({ username: 'newcomer', password: 'short' })).status, 400);
  });

  test('a missing username is rejected', async () => {
    const res = await post({ password: 'chosen-password-1' });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'missing_parameter');
  });

  /**
   * The rate-limit ledger. Exercised directly because the endpoint cannot get far enough to
   * write to it without a realm — but the counting is the part that has to be right, since it
   * is all that stands between an open form and a filled realm.
   */
  test('registration attempts are counted per address, inside the window', async () => {
    const repo = await import('../src/repositories/auth.repository.js');

    assert.equal(await repo.countRecentRegistrations('10.0.0.1', 60), 0);

    await repo.recordRegistrationAttempt('10.0.0.1', 'one');
    await repo.recordRegistrationAttempt('10.0.0.1', 'two');
    await repo.recordRegistrationAttempt('10.0.0.2', 'elsewhere');

    assert.equal(await repo.countRecentRegistrations('10.0.0.1', 60), 2);
    // Scoped to the address, or one busy client would lock out everyone else.
    assert.equal(await repo.countRecentRegistrations('10.0.0.2', 60), 1);
    // And to the window: a ceiling that never forgets is a permanent ban.
    assert.equal(await repo.countRecentRegistrations('10.0.0.1', 0), 0);
  });

  /**
   * An address this server could not read must still be limited. `ip = NULL` is never true in
   * SQL, so a plain `=` would count nothing and rate-limit nothing.
   */
  test('an unreadable address is still counted', async () => {
    const repo = await import('../src/repositories/auth.repository.js');

    const before = await repo.countRecentRegistrations(null, 60);
    await repo.recordRegistrationAttempt(null, 'anonymous');
    assert.equal(await repo.countRecentRegistrations(null, 60), before + 1);
  });
});
