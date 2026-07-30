import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { invalidApiKey } from '../core/errors.js';

/**
 * Fleet authentication for /api/v1/*.
 *
 * Applied as a decorator at route-registration time rather than as a pipeline middleware:
 * Router.use() only accepts a Router, and a path allowlist would duplicate route knowledge
 * and turn every unknown /api/v1 path into a 401 instead of a 404. Leaving /api/v1/health
 * unwrapped is the whole implementation of its section 12 exemption, visible right where a
 * reader looks.
 */
export function requireApiKey(handler) {
  return async (req, res) => {
    req.fleet = verifyApiKey(req);
    return handler(req, res);
  };
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
