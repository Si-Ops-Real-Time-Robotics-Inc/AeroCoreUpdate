import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { API_KEY, SKIP_MESSAGE, hasDatabase, startServer } from './helpers/harness.js';

/**
 * FLEET_AUTH_MODE=jwt — the end state, in its own file because startServer() may only be
 * called once per process.
 *
 * This is a cutover: the moment it is on, a node that has not been given a token stops
 * updating. `both` exists so the fleet can be migrated before flipping it.
 */
describe('fleet auth: jwt only', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  const CHECK = '/api/v1/update/check'
    + '?serial=HRAF250028&platform=linux-x86_64&version=0.1.0&channel=stable&system=default';

  before(async () => { server = await startServer({ env: { FLEET_AUTH_MODE: 'jwt' } }); });
  after(async () => { await server?.close(); });

  test('a bearer token is accepted', async () => {
    const res = await server.request(CHECK, { headers: server.bearerHeaders() });
    assert.equal(res.status, 200);
  });

  test('the API key alone is refused', async () => {
    const res = await server.request(CHECK, { headers: { 'X-API-Key': API_KEY } });
    assert.equal(res.status, 401);
    assert.equal(res.json().error, 'invalid_api_key');
  });
});
