import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import * as jwt from '../core/jwt.js';
import { DUMMY_HASH, hash, randomPassword, verify as verifyPassword } from '../core/password.js';
import { forbidden, rateLimited, unauthorized } from '../core/errors.js';
import * as repository from '../repositories/auth.repository.js';
import { insertAudit } from '../repositories/audit.repository.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Create the first admin account if there is none. A blank ADMIN_PASSWORD produces a random
 * one printed once — there is never a default admin/admin.
 */
export async function bootstrapAdmin() {
  if (await repository.countUsers() > 0) return null;

  const username = config.adminUsername;
  const password = config.adminPassword || randomPassword();
  await repository.createUser(username, await hash(password));

  if (config.adminPassword) {
    logger.info(`Created the first admin account "${username}" from ADMIN_PASSWORD`);
  } else {
    logger.warn('='.repeat(72));
    logger.warn(`Created the first admin account "${username}"`);
    logger.warn(`Generated password: ${password}`);
    logger.warn('This is shown once. Change it after signing in.');
    logger.warn('='.repeat(72));
  }
  return username;
}

export async function login({ username, password, ip, userAgent }) {
  const window = config.loginWindowMinutes;
  const failures = await repository.countRecentFailures(username, ip, window);
  if (failures.byUser >= config.loginMaxFailuresPerUser
      || failures.byIp >= config.loginMaxFailuresPerIp) {
    throw rateLimited(window * 60);
  }

  const user = await repository.findUserByUsername(username);

  // Always run scrypt, even for an unknown username: otherwise the response time reveals
  // which usernames exist.
  const stored = user && !user.disabled ? user.passwordHash : DUMMY_HASH;
  const ok = await verifyPassword(password, stored);

  if (!user || user.disabled || !ok) {
    await repository.recordLoginAttempt(username, ip, false);
    // One message for both cases, so a wrong username is indistinguishable from a wrong
    // password.
    throw unauthorized('Invalid credentials');
  }

  await repository.recordLoginAttempt(username, ip, true);
  await repository.markLogin(user.id);
  await insertAudit({ actor: user.username, action: 'auth.login', subject: username, detail: { ip } });

  const family = crypto.randomUUID();
  return issueTokens(user, { family, ip, userAgent });
}

/**
 * Rotate a refresh token. Presenting one that is already revoked means it was captured, so
 * the whole family dies — the attacker and the real user are both cut off immediately.
 */
export async function refresh({ token, ip, userAgent }) {
  const parsed = parseRefreshToken(token);
  if (!parsed) throw unauthorized('Invalid refresh token');

  const record = await repository.findRefreshToken(parsed.jti);
  if (!record) throw unauthorized('Invalid refresh token');

  const presented = Buffer.from(sha256(parsed.secret), 'hex');
  const expected = Buffer.from(record.tokenHash, 'hex');
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    throw unauthorized('Invalid refresh token');
  }

  if (record.revokedAt) {
    const revoked = await repository.revokeFamily(record.family);
    await insertAudit({
      actor: null,
      action: 'auth.refresh_reuse',
      subject: String(record.userId),
      detail: { family: record.family, revoked, ip },
    });
    logger.warn(`refresh token reuse detected for user ${record.userId}; revoked ${revoked} tokens`);
    throw unauthorized('Refresh token was already used');
  }

  if (new Date(record.expiresAt) <= new Date()) throw unauthorized('Refresh token expired');

  const user = await repository.findUserById(record.userId);
  if (!user) throw unauthorized('Account no longer exists');
  if (user.disabled) throw forbidden('Account is disabled');

  return issueTokens(user, { family: record.family, ip, userAgent, rotateFrom: record.jti });
}

export async function logout(token) {
  const parsed = parseRefreshToken(token);
  if (parsed) await repository.revokeToken(parsed.jti);
}

export async function logoutAll(userId) {
  return repository.revokeAllForUser(userId);
}

export async function changePassword({ user, currentPassword, newPassword, keepJti }) {
  if (!await verifyPassword(currentPassword, user.passwordHash)) {
    throw unauthorized('Current password is incorrect');
  }
  await repository.updatePassword(user.id, await hash(newPassword));
  const revoked = await repository.revokeAllForUser(user.id, { exceptJti: keepJti ?? null });
  await insertAudit({
    actor: user.username, action: 'auth.password_change', subject: user.username, detail: { revoked },
  });
  return revoked;
}

/** Verify an access token and re-check the account, so a disabled user loses access at once. */
export async function authenticate(accessToken) {
  let claims;
  try {
    claims = jwt.verify(accessToken, config.jwtSecret);
  } catch (err) {
    throw unauthorized(err.message);
  }

  const user = await getUserCached(Number(claims.sub));
  if (!user) throw unauthorized('Account no longer exists');
  if (user.disabled) throw forbidden('Account is disabled');

  // A password change invalidates tokens minted before it.
  if (claims.iat * 1000 < new Date(user.passwordChangedAt).getTime() - 1000) {
    throw unauthorized('Token predates the last password change');
  }
  return user;
}

async function issueTokens(user, { family, ip, userAgent, rotateFrom = null }) {
  const accessToken = jwt.sign(
    { sub: String(user.id), usr: user.username },
    { secret: config.jwtSecret, ttlSeconds: config.accessTtlSeconds },
  );

  const jti = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);
  const record = {
    jti, userId: user.id, tokenHash: sha256(secret), family, expiresAt, userAgent, ip,
  };

  if (rotateFrom) await repository.rotateRefreshToken(rotateFrom, record);
  else await repository.insertRefreshToken(record);

  return {
    accessToken,
    refreshToken: `${jti}.${secret}`,
    expiresIn: config.accessTtlSeconds,
    user: { id: user.id, username: user.username },
  };
}

function parseRefreshToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;

  const jti = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(jti) || !secret) return null;
  return { jti, secret };
}

// A short cache keeps the per-request account check off the hot path while still catching a
// freshly disabled account within seconds.
const userCache = new Map();
const USER_CACHE_MS = 30_000;

async function getUserCached(id) {
  const hit = userCache.get(id);
  if (hit && hit.at > Date.now() - USER_CACHE_MS) return hit.user;

  const user = await repository.findUserById(id);
  userCache.set(id, { user, at: Date.now() });
  return user;
}

export function clearUserCache() {
  userCache.clear();
}
