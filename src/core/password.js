import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/**
 * Password hashing with the built-in scrypt. Format:
 *   scrypt$<N>$<r>$<p>$<salt_b64>$<derived_b64>
 *
 * The cost parameters are read back FROM THE STORED STRING rather than from constants, so
 * raising them later does not invalidate existing hashes.
 */

const DEFAULTS = { N: 16384, r: 8, p: 1, keyLength: 32, saltLength: 16 };

export async function hash(password, options = {}) {
  const { N, r, p, keyLength, saltLength } = { ...DEFAULTS, ...options };
  const salt = crypto.randomBytes(saltLength);
  const derived = await scrypt(password, salt, keyLength, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verify(password, stored) {
  if (typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, derivedB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(derivedB64, 'base64');

  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * A hash of a random value, used to burn the same scrypt time when a username does not
 * exist. Without it the response time tells an attacker which usernames are real.
 */
export const DUMMY_HASH = await hash(crypto.randomBytes(32).toString('hex'));

export function randomPassword(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}
