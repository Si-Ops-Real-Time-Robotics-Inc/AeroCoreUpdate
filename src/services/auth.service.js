import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { oidcConfigured, realmRoles, verifyExternal } from '../core/oidc.js';
import { scopesForRoles } from '../domain/scopes.js';
import { forbidden, invalidParameter, rateLimited, unauthorized } from '../core/errors.js';
import * as repository from '../repositories/auth.repository.js';
import { insertAudit } from '../repositories/audit.repository.js';
import { createUser as createKeycloakUser, keycloakAdminConfigured }
  from './keycloakAdmin.service.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');


/**
 * Self-service account creation, from the sign-in page, with no credential at all.
 *
 * Safe only because of the role check in authenticateExternal. The account is created with
 * KEYCLOAK_DEFAULT_ROLE and the role is never read from the request, so this endpoint cannot
 * mint an admin — but that is a property of `customer` granting nothing, which is true only
 * while OIDC_ADMIN_ROLE is enforced. Do not remove one without removing the other.
 *
 * The account is a KEYCLOAK account, so it signs in to AeroCore and aerotunnel too. That is
 * why this is off by default and why every attempt is audited with its address.
 */
export async function register({ input, ip }) {
  if (!config.allowSelfRegistration) {
    throw forbidden('Self-service registration is disabled on this server');
  }
  if (!keycloakAdminConfigured()) {
    throw invalidParameter(
      'Self-service registration needs the Keycloak admin API (KEYCLOAK_ADMIN_CLIENT_ID, '
      + '_SECRET), because accounts live in Keycloak rather than in this server',
    );
  }

  const window = config.registerWindowMinutes;
  if (await repository.countRecentRegistrations(ip, window) >= config.registerMaxPerIp) {
    throw rateLimited(window * 60);
  }
  // Recorded before the call, not after: Keycloak may take up to ten seconds, and a burst of
  // concurrent requests would otherwise all clear the ceiling above before any was counted.
  await repository.recordRegistrationAttempt(ip, input.username);

  const created = await createKeycloakUser({ ...input, temporary: false });

  await insertAudit({
    actor: null,
    action: 'user.register',
    subject: created.username,
    // Never the password, not even its length — same rule as the admin-created path.
    detail: { email: created.email, role: created.role, ip, self_service: true },
  });
  logger.info(`self-service registration: ${created.username} from ${ip ?? '(no address)'}`);

  return created;
}

export function selfRegistrationAvailable() {
  return config.allowSelfRegistration && keycloakAdminConfigured();
}

/** Cheap shape test: does this token claim to be EdDSA-signed? Used only to decide whether a
 *  verification failure is worth reporting or worth falling through on. */
function looksExternal(token) {
  try {
    const [rawHeader] = String(token).split('.');
    return JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')).alg === 'EdDSA';
  } catch {
    return false;
  }
}

/**
 * Whether a token was minted before this account's sessions were cut.
 *
 * Scopes ride inside the token, so a role removed in Keycloak reaches this server only when
 * the holder's current token expires — fifteen minutes, and nothing here can see the change
 * to react to it sooner. Cutting stamps a moment; every token older than it is refused.
 *
 * The second of slack is the same allowance the password check makes: `iat` has one-second
 * resolution, so a token minted in the same second as the cut must not be judged by which
 * side of a rounding boundary it happened to land on.
 */
function predatesCut(user, claims) {
  if (!user?.permissionsChangedAt) return false;
  return claims.iat * 1000 < new Date(user.permissionsChangedAt).getTime() - 1000;
}

/**
 * Authenticate a Keycloak token, mapping it onto a local admin row.
 *
 * Tried before the local path, and the two cannot be confused: this one demands EdDSA and
 * the configured issuer, while a locally-minted token is HS256 with `iss: aerocoreupdate`, so
 * each is rejected outright by the other's verifier. That is what keeps the documented
 * fleet/admin credential isolation intact with both paths live.
 *
 * @returns the user row, or null when this is not an external token at all — so the caller
 *          falls back rather than treating it as a failure.
 */
async function authenticateExternal(accessToken) {
  if (!oidcConfigured()) return null;

  let claims;
  try {
    claims = await verifyExternal(accessToken, { audience: config.oidcAudienceAdmin });
  } catch (err) {
    // A token that IS from this issuer but is bad — expired, wrong audience, tampered —
    // fails here rather than falling through to be re-judged as a local token, which would
    // report a thoroughly misleading reason.
    if (looksExternal(accessToken)) throw unauthorized(err.message);
    return null;
  }

  // Authorisation, not authentication. A verified token proves only that Keycloak knows this
  // account; the audience proves only which surface it was minted for. Neither says the
  // account may point `stable` at a release and ship firmware to the fleet.
  //
  // Checked BEFORE the upsert on purpose: an unauthorised sign-in must not leave a local
  // admin_user row behind, or the audit trail fills with accounts that were never admitted.
  const scopes = scopesForRoles(realmRoles(claims), {
    admin: config.oidcAdminRole,
    publisher: config.oidcPublisherRole,
    viewer: config.oidcViewerRole,
  });
  if (scopes.size === 0) {
    const known = [config.oidcAdminRole, config.oidcPublisherRole, config.oidcViewerRole]
      .filter(Boolean).map((role) => `"${role}"`).join(', ');
    throw forbidden(
      `This account holds none of the realm roles this server recognises (${known}), so no `
      + 'part of the admin API is open to it. An administrator must grant one in Keycloak; '
      + 'there is no other way in to this server.',
    );
  }

  // Checked before the upsert for the same reason the role is: a sign-in that is refused has
  // not happened, and must not move last_login_at as though it had.
  if (predatesCut(await repository.findExternalUser(claims.iss, claims.sub), claims)) {
    throw unauthorized(
      'This token was minted before an administrator cut this account\'s sessions. Sign in '
      + 'again to pick up the permissions it has now.',
    );
  }

  const user = await repository.upsertExternalUser({
    issuer: claims.iss,
    subject: claims.sub,
    username: claims.preferred_username || claims.sub,
  });
  if (user.disabled) throw forbidden('Account is disabled');
  // Scopes ride on the request, not in the database: they are re-derived from the token on
  // every call, so revoking a role in Keycloak takes effect at that account's next token
  // rather than needing a row edited here.
  return { ...user, scopes };
}

/**
 * Refuse every credential an account currently holds.
 *
 * The case this exists for: someone's role is removed in Keycloak and the removal has to
 * take effect NOW rather than whenever their token happens to expire. It is not itself a
 * demotion — Keycloak owns the roles — so it is the second half of one, and useless without
 * the first: cutting alone just makes the holder sign in again and get the same token back.
 *
 * @returns {Promise<number|null>} refresh tokens revoked, or null when no such account
 */
export async function cutSessions(username) {
  return repository.cutSessions(username);
}

/**
 * Verify an access token and re-check the account, so a disabled user loses access at once.
 *
 * One source of identity. Until 2026-09-10 this fell through to a locally-issued HS256 token
 * when the realm did not recognise the credential; that account is gone, so a token this
 * realm does not know is simply not a credential here.
 */
export async function authenticate(accessToken) {
  const external = await authenticateExternal(accessToken);
  if (external) return external;
  throw unauthorized('Not a token this server accepts');
}

