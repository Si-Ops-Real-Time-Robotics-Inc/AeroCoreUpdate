/**
 * What a signed-in principal may do, as scopes rather than a yes/no.
 *
 * `requireAuth` answers "is this a valid token?" and nothing more, which made all 36 admin
 * routes one permission: reading the fleet inventory and shipping firmware to every aircraft
 * in it were the same right. The split that matters is UPLOADING from PUBLISHING — an
 * uploaded artifact sits in the catalog and no node ever sees it, while pointing a channel at
 * a release is what reaches the fleet. Everything else here is refinement of that one line.
 *
 * Scope names are the vocabulary of docs/rbac-proposal.md, so the design and the code can be
 * read against each other.
 */
export const SCOPE = Object.freeze({
  /** Anything about one's own session: whoami, sign out, change password. */
  SELF: 'self',
  CATALOG_READ: 'catalog:read',
  /** Add to the catalog. Emphatically NOT the same as serving it to anyone. */
  ARTIFACT_WRITE: 'artifact:write',
  /** Move a channel: the one action that reaches the fleet. */
  CHANNEL_WRITE: 'channel:write',
  CATALOG_DELETE: 'catalog:delete',
  SYSTEM_WRITE: 'system:write',
  USER_ADMIN: 'user:admin',
  /** Reading a credential this server holds — the OTA signing key, the fleet API keys. */
  SIGNING_KEY: 'signing_key',
});

const ALL = Object.freeze(Object.values(SCOPE));

/**
 * The scopes each role carries.
 *
 * A publisher may fill the catalog and may not point a channel at any of it, which is the
 * entire point: a leaked publisher token adds a file nobody is served instead of shipping
 * firmware to every aircraft. Promotion stays with the admin who reviews it.
 */
const ROLE_SCOPES = {
  admin: ALL,
  publisher: [SCOPE.SELF, SCOPE.CATALOG_READ, SCOPE.ARTIFACT_WRITE],
  viewer: [SCOPE.SELF, SCOPE.CATALOG_READ],
};

/**
 * Map the realm roles a Keycloak token carries onto scopes.
 *
 * An unknown role contributes nothing rather than raising: a realm shared with other products
 * is full of roles that mean nothing here, and `customer` — what this server grants every
 * account it creates — must map to the empty set. An empty result is what the caller turns
 * into "this account may not use the admin API at all".
 *
 * @param {string[]} roles      realm roles from the token
 * @param {object} named        the role NAME for each level, from config; empty disables one
 */
export function scopesForRoles(roles, { admin, publisher, viewer }) {
  const held = new Set(Array.isArray(roles) ? roles : []);
  const scopes = new Set();

  for (const [level, name] of Object.entries({ admin, publisher, viewer })) {
    if (name && held.has(name)) ROLE_SCOPES[level].forEach((scope) => scopes.add(scope));
  }
  return scopes;
}

/**
 * May an upload point this channel at what it just uploaded?
 *
 * Uploading fills the catalog and reaches nobody; pointing a channel at a release is what
 * reaches an aircraft. The one-shot upload can do both in a single request, so the second
 * right has to be checked here or `artifact:write` quietly becomes both.
 *
 * `stagingChannel` MUST be the caller's `config.stagingChannel` — the literal 'beta' — and
 * never `config.autoPromoteChannel`. The two hold the same value by default and are not the
 * same thing: autoPromoteChannel is read from AUTO_PROMOTE_CHANNEL, so a rule anchored on it
 * would let `AUTO_PROMOTE_CHANNEL=stable` hand every publisher the fleet, through
 * configuration, with nothing in this file looking wrong.
 *
 * Landing on the staging channel needs no extra right: it is where an ordinary upload goes,
 * an engineer getting a build in front of the test group is most of what the role is for, and
 * an admin still has to promote it from there. Landing nowhere reaches nobody by definition.
 *
 * @param {string|null} channel        the channel asked for, or null for "nowhere"
 * @param {Set<string>} scopes         the caller's scopes
 * @param {string} stagingChannel      config.stagingChannel — see above
 */
export function mayLandOnChannel({ channel, scopes, stagingChannel }) {
  if (channel === null) return true;
  if (channel === stagingChannel) return true;
  return Boolean(scopes?.has(SCOPE.CHANNEL_WRITE));
}
