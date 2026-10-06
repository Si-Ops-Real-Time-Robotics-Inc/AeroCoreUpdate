import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { bundle } from './bundles.js';

export { bundle, legacyBundle } from './bundles.js';

const run = promisify(execFile);

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
export const hasDatabase = Boolean(TEST_DATABASE_URL);

export const SKIP_MESSAGE =
  'TEST_DATABASE_URL is not set — integration tests need a PostgreSQL instance. '
  + 'Run `npm run test:docker`, or start Postgres and set TEST_DATABASE_URL.';

export const API_KEY = 'test-fleet-key-0123456789';
export const ADMIN_USER = 'testadmin';
export const ADMIN_PASSWORD = 'test-admin-password-123';

/**
 * Boot the real server on an ephemeral port with real TLS.
 *
 * Tests speak HTTPS because the product does: checking cookie flags, the 426 gate and the
 * certificate over plaintext would verify none of them.
 *
 * Call this ONCE per test file. config/index.js reads process.env when it is first imported,
 * so a second call in the same process would silently reuse the first call's settings — and
 * `node --test` already gives every file its own process.
 */
export async function startServer({ env = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerocoreupdate-test-'));
  const schema = `test_${crypto.randomBytes(6).toString('hex')}`;
  const tls = await selfSigned(dir);

  // A stand-in identity provider: one Ed25519 key, served as a JWKS. Started before the
  // dynamic imports below because config/index.js freezes process.env on first import, so
  // OIDC_JWKS_URI has to know its port by then.
  const idp = await startFakeIdp();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: withSchema(TEST_DATABASE_URL, schema),
    ARTIFACTS_DIR: path.join(dir, 'artifacts'),
    SIGNING_KEY_FILE: path.join(dir, 'ota-signing.key'),
    // Every suite gets a fresh temp dir with no key in it, which is exactly the case
    // SIGNING_KEY_AUTOGEN exists for. A real deployment leaves it off so a missing key
    // fails the boot instead of silently minting a replacement the fleet cannot verify.
    SIGNING_KEY_AUTOGEN: '1',
    TLS_CERT_FILE: tls.certPath,
    TLS_KEY_FILE: tls.keyPath,
    JWT_SECRET: 'test-jwt-secret',
    UPDATE_API_KEYS: `test-fleet:${API_KEY}`,
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD,
    // Pinned, not inherited. The product default is `beta` — a fresh upload lands on the
    // staging channel — but a suite that inherited it would have its channels rearranged by
    // every publish() call, and would silently change meaning the day the default changes.
    // Suites that exercise auto-promotion set it themselves (publish-auto.test.js).
    AUTO_PROMOTE_CHANNEL: '',
    STRICT_PLATFORMS: '1',
    SLIM_FALLBACK_TO_FLEET: '1',
    MAINTENANCE: '0',
    ALLOW_PLAINTEXT_HTTP: '0',
    OIDC_ISSUER: idp.issuer,
    OIDC_JWKS_URI: idp.jwksUri,
    // The address the SERVER dials, as opposed to the issuer a token claims. Identical here,
    // but they are separate settings because a split-horizon deployment makes them differ —
    // and the browser sign-in reads this one to find the token endpoint.
    KEYCLOAK_BASE_URL: idp.base,
    KEYCLOAK_REALM: idp.realm,
    OIDC_AUDIENCE_ADMIN: OIDC_AUDIENCE_ADMIN,
    OIDC_AUDIENCE_FLEET: OIDC_AUDIENCE_FLEET,
    OIDC_JWKS_CACHE_FILE: path.join(dir, 'jwks-cache.json'),
    // Suites that exercise the bearer path set this themselves; the default keeps every
    // existing fleet test on the API key it was written against.
    FLEET_AUTH_MODE: 'apikey',
    ...env,
  });

  // Dynamic import: a static one would evaluate config/index.js before the env above is set.
  const { getPool, closePool } = await import('../../src/db/pool.js');
  await getPool().query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

  const { migrate } = await import('../../src/db/migrate.js');
  await migrate();

  const { initSigning, getPublicKeyBase64 } = await import('../../src/services/signing.service.js');
  await initSigning();

  const { initOidc } = await import('../../src/core/oidc.js');
  await initOidc();

  // Mirror the boot sequence in server.js: the admin UI reads the certificate description
  // from here rather than re-reading the key material on every request.
  const { loadTlsContext } = await import('../../src/core/tls.js');
  const { setTlsInfo } = await import('../../src/services/tlsInfo.service.js');
  setTlsInfo({ enabled: true, ...await loadTlsContext() });

  const { createApp } = await import('../../src/app.js');
  const app = createApp();

  // The same listener the product runs: HTTP/2 with the HTTP/1.1 fallback on. Testing over
  // plain https would leave the protocol every browser actually negotiates unexercised.
  const server = http2.createSecureServer(
    { cert: tls.cert, key: tls.key, allowHTTP1: true }, app,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Optional plaintext listener, for the escape-hatch tests.
  let plainServer = null;
  let plainPort = null;
  if (process.env.ALLOW_PLAINTEXT_HTTP === '1') {
    plainServer = http.createServer(app);
    await new Promise((resolve) => plainServer.listen(0, '127.0.0.1', resolve));
    plainPort = plainServer.address().port;
  }

  const options = { ca: tls.cert, servername: 'localhost' };

  return {
    port,
    plainPort,
    dir,
    schema,
    publicKey: getPublicKeyBase64(),
    certPath: tls.certPath,
    // The PEM itself, so a test can open its own TLS connection — an http2 client needs the
    // CA in hand, and re-reading the file in every suite would be the same fact twice.
    certText: tls.cert,
    keyPath: tls.keyPath,

    /** HTTPS request against the server, verifying the certificate we just generated. */
    request: (pathname, init = {}) => doRequest(https, {
      host: 'localhost', port, path: pathname, ...options,
    }, init),

    /** Plaintext request, only usable when ALLOW_PLAINTEXT_HTTP is on. */
    plainRequest: (pathname, init = {}) => doRequest(http, {
      host: '127.0.0.1', port: plainPort, path: pathname,
    }, init),

    /** Mint a token the way the stand-in IdP would. Defaults produce a valid fleet token. */
    token: (overrides = {}) => idp.mint(overrides),

    /** The stand-in IdP, for suites that drive the browser sign-in flow. */
    idp: {
      setTokenHandler: idp.setTokenHandler,
      setWellKnownStatus: idp.setWellKnownStatus,
      issuer: idp.issuer,
    },

    /** Headers for a bearer-authenticated fleet request, mirroring fleetHeaders(). */
    bearerHeaders: (overrides = {}, extra = {}) => ({
      Authorization: `Bearer ${idp.mint(overrides)}`,
      ...extra,
    }),

    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (plainServer) await new Promise((resolve) => plainServer.close(resolve));
      await idp.close();
      await getPool().query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await closePool();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

export const OIDC_AUDIENCE_ADMIN = 'aeroserver-admin';
export const OIDC_AUDIENCE_FLEET = 'aerocore';
/** The realm role authenticateExternal demands before any admin route opens. */
export const OIDC_ADMIN_ROLE = 'aeroserver-admin';

const b64u = (input) => Buffer.from(input).toString('base64url');

/**
 * A minimal Ed25519 identity provider: a JWKS endpoint and a token minter.
 *
 * Real enough to prove the contract — the server fetches the JWKS over HTTP exactly as it
 * would from Keycloak, and `mint` produces a genuinely signed EdDSA JWT. Every field is
 * overridable so a test can forge the specific thing it wants rejected.
 */
async function startFakeIdp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const kid = 'test-ed25519';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' };

  // A second key the server is never told about, for the unknown-kid case.
  const strangerKey = crypto.generateKeyPairSync('ed25519').privateKey;

  /**
   * What the token endpoint answers. Replaceable, because the browser sign-in has to be
   * testable when Keycloak refuses as well as when it agrees — a rejected refresh is the
   * ordinary end of a session, not an edge case.
   */
  let tokenHandler = (params) => [200, {
    access_token: mint({ aud: OIDC_AUDIENCE_ADMIN, roles: [OIDC_ADMIN_ROLE] }),
    // Rotated the way Keycloak rotates it, so a test can catch a cookie that was not updated.
    refresh_token: `refresh-after-${params.grant_type}`,
    expires_in: 300,
    token_type: 'Bearer',
  }];

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    res.end(payload);
  };

  // What the server probes to decide whether Keycloak is answering at all. The status is
  // settable so a suite can take the IdP "down" without stopping it.
  let wellKnownStatus = 200;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/jwks')) {
      json(res, 200, { keys: [jwk] });
      return;
    }

    if (req.url.endsWith('/.well-known/openid-configuration')) {
      if (wellKnownStatus !== 200) {
        res.writeHead(wellKnownStatus).end();
        return;
      }
      json(res, 200, {
        issuer,
        jwks_uri: `http://127.0.0.1:${port}/jwks`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
      });
      return;
    }

    // The two endpoints the server itself calls: it dials Keycloak's real URL layout, so the
    // stand-in has to answer at the same paths.
    if (req.url.endsWith('/protocol/openid-connect/token')
        || req.url.endsWith('/protocol/openid-connect/logout')) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (req.url.endsWith('/logout')) {
          res.writeHead(204).end();
          return;
        }
        const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        const [status, body] = tokenHandler(params);
        json(res, status, body);
      });
      return;
    }

    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const issuer = `http://127.0.0.1:${port}/realms/test`;

  function mint({
    alg = 'EdDSA',
    kid: overrideKid = kid,
    iss = issuer,
    aud = OIDC_AUDIENCE_FLEET,
    sub = 'a3f1c2d4-0000-4000-8000-000000000001',
    username = 'testuser',
    expiresIn = 300,
    // How long ago the token was minted. Zero is the ordinary case; a test that needs a token
    // demonstrably OLDER than something that happened a moment ago sets it, because `iat` has
    // one-second resolution and "just now" is not reliably before "just now".
    issuedAgo = 0,
    notBefore = null,
    signWith = privateKey,
    stranger = false,
    roles = [],
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss, aud, sub, preferred_username: username, iat: now - issuedAgo, exp: now + expiresIn,
    };
    if (notBefore !== null) claims.nbf = now + notBefore;
    // Empty by default so a test has to ASK for authorisation. Keycloak emits realm roles
    // here, and a token carrying none is the ordinary `customer` case.
    if (roles.length) claims.realm_access = { roles };

    const head = `${b64u(JSON.stringify({ alg, typ: 'JWT', kid: overrideKid }))}`
      + `.${b64u(JSON.stringify(claims))}`;
    // `alg: none` carries no signature at all — the shape an attacker sends.
    if (alg === 'none') return `${head}.`;
    const signature = crypto.sign(null, Buffer.from(head), stranger ? strangerKey : signWith);
    return `${head}.${signature.toString('base64url')}`;
  }

  return {
    issuer,
    // What KEYCLOAK_BASE_URL and KEYCLOAK_REALM would name; the issuer is built from the two.
    base: `http://127.0.0.1:${port}`,
    realm: 'test',
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    setTokenHandler: (fn) => { tokenHandler = fn; },
    setWellKnownStatus: (code) => { wellKnownStatus = code; },
    mint,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * One request. Returns the status, headers, raw body and lazy json()/text() so a test can
 * assert on binary payloads and on headers like Content-Range without extra plumbing.
 */
function doRequest(mod, target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = mod.request({ method, ...target, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: res.headers['set-cookie'] ?? [],
          buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Sign in and return helpers carrying the access token and the refresh cookie. */
/**
 * An authenticated admin session.
 *
 * Since feature 002 there is no local password to present, so this mints a token
 * from the stand-in identity provider instead — the same shape Keycloak issues:
 * EdDSA, the admin audience, and a realm role that maps to every scope.
 *
 * `cookie` and `setCookieRaw` are kept as empty values rather than removed, so
 * the eighteen suites that destructure this object keep working. Nothing reads
 * them any more: the session cookie only ever bought an access token, and here
 * the token is minted directly.
 */
export async function signIn(server, username = ADMIN_USER, roles = [OIDC_ADMIN_ROLE]) {
  const token = server.token({
    aud: OIDC_AUDIENCE_ADMIN,
    roles,
    // `username`, not `preferred_username`: mint() builds the claim from this option name.
    // Passing the claim name instead is silently ignored, which leaves every session token
    // carrying mint's default username under this test's subject — two subjects claiming one
    // username, which admin_user_username_key refuses.
    username,
    sub: `test-${username}`,
  });

  const api = (pathname, init = {}) => server.request(pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Requested-With': 'fetch',
      ...(init.body !== undefined && !init.headers?.['Content-Type']
        ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  return { token, cookie: '', setCookieRaw: [], user: { username }, api };
}

export function fleetHeaders(extra = {}) {
  return { 'X-API-Key': API_KEY, ...extra };
}

/**
 * Deterministic pseudo-binary content. NOT a gzip and NOT a tar, so it is usable only on the
 * paths that reject before inspection (empty body, oversize, sha256 mismatch) — and as the
 * fixture for the not_gzip rule itself. Everywhere else use bundle() from ./bundles.js.
 *
 * It is also the right filler for size-sensitive tests: the bytes do not compress, so a
 * bundle padded with them keeps the .tar.gz size the test asked for.
 */
export function fakeArtifact(size, seed = 7) {
  const buffer = Buffer.alloc(size);
  // Math.imul, not `*`: state * 1103515245 exceeds 2^53 and silently loses precision as a
  // double, which degenerates the sequence. And the HIGH byte, not the low one — the low bits
  // of an LCG barely change, so `state & 0xff` produced runs of zeros that gzip crushed to
  // 4% of their size. Both bugs made this compressible, which quietly broke every test that
  // asks for a bundle of a given size; the Range test that depended on it had never run.
  let state = seed | 0;
  for (let i = 0; i < size; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) | 0;
    buffer[i] = (state >>> 16) & 0xff;
  }
  return buffer;
}

export const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Create a release (if needed) and upload one artifact through the real admin endpoints.
 *
 * `body` defaults to a real bundle covering the requested platforms, because the server now
 * opens the archive. Pass an explicit body to exercise a malformed one.
 */
export async function publish(session, {
  version, kind = 'slim', platform = 'linux-x86_64', platforms, body, plugins, configs,
  minVersion = null, notes = null, mandatory = false, publishedAt = '2026-07-28T00:00:00Z',
  query: extraQuery, system,
}) {
  const covered = platforms ?? [platform];
  const payload = body ?? bundle({
    version,
    cores: covered.map((p) => ({ platform: p })),
    plugins,
    configs,
    release: system ? { system } : undefined,
  });

  const catalogRes = await session.api('/admin/api/catalog');
  const catalog = catalogRes.json();

  // A release belongs to a system, and systems are created by an admin — never invented from
  // a bundle — so a fixture that names one has to create it first.
  if (system && !catalog.systems.some((entry) => entry.name === system)) {
    const res = await session.api('/admin/api/systems', {
      method: 'POST', body: JSON.stringify({ name: system }),
    });
    if (res.status !== 201) throw new Error(`create system failed: ${res.status} ${res.text()}`);
  }

  // The upload auto-creates a release, but tests usually want the metadata set too. A release
  // is (system, version), so it lives under its system — the same number may exist in another.
  const target = system ?? 'default';
  if (!catalog.releases.some((release) => release.system === target && release.version === version)) {
    const res = await session.api(`/admin/api/systems/${target}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        version, min_version: minVersion, notes, mandatory, published_at: publishedAt,
      }),
    });
    if (res.status !== 201) throw new Error(`create release failed: ${res.status} ${res.text()}`);
  }

  const query = extraQuery ?? (kind === 'fleet' && covered.length === 1 ? 'kind=fleet' : '');

  const res = await session.api(
    `/admin/api/systems/${target}/releases/${version}/artifacts${query ? `?${query}` : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-Expected-Sha256': sha256Hex(payload) },
      body: payload,
    },
  );
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${res.text()}`);
  return res.json();
}

export async function setChannel(session, name, changes, system = 'default') {
  const res = await session.api(`/admin/api/systems/${system}/channels/${name}`, {
    method: 'PUT', body: JSON.stringify(changes),
  });
  if (res.status !== 200) throw new Error(`channel update failed: ${res.status} ${res.text()}`);
  return res.json();
}

export async function setMetadata(session, artifactId, metadata) {
  const res = await session.api(`/admin/api/artifacts/${artifactId}/metadata`, {
    method: 'PUT', body: JSON.stringify(metadata),
  });
  if (res.status !== 200) throw new Error(`metadata failed: ${res.status} ${res.text()}`);
  return res.json();
}

async function selfSigned(dir) {
  const certPath = path.join(dir, 'server.crt');
  const keyPath = path.join(dir, 'server.key');
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  return {
    certPath,
    keyPath,
    cert: await fsp.readFile(certPath, 'utf8'),
    key: await fsp.readFile(keyPath, 'utf8'),
  };
}

/** Point the connection at a throwaway schema so test files can run in parallel. */
function withSchema(url, schema) {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}
