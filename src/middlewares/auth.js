import { forbidden, unauthorized, upgradeRequired } from '../core/errors.js';
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
 * The same, plus one question `requireAuth` cannot answer: may THIS account do THIS thing.
 *
 * Written as a decorator rather than a pipeline step for the reason apiKey.js gives —
 * Router.use() only accepts a Router, and a path allowlist would state the route table twice.
 * The upside is that the routes file becomes the permission model: every line names both the
 * handler and what it takes to reach it, reviewable in one screen.
 *
 * The scope is left on the returned function so a test can walk the router and fail on any
 * route that declares none. Deny-by-default is only true if nothing can be added without
 * deciding — and the way that rule dies is a new route quietly landing under `requireAuth`.
 */
export function requireScope(scope, handler) {
  const guarded = requireAuth(async (req, res) => {
    if (!req.user?.scopes?.has(scope)) {
      throw forbidden(`This account may not do that: it lacks the "${scope}" permission. `
        + 'Uploading to the catalog and publishing to the fleet are deliberately different '
        + 'rights; see docs/rbac-proposal.md.');
    }
    return handler(req, res);
  });
  guarded.scope = scope;
  return guarded;
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
