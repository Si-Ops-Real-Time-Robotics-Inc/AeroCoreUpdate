import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_MESSAGE, fleetHeaders, hasDatabase, startServer } from './helpers/harness.js';

/**
 * The escape hatch. HTTPS-only is the default, but spec section 10 says the node has no TLS
 * backend, so ALLOW_PLAINTEXT_HTTP exists to keep a fleet running while the core catches up.
 * It must serve the fleet API and nothing else.
 */
describe('ALLOW_PLAINTEXT_HTTP', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  before(async () => {
    server = await startServer({ env: { ALLOW_PLAINTEXT_HTTP: '1' } });
  });
  after(async () => { await server?.close(); });

  test('the fleet API answers over plaintext', async () => {
    const res = await server.plainRequest('/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.json().ok, true);

    const check = await server.plainRequest(
      '/api/v1/update/check?system=default&serial=S&platform=linux-x86_64&version=0.1.0',
      { headers: fleetHeaders() },
    );
    assert.equal(check.status, 200);
  });

  test('the admin surface refuses plaintext with 426', async () => {
    for (const pathname of ['/admin/api/catalog', '/admin/api/auth/me', '/admin/']) {
      const res = await server.plainRequest(pathname, { method: 'GET' });
      assert.equal(res.status, 426, pathname);
      assert.match(res.headers.upgrade, /TLS/);
      assert.equal(res.json().error, 'invalid_parameter');
    }
  });

  test('the same paths work over TLS', async () => {
    const res = await server.request('/admin/');
    assert.equal(res.status, 200);
  });
});
