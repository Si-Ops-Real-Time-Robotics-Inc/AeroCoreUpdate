import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  OIDC_AUDIENCE_ADMIN, SKIP_MESSAGE, bundle, fleetHeaders, hasDatabase, publish,
  setChannel, signIn, startServer,
} from './helpers/harness.js';

/**
 * Fleet authentication by Keycloak bearer token.
 *
 * The credential a node presents is being moved from a shared X-API-Key to a per-user JWT.
 * `both` is the state the fleet migrates through, so it gets the most attention here: the
 * point of that mode is that neither credential stops working while nodes are converted.
 */
describe('fleet auth: bearer tokens', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  const CHECK = '/api/v1/update/check'
    + '?serial=HRAF250028&platform=linux-x86_64&version=0.1.0&channel=stable&system=default';

  before(async () => {
    server = await startServer({ env: { FLEET_AUTH_MODE: 'both' } });
    const session = await signIn(server);
    await publish(session, {
      version: '0.15.0',
      platform: 'linux-x86_64',
      body: bundle({ version: '0.15.0', cores: [{ platform: 'linux-x86_64' }] }),
    });
    await setChannel(session, 'stable', { latest: '0.15.0' });
  });

  after(async () => { await server?.close(); });

  test('a valid bearer token is accepted', async () => {
    const res = await server.request(CHECK, { headers: server.bearerHeaders() });
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, true);
  });

  test('in `both`, the API key still works', async () => {
    const res = await server.request(CHECK, { headers: fleetHeaders() });
    assert.equal(res.status, 200);
  });

  test('no credential at all is refused', async () => {
    const res = await server.request(CHECK);
    assert.equal(res.status, 401);
    assert.equal(res.json().error, 'invalid_api_key');
  });

  // The header is attacker-controlled. Both of these must fail before the signature is
  // examined at all, which is why they are the first thing the verifier checks.
  test('alg: none is refused', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ alg: 'none' }),
    });
    assert.equal(res.status, 401);
  });

  test('a token signed by an unknown key is refused', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ stranger: true }),
    });
    assert.equal(res.status, 401);
  });

  test('an unknown kid is refused rather than tried against every key', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ kid: 'no-such-key' }),
    });
    assert.equal(res.status, 401);
  });

  test('the wrong issuer is refused', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ iss: 'https://evil.example/realms/test' }),
    });
    assert.equal(res.status, 401);
  });

  // The whole point of per-surface audiences: a token minted to administer the server must
  // not also be a fleet credential.
  test('an admin-audience token is refused on the fleet API', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ aud: OIDC_AUDIENCE_ADMIN }),
    });
    assert.equal(res.status, 401);
  });

  test('an expired token is refused', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ expiresIn: -3600 }),
    });
    assert.equal(res.status, 401);
  });

  test('a not-yet-valid token is refused', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ notBefore: 3600 }),
    });
    assert.equal(res.status, 401);
  });

  test('a garbage bearer value is refused without throwing', async () => {
    const res = await server.request(CHECK, { headers: { Authorization: 'Bearer not.a.jwt' } });
    assert.equal(res.status, 401);
  });
});

// FLEET_AUTH_MODE=jwt lives in fleet-jwt-only.test.js: startServer() may be called only
// once per file, because config/index.js freezes process.env on first import and a second
// call would quietly run under this file's `both`.
