import { query, withTransaction } from '../db/pool.js';

/**
 * The local row standing in for an externally-authenticated user, created on first sign-in.
 *
 * Everything here refers to an admin by the integer `admin_user.id` — audit actors,
 * artifact uploaded_by. Keycloak's `sub` is a UUID, so rather than rewrite all of that, an
 * external identity gets a local row keyed to its subject.
 *
 * There is no password column any more (migration 010): an account here cannot be signed in
 * to except by presenting a token the realm issued, which is the whole point.
 */
export async function upsertExternalUser({ issuer, subject, username }) {
  const { rows } = await query(
    `INSERT INTO admin_user (username, external_id, external_issuer)
     VALUES ($1, $2, $3)
     ON CONFLICT (external_issuer, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET username = EXCLUDED.username, last_login_at = now()
     RETURNING id, username, disabled, created_at, last_login_at, permissions_changed_at`,
    [username, subject, issuer],
  );
  return mapUser(rows[0]);
}

/**
 * The local row for an external subject, WITHOUT creating one.
 *
 * upsertExternalUser() is the usual entry point, but it also stamps last_login_at — and a
 * sign-in that is about to be refused has not happened. Reading first keeps the refusal from
 * writing anything at all, the same reason the role check runs before the upsert.
 */
export async function findExternalUser(issuer, subject) {
  const { rows } = await query(
    `SELECT id, username, disabled, created_at, last_login_at, permissions_changed_at
     FROM admin_user WHERE external_issuer = $1 AND external_id = $2`, [issuer, subject],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Refuse every credential this account already holds.
 *
 * One stamp is now the whole mechanism: every token verification compares against this
 * column, so a token minted before it is refused. Before migration 010 this also revoked
 * locally-issued refresh tokens, because one of those could mint a fresh access token a
 * second later and walk past the stamp — this server issues none now.
 *
 * @returns true when the account exists, false when there is no such account
 */
export async function cutSessions(username) {
  const { rowCount } = await query(
    'UPDATE admin_user SET permissions_changed_at = now() WHERE username = $1',
    [username],
  );
  return rowCount > 0;
}

// ── self-service registration ─────────────────────────────────────────────────────────────

/** Counted before the account is created, so a burst cannot outrun the ceiling. */
export async function recordRegistrationAttempt(ip, username) {
  await query('INSERT INTO registration_attempt (ip, username) VALUES ($1, $2)',
    [ip ?? null, username ?? null]);
}

/**
 * Attempts from one address inside the window.
 *
 * `IS NOT DISTINCT FROM` rather than `=`, because `null = null` is NULL in SQL: an address
 * this server could not read would otherwise match no rows and be rate-limited not at all.
 */
export async function countRecentRegistrations(ip, windowMinutes) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM registration_attempt
     WHERE ip IS NOT DISTINCT FROM $1 AND at > now() - ($2 || ' minutes')::interval`,
    [ip ?? null, String(windowMinutes)],
  );
  return rows[0].n;
}

export async function pruneRegistrationAttempts(days = 30) {
  const { rowCount } = await query(
    "DELETE FROM registration_attempt WHERE at < now() - ($1 || ' days')::interval",
    [String(days)],
  );
  return rowCount;
}

function mapUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    disabled: row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    // NULL until an administrator cuts this account's sessions; see migration 009.
    permissionsChangedAt: row.permissions_changed_at,
  };
}
