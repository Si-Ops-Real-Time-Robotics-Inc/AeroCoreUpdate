import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Constitution I (2.0.0): this server holds no credential that opens itself.
 *
 * Asserted against the source rather than the loaded config, because a key that
 * is only read when a feature flag is on would not appear in a loaded object —
 * and reintroducing one quietly is exactly the failure this guards.
 */
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('config exposes no key that could be a credential for this server', () => {
  const source = read('../src/config/index.js');
  const keys = [...source.matchAll(/^\s{2}([a-zA-Z]\w*):/gm)].map((m) => m[1]);

  const banned = keys.filter((k) => /^(jwtSecret|adminPassword|adminUsername)$/.test(k));
  assert.deepEqual(banned, [], `config still exposes ${banned.join(', ')}`);
});

test('no environment variable named for a local sign-in is read anywhere', () => {
  const source = [...['../src/config/index.js', '../src/server.js'].map(read)].join('\n');
  for (const name of ['JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_USERNAME',
                      'LOGIN_MAX_FAILURES_USER', 'LOGIN_MAX_FAILURES_IP', 'LOGIN_WINDOW_MINUTES']) {
    assert.equal(source.includes(name), false, `${name} is read again`);
  }
});

test('the password-signing module is gone, not merely unused', () => {
  // Deleted rather than left in place: an HS256 signer sitting in core/ is an
  // invitation to mint a session, which is the thing that was removed.
  for (const path of ['../src/core/jwt.js', '../src/core/password.js']) {
    assert.throws(() => read(path), /ENOENT/, `${path} still exists`);
  }
});

test('no route accepts a username and password', () => {
  const routes = read('../src/routes/admin.routes.js');
  for (const gone of ["'/api/auth/login'", "'/api/auth/password'", "'/api/auth/logout-all'"]) {
    assert.equal(routes.includes(gone), false, `${gone} is registered again`);
  }
});
