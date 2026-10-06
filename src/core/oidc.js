import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Verification of JWTs issued by an EXTERNAL identity provider (Keycloak).
 *
 * Deliberately separate from core/jwt.js. That file mints and checks this server's own
 * HS256 tokens and rejects every other algorithm on purpose; these tokens are asymmetric,
 * signed by a key this server does not have and cannot forge. Two different trust models
 * have no business sharing one verifier.
 *
 * EdDSA (Ed25519) ONLY. Not a preference — an AeroCore node built for Android has no
 * OpenSSL (the NDK ships none), so RS256 is unverifiable there. Ed25519 is the one
 * algorithm every node in the fleet can check, because Crypto++ is linked unconditionally.
 *
 * No dependency: Node imports an OKP JWK directly and `crypto.verify` handles Ed25519.
 */

/** Tolerated clock difference between this server and the IdP, in seconds. */
const SKEW_SECONDS = 60;

/** Floor between JWKS fetches. An unknown `kid` triggers a refetch, so without this a
 *  stream of junk tokens would turn into a denial-of-service pointed at Keycloak. */
const MIN_REFETCH_MS = 60_000;

const FETCH_TIMEOUT_MS = 5_000;

let keys = new Map();        // kid -> crypto.KeyObject
let lastFetchAt = 0;
let diskLoaded = false;

export function oidcConfigured() {
  return Boolean(config.oidcIssuer && config.oidcJwksUri);
}

/**
 * Turn one JWKS entry into a usable key, or null when it is not something we verify with.
 * Encryption keys and RSA signing keys both land here and are both skipped — silently,
 * because a realm legitimately carries several and only the Ed25519 ones concern us.
 */
function jwkToKey(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null;
  if (jwk.use && jwk.use !== 'sig') return null;
  if (typeof jwk.kid !== 'string' || jwk.kid === '') return null;
  try {
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    logger.warn(`Ignoring malformed JWKS entry ${jwk.kid}: ${err.message}`);
    return null;
  }
}

function ingest(jwks) {
  const next = new Map();
  for (const jwk of jwks?.keys ?? []) {
    const key = jwkToKey(jwk);
    if (key) next.set(jwk.kid, key);
  }
  // Commit only when the document yields something usable. A realm that momentarily
  // serves an empty or RSA-only JWKS must not disarm a server that already holds good
  // keys — the same fail-closed rule the node applies to its own key file.
  if (next.size === 0) return 0;
  keys = next;
  return next.size;
}

async function readDiskCache() {
  if (!config.oidcJwksCacheFile) return null;
  try {
    return JSON.parse(await fsp.readFile(config.oidcJwksCacheFile, 'utf8'));
  } catch {
    return null;
  }
}

async function writeDiskCache(jwks) {
  if (!config.oidcJwksCacheFile) return;
  try {
    await fsp.mkdir(path.dirname(config.oidcJwksCacheFile), { recursive: true });
    await fsp.writeFile(config.oidcJwksCacheFile, JSON.stringify(jwks), { mode: 0o600 });
  } catch (err) {
    // A cache we cannot write is a slower start, not a failure.
    logger.warn(`Could not cache JWKS at ${config.oidcJwksCacheFile}: ${err.message}`);
  }
}

/** Fetch the JWKS. Returns the number of Ed25519 keys now held. */
async function refresh({ force = false } = {}) {
  if (!oidcConfigured()) return 0;
  const now = Date.now();
  if (!force && now - lastFetchAt < MIN_REFETCH_MS) return keys.size;
  lastFetchAt = now;

  const res = await fetch(config.oidcJwksUri, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`JWKS fetch returned HTTP ${res.status}`);
  const jwks = await res.json();

  const count = ingest(jwks);
  if (count > 0) await writeDiskCache(jwks);
  return count;
}

/**
 * Load keys at boot: disk cache first so a restart while the IdP is down still verifies,
 * then a live fetch to pick up a rotation. Neither failure is fatal — a server that cannot
 * reach Keycloak should still serve everything that does not need a Keycloak token.
 */
export async function initOidc() {
  if (!oidcConfigured()) return 0;

  const cached = await readDiskCache();
  if (cached) {
    diskLoaded = ingest(cached) > 0;
    if (diskLoaded) logger.info(`Loaded ${keys.size} cached OIDC signing key(s)`);
  }

  try {
    const count = await refresh({ force: true });
    if (count > 0) logger.info(`OIDC signing keys: ${count} Ed25519 key(s) from ${config.oidcJwksUri}`);
    else {
      logger.warn(
        `${config.oidcJwksUri} served no Ed25519 key. Keycloak realms ship RSA keys by `
        + 'default — add an EdDSA realm key and set the token signing algorithm to EdDSA, '
        + 'or no node will be able to verify a token.',
      );
    }
  } catch (err) {
    const level = diskLoaded ? 'warn' : 'error';
    logger[level](`Could not fetch JWKS from ${config.oidcJwksUri}: ${err.message}`
      + (diskLoaded ? ' — continuing with the cached keys' : ''));
  }
  return keys.size;
}

const decodeSegment = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

/**
 * The realm roles a token carries.
 *
 * Keycloak puts realm roles in `realm_access.roles` and client roles under `resource_access`.
 * Only realm roles are read, because that is also where KEYCLOAK_DEFAULT_ROLE puts `customer`
 * — one place to grant, one place to look. Both surfaces authorise from this one list, so
 * the claim is decoded in one place rather than once per middleware.
 *
 * A realm that emits no `realm_access` at all is the case worth knowing about: a client scope
 * named `roles` is what puts it in the token, and a realm trimmed to `basic`/`profile`/`email`
 * has none — every account then looks role-less no matter what was granted in Keycloak.
 */
export function realmRoles(claims) {
  const roles = claims?.realm_access?.roles;
  return Array.isArray(roles) ? roles : [];
}

/** `aud` is a string or an array; treat both the same way. */
function audienceMatches(claims, expected) {
  const aud = claims.aud;
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

/**
 * Verify an IdP-issued token and return its claims, or throw with a reason.
 *
 * Throws plain Errors, never HttpError: `core/` carries no domain knowledge (docs/c4.md),
 * so the caller decides what an authentication failure looks like on the wire.
 *
 * @param {string} token
 * @param {{audience: string}} opts  the audience THIS surface requires — an admin token
 *                                   must not be accepted on the fleet API or the reverse.
 */
export async function verifyExternal(token, { audience }) {
  if (!oidcConfigured()) throw new Error('OIDC is not configured');
  if (typeof token !== 'string') throw new Error('Token is not a string');
  if (!audience) throw new Error('No audience required by the caller');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header;
  try {
    header = decodeSegment(rawHeader);
  } catch {
    throw new Error('Malformed token header');
  }

  // The header is attacker-controlled, so `alg` is never trusted. Reject anything that is
  // not EdDSA — including "none" — BEFORE the signature is touched. Same rule as jwt.js.
  if (header.alg !== 'EdDSA') throw new Error(`Unsupported algorithm: ${header.alg}`);
  if (typeof header.kid !== 'string' || header.kid === '') throw new Error('Token has no kid');

  let key = keys.get(header.kid);
  if (!key) {
    // Unknown kid usually means a rotation, so one refetch is worth it. refresh() rate-limits
    // itself, and an unrecognised key after that is a rejection — never a fallback to trusting.
    try {
      await refresh();
    } catch (err) {
      logger.warn(`JWKS refresh while resolving kid ${header.kid} failed: ${err.message}`);
    }
    key = keys.get(header.kid);
    if (!key) throw new Error(`Unknown signing key: ${header.kid}`);
  }

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
  const signature = Buffer.from(rawSignature, 'base64url');
  if (signature.length !== 64 || !crypto.verify(null, signed, key, signature)) {
    throw new Error('Signature mismatch');
  }

  let claims;
  try {
    claims = decodeSegment(rawPayload);
  } catch {
    throw new Error('Malformed token payload');
  }

  if (claims.iss !== config.oidcIssuer) throw new Error('Wrong issuer');
  if (!audienceMatches(claims, audience)) {
    throw new Error(
      `Wrong audience: expected "${audience}". Keycloak omits it unless the client has an `
      + 'audience mapper — add one, or this token can never be used here.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS <= now) {
    throw new Error('Token expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > now) {
    throw new Error('Token not yet valid');
  }

  return claims;
}

export function resetOidcForTests() {
  keys = new Map();
  lastFetchAt = 0;
  diskLoaded = false;
}
