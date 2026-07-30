import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

import {
  API_KEY, SKIP_MESSAGE, fleetHeaders, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

describe('health, TLS, errors and signing', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server?.close(); });

  test('section 12: health needs no auth and pins its shape', async () => {
    const res = await server.request('/api/v1/health');

    assert.equal(res.status, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'service', 'time']);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'aerocore-update-server');
    assert.match(body.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('every fleet endpoint refuses a missing or wrong API key', async () => {
    const endpoints = [
      ['GET', '/api/v1/update/check?serial=S&platform=linux-x86_64&version=0.1.0'],
      ['GET', '/api/v1/update/download/0.15.0?platform=linux-x86_64'],
      ['POST', '/api/v1/update/report'],
    ];

    for (const [method, pathname] of endpoints) {
      for (const headers of [{}, { 'X-API-Key': '' }, { 'X-API-Key': 'wrong' }]) {
        const res = await server.request(pathname, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: method === 'POST' ? '{}' : undefined,
        });
        assert.equal(res.status, 401, `${method} ${pathname} ${JSON.stringify(headers)}`);

        const body = res.json();
        assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
        assert.equal(body.error, 'invalid_api_key');
      }
    }
  });

  test('the error envelope is exactly {error, message} with a documented code', async () => {
    const CODES = new Set([
      'missing_parameter', 'invalid_parameter', 'invalid_api_key', 'not_found',
      'range_not_satisfiable', 'rate_limited', 'server_error', 'maintenance',
    ]);

    const cases = [
      ['GET', '/api/v1/nope', {}],
      ['GET', '/api/v1/update/check', fleetHeaders()],
      ['POST', '/api/v1/health', {}],
      ['GET', '/api/v1/update/download/9.9.9?platform=linux-x86_64', fleetHeaders()],
    ];

    for (const [method, pathname, headers] of cases) {
      const res = await server.request(pathname, { method, headers });
      assert.ok(res.status >= 400, `${method} ${pathname}`);

      const body = res.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'message'], `${method} ${pathname}`);
      assert.ok(CODES.has(body.error), `${body.error} is not a documented code`);
    }
  });

  test('a wrong method on a real path is 405 with Allow', async () => {
    const res = await server.request('/api/v1/health', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  });

  test('an invalid JSON body is a 400, not a 500', async () => {
    const res = await server.request('/api/v1/update/report', {
      method: 'POST',
      headers: fleetHeaders({ 'Content-Type': 'application/json' }),
      body: '{oops',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'invalid_parameter');
  });

  test('reports are accepted, including partial ones', async () => {
    const full = await server.request('/api/v1/update/report', {
      method: 'POST',
      headers: fleetHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        serial: 'SN-42', platform: 'linux-x86_64', role: 'GCS',
        from_version: '0.13.3', to_version: '0.15.0', result: 'success',
        error: '', at: '2026-07-28T09:12:00Z',
      }),
    });
    assert.equal(full.status, 200);
    assert.deepEqual(full.json(), { ok: true });

    // The OpenAPI declares no 400 for /report, so an odd shape must still be accepted.
    const partial = await server.request('/api/v1/update/report', {
      method: 'POST',
      headers: fleetHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ result: 'failed', unexpected: { nested: true } }),
    });
    assert.equal(partial.status, 200);
  });

  test('the public key the server publishes matches the raw SPKI bytes', async () => {
    const session = await signIn(server);
    const key = (await session.api('/admin/api/signing-key')).json();

    assert.equal(key.algorithm, 'ed25519');
    const raw = Buffer.from(key.public_key_base64, 'base64');
    assert.equal(raw.length, 32, 'a node stores the raw 32 bytes');

    // The same key, imported the way a node would, must be usable for verification.
    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    assert.ok(raw.equals(spki.subarray(-32)));
  });

  test('the signing key survives a reload — a node keeps trusting it', async () => {
    const first = await fsp.readFile(server.dir + '/ota-signing.key', 'utf8');
    const { loadOrCreateKeyPair } = await import('../src/repositories/signingKey.repository.js');

    const again = await loadOrCreateKeyPair(server.dir + '/ota-signing.key');
    assert.equal(again.generated, false);
    assert.equal(await fsp.readFile(server.dir + '/ota-signing.key', 'utf8'), first);

    const stat = await fsp.stat(server.dir + '/ota-signing.key');
    assert.equal(stat.mode & 0o777, 0o600, 'the private key must not be world-readable');
  });

  test('TLS is reported to the admin UI with what a node must trust', async () => {
    const session = await signIn(server);
    const tls = (await session.api('/admin/api/tls')).json();

    assert.equal(tls.enabled, true);
    assert.equal(tls.selfSigned, true, 'the test certificate is self-signed');
    assert.match(tls.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.match(tls.subjectAltName, /DNS:localhost/);
    assert.match(tls.subjectAltName, /IP Address:127\.0\.0\.1/);
  });

  test('admin responses carry the browser hardening headers', async () => {
    const session = await signIn(server);
    const res = await session.api('/admin/api/catalog');

    // NOT HSTS: this server's certificate is self-signed, and a browser that records an HSTS
    // policy behind one removes the "Proceed anyway" button for a year — locking the operator
    // out of the UI with no way back except clearing it by hand in chrome://net-internals.
    // The header is sent only behind a certificate the browser already trusts.
    assert.equal(res.headers['strict-transport-security'], undefined);

    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  });

  test('the fleet API carries no HSTS — a node is not a browser', async () => {
    const res = await server.request(
      '/api/v1/update/check?serial=S&platform=linux-x86_64&version=0.1.0',
      { headers: { 'X-API-Key': API_KEY } },
    );
    assert.equal(res.headers['strict-transport-security'], undefined);
  });

  test('the admin UI is served as static files', async () => {
    const index = await server.request('/admin/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);

    const login = await server.request('/admin/login.html');
    assert.equal(login.status, 200);

    // Static serving must not reach outside public/.
    const escape = await server.request('/admin/../../package.json');
    assert.ok([400, 404].includes(escape.status));
  });
});
