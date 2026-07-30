import { unauthorized, upgradeRequired } from '../core/errors.js';
import { authenticate } from '../services/auth.service.js';

/**
 * Admin authentication for /admin/*.
 *
 * Deliberately separate from the fleet's X-API-Key: that key sits in core.json on every
 * device and travels the same wire, so anyone holding one device has it (spec section 10).
 * Neither credential opens the other's routes.
 */
export function requireAuth(handler) {
  return async (req, res) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw unauthorized('Authorization: Bearer <token> is required');
    }
    req.user = await authenticate(header.slice(7).trim());
    return handler(req, res);
  };
}

/**
 * When the plaintext HTTP escape hatch is enabled it serves the fleet only; admin traffic
 * carries credentials and must never cross it.
 */
export function requireTls() {
  return async (req, res, next) => {
    if (!req.secure && req.pathname.startsWith('/admin')) {
      throw upgradeRequired('The admin interface is only available over HTTPS');
    }
    return next();
  };
}
