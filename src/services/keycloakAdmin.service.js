import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { conflict, invalidParameter } from '../core/errors.js';

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

/** A service-account token, cached until shortly before it expires. */
async function adminToken() {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`${base()}/realms/${config.keycloakRealm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.keycloakAdminClientId,
      client_secret: config.keycloakAdminClientSecret,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Keycloak refused the service account (HTTP ${res.status}). `
      + 'Check KEYCLOAK_ADMIN_CLIENT_ID / _SECRET and that the client has a service account.');
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
 * Create a user with a temporary password.
 *
 * NO ROLES are granted. The account can sign in and will see nothing until an admin gives
 * it one, and that is deliberate: this server's authorisation is still binary, so every
 * valid token is currently omnipotent — including for the route that points `stable` at a
 * release and thus ships firmware to the whole fleet. "Created and immediately usable"
 * would mean "anyone who can be created can ship firmware".
 */
export async function createUser({ username, email, firstName, lastName, password }) {
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
    credentials: [{ type: 'password', value: password, temporary: true }],
  };

  const res = await adminCall('/users', { method: 'POST', body: JSON.stringify(body) });

  if (res.status === 409) throw conflict(`A user named "${username}" already exists`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw invalidParameter(`Keycloak refused to create the user (HTTP ${res.status})`
      + (detail ? `: ${detail.slice(0, 200)}` : ''));
  }

  // 201 carries the new id only in Location; the body is empty.
  const id = (res.headers.get('location') ?? '').split('/').filter(Boolean).pop() ?? null;
  logger.info(`Created Keycloak user ${username} (${id})`);
  return { id, username, email: email ?? null, temporaryPassword: true };
}

export async function listUsers({ limit = 50, search = '' } = {}) {
  if (!keycloakAdminConfigured()) return [];
  const params = new URLSearchParams({ max: String(limit), briefRepresentation: 'true' });
  if (search) params.set('search', search);

  const res = await adminCall(`/users?${params}`);
  if (!res.ok) throw invalidParameter(`Keycloak user list failed (HTTP ${res.status})`);
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
