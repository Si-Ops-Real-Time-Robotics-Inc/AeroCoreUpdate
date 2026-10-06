import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { conflict, invalidParameter, upstreamUnavailable } from '../core/errors.js';

/**
 * Creating accounts in Keycloak from this server's admin UI.
 *
 * The account is a KEYCLOAK account, so it works on AeroCore and aerotunnel the moment it
 * exists — that is the whole point of putting identity in one place rather than giving
 * each service its own user table.
 *
 * The service account this uses must hold `manage-users` and NOTHING more. Never
 * `realm-admin`: this credential lives on the update server, and if it could also create
 * clients and grant roles then compromising this server would mean compromising Keycloak.
 *
 * No dependency — Node has global fetch.
 */

const TOKEN_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10_000;

let cached = null;   // { token, expiresAt }

export function keycloakAdminConfigured() {
  return Boolean(config.keycloakBaseUrl && config.keycloakRealm
                 && config.keycloakAdminClientId && config.keycloakAdminClientSecret);
}

const base = () => config.keycloakBaseUrl.replace(/\/+$/, '');

/**
 * A service-account token, cached until shortly before it expires.
 *
 * Every failure here is an UPSTREAM one — Keycloak unreachable, or refusing credentials this
 * server was configured with. Neither is a fault in this server, so neither may surface as a
 * 500: that reads as "file a bug" when the fix is one setting in a realm.
 *
 * The cause goes to the log and a bland sentence goes to the caller. On the self-service
 * registration path that caller is anonymous, and "check KEYCLOAK_ADMIN_CLIENT_SECRET" is an
 * instruction for an operator reading `docker compose logs`, not for whoever filled in a form.
 */
async function adminToken() {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  let res;
  try {
    res = await fetch(`${base()}/realms/${config.keycloakRealm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.keycloakAdminClientId,
        client_secret: config.keycloakAdminClientSecret,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error(`Keycloak is not reachable at ${base()}: ${err.message}`);
    throw upstreamUnavailable('The identity provider is not reachable right now');
  }

  if (!res.ok) {
    logger.error(
      `Keycloak refused the service account (HTTP ${res.status}) for client `
      + `"${config.keycloakAdminClientId}" in realm "${config.keycloakRealm}". Check that the `
      + 'client exists, has Client authentication ON, has its service account enabled, and '
      + 'that KEYCLOAK_ADMIN_CLIENT_SECRET matches the value under its Credentials tab.',
    );
    throw upstreamUnavailable('Account services are unavailable; please tell an administrator');
  }

  const body = await res.json();
  // Renew a minute early rather than discovering expiry mid-request.
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(30, (body.expires_in ?? 60) - 60) * 1000,
  };
  return cached.token;
}

async function adminCall(path, init = {}) {
  const token = await adminToken();
  return fetch(`${base()}/admin/realms/${config.keycloakRealm}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

/**
 * Grant a realm role to a freshly created user.
 *
 * Best effort by design: the account already exists by this point, and failing the whole
 * request would leave an account created but reported as an error — the worst of both. The
 * caller is told whether it worked so the operator can fix it rather than assume.
 *
 * Needs `view-realm` on the service account to look the role up, on top of `manage-users`.
 */
async function assignRealmRole(userId, roleName) {
  const lookup = await adminCall(`/roles/${encodeURIComponent(roleName)}`);
  if (!lookup.ok) {
    throw new Error(`realm role "${roleName}" does not exist (HTTP ${lookup.status}) — `
      + 'create it in Keycloak, or set KEYCLOAK_DEFAULT_ROLE to one that does');
  }
  const role = await lookup.json();

  const res = await adminCall(`/users/${userId}/role-mappings/realm`, {
    method: 'POST',
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`could not grant "${roleName}" (HTTP ${res.status})`
      + (detail ? `: ${detail.slice(0, 200)}` : ''));
  }
}

/**
 * Create a user with the default role.
 *
 * The default is `customer` — deliberately the LOWEST-privilege role, not a convenient one.
 * It grants nothing here: authenticateExternal requires OIDC_ADMIN_ROLE before a token opens
 * any admin route, so a `customer` account can sign in to Keycloak and reach nothing on this
 * server. That check is what makes the role model a boundary rather than a convention, and
 * it is what lets self-service registration exist at all.
 *
 * `temporary` is true when an ADMIN typed the password — they know it, so it must not stay
 * usable past first sign-in. Self-service registration passes false: the person choosing the
 * password is the only person who ever saw it, and forcing an immediate change of a secret
 * nobody else knows just teaches users to pick a throwaway one.
 */
export async function createUser({
  username, email, firstName, lastName, password, temporary = true,
}) {
  if (!keycloakAdminConfigured()) {
    throw invalidParameter('Keycloak admin API is not configured on this server '
      + '(KEYCLOAK_BASE_URL, KEYCLOAK_REALM, KEYCLOAK_ADMIN_CLIENT_ID, _SECRET)');
  }

  const body = {
    username,
    enabled: true,
    emailVerified: false,
    ...(email ? { email } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    credentials: [{ type: 'password', value: password, temporary }],
  };

  const res = await adminCall('/users', { method: 'POST', body: JSON.stringify(body) });

  if (res.status === 409) throw conflict(`A user named "${username}" already exists`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A 4xx is a verdict on what was submitted — "password policy not met" is exactly what
    // the person filling in the form needs to read. A 5xx is Keycloak having a bad day, and
    // relaying its internals to an anonymous caller helps nobody.
    if (res.status >= 500) {
      logger.error(`Keycloak failed to create ${username} (HTTP ${res.status})`
        + (detail ? `: ${detail.slice(0, 200)}` : ''));
      throw upstreamUnavailable('Account services are unavailable; please try again later');
    }
    throw invalidParameter(`Keycloak refused to create the user (HTTP ${res.status})`
      + (detail ? `: ${detail.slice(0, 200)}` : ''));
  }

  // 201 carries the new id only in Location; the body is empty.
  const id = (res.headers.get('location') ?? '').split('/').filter(Boolean).pop() ?? null;
  logger.info(`Created Keycloak user ${username} (${id})`);

  let role = config.keycloakDefaultRole;
  let roleError = null;
  if (role && id) {
    try {
      await assignRealmRole(id, role);
    } catch (err) {
      // Reported, not thrown: the account exists either way, and an operator needs to know
      // it is sitting there without the role rather than believe nothing happened.
      roleError = err.message;
      role = null;
      logger.warn(`Created ${username} but could not grant the default role: ${err.message}`);
    }
  }

  return { id, username, email: email ?? null, temporaryPassword: true, role, roleError };
}

export async function listUsers({ limit = 50, search = '' } = {}) {
  if (!keycloakAdminConfigured()) return [];
  const params = new URLSearchParams({ max: String(limit), briefRepresentation: 'true' });
  if (search) params.set('search', search);

  const res = await adminCall(`/users?${params}`);
  // Not a 400: nothing the caller sent is wrong. This one reaches the admin UI's Security tab
  // through a Promise.all, so a misleading status here breaks the whole panel.
  if (!res.ok) {
    logger.error(`Keycloak user list failed (HTTP ${res.status})`);
    throw upstreamUnavailable('The identity provider could not be queried');
  }
  const users = await res.json();
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email ?? null,
    enabled: Boolean(u.enabled),
    created_at: u.createdTimestamp ? new Date(u.createdTimestamp).toISOString() : null,
  }));
}

export function resetKeycloakAdminForTests() {
  cached = null;
}
