import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { invalidApiKey } from '../core/errors.js';
import { oidcConfigured, verifyExternal } from '../core/oidc.js';

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
 */
export function requireFleetAuth(handler) {
  return async (req, res) => {
    req.fleet = await verifyFleet(req);
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
  // Telemetry records who asked, and every existing row holds a fleet NAME. A username keeps
  // those rows readable; the subject is the stable identifier when there is no username.
  return claims.preferred_username || claims.sub;
}

export function verifyApiKey(req) {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || key === '') throw invalidApiKey('X-API-Key header is required');

  // Compare digests so the comparison is constant-length regardless of the candidate.
  const digest = crypto.createHash('sha256').update(key).digest();
  for (const [expectedHex, fleet] of config.apiKeys) {
    const expected = Buffer.from(expectedHex, 'hex');
    if (crypto.timingSafeEqual(digest, expected)) return fleet;
  }
  throw invalidApiKey('API key not recognised');
}
