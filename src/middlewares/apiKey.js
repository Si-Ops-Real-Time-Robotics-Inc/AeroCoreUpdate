import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { forbidden, invalidApiKey } from '../core/errors.js';
import { oidcConfigured, realmRoles, verifyExternal } from '../core/oidc.js';

/**
 * Fleet authentication for /api/v1/*.
 *
 * Applied as a decorator at route-registration time rather than as a pipeline middleware:
 * Router.use() only accepts a Router, and a path allowlist would duplicate route knowledge
 * and turn every unknown /api/v1 path into a 401 instead of a 404. Leaving /api/v1/health
 * unwrapped is the whole implementation of its section 12 exemption, visible right where a
 * reader looks.
 *
 * Two credentials are accepted, selected by FLEET_AUTH_MODE:
 *
 *   apikey  the shared X-API-Key, as it has always been
 *   both    a Keycloak bearer token, falling back to the API key
 *   jwt     a Keycloak bearer token only
 *
 * `both` exists because replacing the credential is a fleet-wide cutover: a node that has
 * not been given a token yet must keep updating, or the switch strands everything at once.
 *
 * A bearer token then faces a second question, which the API key never had to answer: not
 * "is this credential valid" but "may whoever holds it pull firmware". OIDC_FLEET_ROLE is
 * that check — off by default, and worth reading verifyFleetToken for before turning on.
 */
export function requireFleetAuth(handler) {
  return async (req, res) => {
    const identity = await verifyFleet(req);
    req.fleet = identity.name;
    // null means every channel. A list means only those — set from the token's realm roles,
    // so which builds a credential may pull is decided in Keycloak, not in a device's config.
    req.fleetChannels = identity.channels;
    return handler(req, res);
  };
}

/** Kept under the old name so existing route files and their intent read unchanged. */
export { requireFleetAuth as requireApiKey };

async function verifyFleet(req) {
  const mode = config.fleetAuthMode;
  const header = req.headers.authorization;
  const hasBearer = typeof header === 'string' && header.startsWith('Bearer ');

  if (mode === 'jwt' || (mode === 'both' && hasBearer)) {
    if (!hasBearer) throw invalidApiKey('Authorization: Bearer <token> is required');
    return verifyFleetToken(header.slice(7).trim());
  }

  if (mode !== 'apikey' && mode !== 'both') {
    // A typo here would silently pick a mode nobody intended, and the safe direction is not
    // obvious enough to guess: refusing is.
    throw invalidApiKey(`FLEET_AUTH_MODE is "${mode}" — expected apikey, both or jwt`);
  }
  return verifyApiKey(req);
}

async function verifyFleetToken(token) {
  if (!oidcConfigured()) throw invalidApiKey('Bearer auth is not configured on this server');
  let claims;
  try {
    claims = await verifyExternal(token, { audience: config.oidcAudienceFleet });
  } catch (err) {
    throw invalidApiKey(err.message);
  }

  // Authorisation, on top of authentication — the same split the admin API makes.
  //
  // The audience says which surface a token was minted for, and nothing more. Any account in
  // the realm can ask Keycloak for a fleet-audience token: the identity provider is shared
  // with other products, so that includes people who have nothing to do with this fleet, and
  // with self-registration on, anyone at all. Without this the only thing standing between a
  // new sign-up and every firmware artifact is which client they point at.
  //
  // The role is held by a node's service account as well as by an engineer pulling a build
  // directly, because both are asking the same question of the same API — a device credential
  // is not automatically more entitled than a person, it is only easier to keep secret.
  const roles = realmRoles(claims);
  const full = Boolean(config.oidcFleetRole) && roles.includes(config.oidcFleetRole);
  const stableOnly = Boolean(config.oidcFleetStableRole)
    && roles.includes(config.oidcFleetStableRole);

  if (config.oidcFleetRole && !full && !stableOnly) {
    throw forbidden(
      `This token does not hold the "${config.oidcFleetRole}" realm role, which is required `
      + 'to use the fleet API. Grant it in Keycloak to the account or to the node service '
      + 'account this token was minted for.',
    );
  }

  // Telemetry records who asked, and every existing row holds a fleet NAME. A username keeps
  // those rows readable; the subject is the stable identifier when there is no username.
  return {
    name: claims.preferred_username || claims.sub,
    // The lesser role restricts; the full one does not, and holding both is not a conflict.
    channels: !full && stableOnly ? [config.releaseChannel] : null,
  };
}

export function verifyApiKey(req) {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || key === '') throw invalidApiKey('X-API-Key header is required');

  // Compare digests so the comparison is constant-length regardless of the candidate.
  const digest = crypto.createHash('sha256').update(key).digest();
  for (const [expectedHex, fleet] of config.apiKeys) {
    const expected = Buffer.from(expectedHex, 'hex');
    // A shared key carries no roles and so no channel restriction: it predates the idea, and
    // silently narrowing what it may pull would strand nodes that still use one.
    if (crypto.timingSafeEqual(digest, expected)) return { name: fleet, channels: null };
  }
  throw invalidApiKey('API key not recognised');
}
