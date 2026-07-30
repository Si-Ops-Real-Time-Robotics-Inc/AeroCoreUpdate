import { query, withTransaction } from '../db/pool.js';

/** Admin accounts, refresh tokens and login attempts. Only this module touches those tables. */

export async function findUserByUsername(username) {
  const { rows } = await query(
    `SELECT id, username, password_hash, disabled, created_at, last_login_at, password_changed_at
     FROM admin_user WHERE username = $1`, [username],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(id) {
  const { rows } = await query(
    `SELECT id, username, password_hash, disabled, created_at, last_login_at, password_changed_at
     FROM admin_user WHERE id = $1`, [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function countUsers() {
  const { rows } = await query('SELECT count(*)::int AS n FROM admin_user');
  return rows[0].n;
}

export async function createUser(username, passwordHash) {
  const { rows } = await query(
    'INSERT INTO admin_user (username, password_hash) VALUES ($1, $2) RETURNING id',
    [username, passwordHash],
  );
  return Number(rows[0].id);
}

export async function updatePassword(userId, passwordHash) {
  await query(
    'UPDATE admin_user SET password_hash = $2, password_changed_at = now() WHERE id = $1',
    [userId, passwordHash],
  );
}

export async function markLogin(userId) {
  await query('UPDATE admin_user SET last_login_at = now() WHERE id = $1', [userId]);
}

// ── refresh tokens ────────────────────────────────────────────────────────────────────────

export async function insertRefreshToken({ jti, userId, tokenHash, family, expiresAt, userAgent, ip }) {
  await query(
    `INSERT INTO refresh_token (jti, user_id, token_hash, family, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [jti, userId, tokenHash, family, expiresAt, userAgent ?? null, ip ?? null],
  );
}

export async function findRefreshToken(jti) {
  const { rows } = await query(
    `SELECT jti, user_id, token_hash, family, issued_at, expires_at, revoked_at
     FROM refresh_token WHERE jti = $1`, [jti],
  );
  if (!rows[0]) return null;
  return {
    jti: rows[0].jti,
    userId: Number(rows[0].user_id),
    tokenHash: rows[0].token_hash,
    family: rows[0].family,
    issuedAt: rows[0].issued_at,
    expiresAt: rows[0].expires_at,
    revokedAt: rows[0].revoked_at,
  };
}

export async function revokeToken(jti) {
  await query('UPDATE refresh_token SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL',
    [jti]);
}

/**
 * Revoke an entire token family. Used when a already-revoked token is presented: that means
 * the token was captured, so both the attacker and the legitimate holder are cut off at the
 * next use rather than the attacker enjoying the full refresh lifetime.
 */
export async function revokeFamily(family) {
  const { rowCount } = await query(
    'UPDATE refresh_token SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL',
    [family],
  );
  return rowCount;
}

export async function revokeAllForUser(userId, { exceptJti = null } = {}) {
  const { rowCount } = await query(
    `UPDATE refresh_token SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR jti <> $2)`,
    [userId, exceptJti],
  );
  return rowCount;
}

/** Rotate atomically so a concurrent double-refresh cannot mint two live tokens. */
export function rotateRefreshToken(oldJti, next) {
  return withTransaction(async (client) => {
    await client.query('UPDATE refresh_token SET revoked_at = now() WHERE jti = $1', [oldJti]);
    await client.query(
      `INSERT INTO refresh_token (jti, user_id, token_hash, family, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [next.jti, next.userId, next.tokenHash, next.family, next.expiresAt,
        next.userAgent ?? null, next.ip ?? null],
    );
  });
}

export async function pruneExpiredTokens() {
  const { rowCount } = await query(
    "DELETE FROM refresh_token WHERE expires_at < now() - interval '30 days'",
  );
  return rowCount;
}

// ── login attempts ────────────────────────────────────────────────────────────────────────

export async function recordLoginAttempt(username, ip, success) {
  await query('INSERT INTO login_attempt (username, ip, success) VALUES ($1, $2, $3)',
    [username ?? null, ip ?? null, success]);
}

/** Failures since the window opened, counted separately per username and per IP. */
export async function countRecentFailures(username, ip, windowMinutes) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE username = $1) AS by_user,
       count(*) FILTER (WHERE ip = $2)       AS by_ip
     FROM login_attempt
     WHERE success = false AND at > now() - ($3 || ' minutes')::interval`,
    [username ?? null, ip ?? null, String(windowMinutes)],
  );
  return { byUser: Number(rows[0].by_user), byIp: Number(rows[0].by_ip) };
}

export async function pruneLoginAttempts(days = 30) {
  const { rowCount } = await query(
    "DELETE FROM login_attempt WHERE at < now() - ($1 || ' days')::interval", [String(days)],
  );
  return rowCount;
}

function mapUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    disabled: row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at,
  };
}
