import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_MESSAGE, bundle, hasDatabase, publish, setChannel, signIn, startServer,
} from './helpers/harness.js';

/**
 * OIDC_FLEET_ROLE — authorisation on the fleet API, on top of the audience.
 *
 * Its own file because startServer() may be called once per process, and the setting has to
 * be in place before config/index.js is first imported.
 *
 * The case this exists for: one Keycloak realm serves several products, so every account in
 * it can ask for a fleet-audience token — including accounts this server creates itself and,
 * with ALLOW_SELF_REGISTRATION on, anyone who fills in the form. The audience proves which
 * surface a token was minted for and says nothing about entitlement.
 */
let server;
const FLEET_ROLE = 'aerocore-fleet';

before(async () => {
  server = await startServer({
    env: { FLEET_AUTH_MODE: 'jwt', OIDC_FLEET_ROLE: FLEET_ROLE },
  });
  const session = await signIn(server);
  for (const version of ['0.15.0', '0.16.0']) {
    await publish(session, {
      version,
      platform: 'linux-x86_64',
      body: bundle({ version, cores: [{ platform: 'linux-x86_64' }] }),
    });
  }
  // Two channels, pointing at different builds: the whole question is which of them a
  // given credential may pull.
  await setChannel(session, 'stable', { latest: '0.15.0' });
  await setChannel(session, 'beta', { latest: '0.16.0' });
});

after(async () => { await server?.close(); });

describe('fleet auth: realm role', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  const CHECK = '/api/v1/update/check'
    + '?serial=HRAF250028&platform=linux-x86_64&version=0.1.0&channel=stable&system=default';


  test('a token holding the role is accepted', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ roles: [FLEET_ROLE] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, true);
  });

  // The whole point: this token is valid, correctly signed, and minted for exactly this
  // surface. Only the entitlement is missing.
  test('a valid fleet token without the role is refused', async () => {
    const res = await server.request(CHECK, { headers: server.bearerHeaders() });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'invalid_api_key');
    assert.match(res.json().message, new RegExp(FLEET_ROLE));
  });

  // `customer` is what a self-registered account gets, and what this server grants to the
  // accounts it creates. It must not be a fleet credential by accident.
  test('an unrelated role does not open the fleet API', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ roles: ['customer'] }),
    });
    assert.equal(res.status, 403);
  });

  // 401 before 403: an unauthenticated caller must not learn which role would have worked.
  test('a bad signature is still refused as authentication, not authorisation', async () => {
    const res = await server.request(CHECK, {
      headers: server.bearerHeaders({ roles: [FLEET_ROLE], stranger: true }),
    });
    assert.equal(res.status, 401);
  });

  test('the download route is gated too, not only the check', async () => {
    const res = await server.request('/api/v1/update/download/0.15.0?platform=linux-x86_64', {
      headers: server.bearerHeaders(),
    });
    assert.equal(res.status, 403);
  });
});

// ── restricted to one channel ─────────────────────────────────────────────────────────────

/**
 * A lesser role that may pull, but only what `stable` currently serves.
 *
 * The point is not distrust of a person: it is that an aircraft following stable has no
 * business fetching a beta image, and a credential that cannot ask for one cannot be talked
 * into it by a mistyped line in a node's config.
 */
describe('fleet auth: a credential limited to stable', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  const STABLE_ROLE = 'aerocore-fleet-stable';   // the config default
  const check = (channel, roles) => server.request(
    `/api/v1/update/check?system=default&serial=HRAF250028&platform=linux-x86_64&version=0.1.0`
    + `&channel=${channel}&system=default`,
    { headers: server.bearerHeaders({ roles }) },
  );
  const download = (version, roles) => server.request(
    `/api/v1/update/download/${version}?platform=linux-x86_64&system=default`,
    { headers: server.bearerHeaders({ roles }) },
  );

  test('it may check the channel it serves', async () => {
    assert.equal((await check('stable', [STABLE_ROLE])).status, 200);
  });

  test('it may not check another channel', async () => {
    const res = await check('beta', [STABLE_ROLE]);

    assert.equal(res.status, 403);
    assert.match(res.json().message, /follows stable only/);
  });

  test('it may download what stable points at', async () => {
    assert.equal((await download('0.15.0', [STABLE_ROLE])).status, 200);
  });

  /** By version number, which is the way around the check endpoint. */
  test('it may not download the beta build even by asking for it directly', async () => {
    const res = await download('0.16.0', [STABLE_ROLE]);

    assert.equal(res.status, 403);
    assert.match(res.json().message, /serves stable only/);
  });

  test('the full role is not restricted by any of this', async () => {
    assert.equal((await check('beta', [FLEET_ROLE])).status, 200);
    assert.equal((await download('0.16.0', [FLEET_ROLE])).status, 200);
  });

  /** Holding both is a superset, not a conflict. */
  test('holding both roles behaves as the full one', async () => {
    assert.equal((await check('beta', [FLEET_ROLE, STABLE_ROLE])).status, 200);
    assert.equal((await download('0.16.0', [STABLE_ROLE, FLEET_ROLE])).status, 200);
  });
});
