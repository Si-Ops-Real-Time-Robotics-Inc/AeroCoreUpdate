import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';

import { SKIP_MESSAGE, fleetHeaders, hasDatabase, signIn, startServer } from './helpers/harness.js';

/**
 * The listener speaks HTTP/2, and still speaks HTTP/1.1.
 *
 * `allowHTTP1` is not a nicety. The node's update client is httplib, which is HTTP/1.1 only —
 * an h2-exclusive listener would take the whole fleet offline the moment it started, and every
 * device would report a connection failure rather than anything diagnosable. So the property
 * worth pinning is not "h2 works", it is "h2 works AND h1 still does".
 */
describe('HTTP/2', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer();
    session = await signIn(server);
  });

  after(async () => { await server?.close(); });

  /** One request over a real h2 connection, returning the status, headers and body. */
  const h2 = (path, headers = {}) => new Promise((resolve, reject) => {
    const client = http2.connect(`https://localhost:${server.port}`, {
      ca: server.certText, servername: 'localhost',
    });
    client.on('error', reject);

    const req = client.request({ ':path': path, ':method': 'GET', ...headers });
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { req.headers = h; });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      client.close();
      resolve({ status: req.headers[':status'], headers: req.headers, body });
    });
    req.on('error', (err) => { client.close(); reject(err); });
    req.end();
  });

  test('a fleet endpoint answers over HTTP/2', async () => {
    const res = await h2('/api/v1/health');

    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  test('and the same endpoint still answers over HTTP/1.1', async () => {
    // The whole reason allowHTTP1 is on: this is the fleet's only protocol.
    const res = await server.request('/api/v1/health', { headers: fleetHeaders() });

    assert.equal(res.status, 200);
    assert.equal(res.json().ok, true);
  });

  test('the admin API works over HTTP/2 with its bearer token', async () => {
    // Browsers negotiate h2, so this is the path the UI actually takes.
    const res = await h2('/admin/api/catalog', {
      authorization: `Bearer ${session.token}`,
      'x-requested-with': 'fetch',
      cookie: session.cookie,
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(JSON.parse(res.body).systems));
  });

  test('the request URL survives the h2 header mapping', async () => {
    // HTTP/2 has no `host` header — the authority lives in `:authority`, and a server reading
    // the wrong one builds a broken URL on exactly half its connections.
    const res = await h2('/api/v1/update/check?system=default&serial=SN-H2&platform=plan9-vax&version=1.0.0', {
      'x-api-key': 'test-fleet-key-0123456789',
    });

    // The point is that the query was parsed at all: a mangled URL would 404 on the route
    // instead of reaching the validator.
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_parameter');
  });

  test('the browser hardening headers are present over HTTP/2 too', async () => {
    const res = await h2('/admin/api/catalog', {
      authorization: `Bearer ${session.token}`,
      'x-requested-with': 'fetch',
      cookie: session.cookie,
    });

    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });
});
