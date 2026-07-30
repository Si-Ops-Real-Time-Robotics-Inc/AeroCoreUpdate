import crypto from 'node:crypto';

/**
 * Minimal HS256 JWT. No dependency: createHmac plus base64url is the whole algorithm.
 *
 * The one rule that matters: the `alg` in the token header is attacker-controlled, so it is
 * never trusted. Anything other than HS256 — including "none" — is rejected outright.
 */

const ISSUER = 'aeroserver';
const AUDIENCE = 'admin';

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

export function sign(claims, { secret, ttlSeconds }) {
  if (!secret) throw new Error('JWT secret is not configured');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
  };

  const head = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  return `${head}.${hmac(head, secret).toString('base64url')}`;
}

/** Returns the claims, or throws with a reason. Never returns partially-verified data. */
export function verify(token, secret) {
  if (typeof token !== 'string') throw new Error('Token is not a string');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const [rawHeader, rawPayload, rawSignature] = parts;

  let header;
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed token header');
  }

  // Reject "none" and every algorithm we did not issue, before touching the signature.
  if (header.alg !== 'HS256') throw new Error(`Unsupported algorithm: ${header.alg}`);

  const expected = hmac(`${rawHeader}.${rawPayload}`, secret);
  const actual = Buffer.from(rawSignature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Signature mismatch');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed token payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error('Wrong issuer');
  if (claims.aud !== AUDIENCE) throw new Error('Wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('Token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now) throw new Error('Token not yet valid');

  return claims;
}
