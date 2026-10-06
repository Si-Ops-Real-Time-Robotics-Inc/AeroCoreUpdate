import { config } from './config/index.js';
import { compose } from './core/http.js';
import { adminCsp } from './core/csp.js';
import { invalidParameter, maintenance } from './core/errors.js';
import { apiRoutes } from './routes/index.js';
import { requestLogger } from './middlewares/logger.js';
import { requireTls } from './middlewares/auth.js';
import { staticFiles } from './middlewares/staticFiles.js';
import { shouldSendHsts } from './services/tlsInfo.service.js';
import { notFoundHandler } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';

/**
 * Assemble the app: middlewares run in declaration order, each calling next() to hand off to
 * the one below it. The whole chain is wrapped by errorHandler.
 */
export function createApp() {
  const pipeline = compose([
    requestLogger(),
    parseUrl(),
    securityHeaders(),
    requireTls(),
    maintenanceGate(),
    apiRoutes.middleware(),
    rootRedirect(),
    staticFiles(config.paths.public, { spa: { prefix: '/admin/', index: 'admin/index.html' } }),
    notFoundHandler(),
  ]);

  return errorHandler(pipeline);
}

/** Parse pathname/query once so later middlewares can reuse them. */
function parseUrl() {
  return async (req, res, next) => {
    let url;
    try {
      // HTTP/2 carries the authority in `:authority`, not `host` — under h2 the `host` header
      // is absent entirely. Only the path and query are read from this URL, so the fallback is
      // harmless, but reading the wrong field would quietly make any future use of the host
      // wrong on exactly half the connections.
      const authority = req.headers[':authority'] ?? req.headers.host ?? 'localhost';
      url = new URL(req.url, `https://${authority}`);
    } catch {
      throw invalidParameter('Malformed request URL');
    }
    req.pathname = url.pathname;
    req.query = url.searchParams;
    req.secure = Boolean(req.socket?.encrypted);
    await next();
  };
}

/**
 * There is nothing to serve at the document root — the UI lives under /admin/ — so send a
 * browser there instead of the {"error":"not_found"} JSON meant for the fleet.
 */
function rootRedirect() {
  return async (req, res, next) => {
    if (req.pathname !== '/') return next();
    res.writeHead(302, { Location: '/admin/' });
    res.end();
    return undefined;
  };
}

/**
 * HSTS goes on the admin surface only. A node is not a browser, so the header would mean
 * nothing to it, and the fleet may be reachable over plaintext through the escape hatch.
 */
function securityHeaders() {
  return async (req, res, next) => {
    if (req.pathname.startsWith('/admin')) {
      // Only behind a trusted certificate. With a self-signed one HSTS locks the operator out
      // of the UI: the browser records the policy, then refuses to let anyone click through
      // the certificate warning for a year.
      if (shouldSendHsts()) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', adminCsp(config.oidcIssuer));
    }
    await next();
  };
}

/**
 * Health stays available during maintenance on purpose: section 12 exists so a node can tell
 * "server unreachable" from "no update", and monitoring needs an answer either way.
 */
function maintenanceGate() {
  return async (req, res, next) => {
    if (config.maintenance && req.pathname !== '/api/v1/health') {
      throw maintenance(config.maintenanceRetryAfter);
    }
    await next();
  };
}
