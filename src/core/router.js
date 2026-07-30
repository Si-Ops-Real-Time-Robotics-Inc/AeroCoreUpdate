import { invalidParameter, methodNotAllowed } from './errors.js';

/**
 * Minimal router: register by method + pattern ('/api/v1/update/download/:version').
 * Swapping in a framework later only touches this file and app.js.
 */
export class Router {
  #routes = [];

  #add(method, pattern, handler) {
    this.#routes.push({ method, ...compilePattern(pattern), handler });
    return this;
  }

  get(pattern, handler) { return this.#add('GET', pattern, handler); }
  post(pattern, handler) { return this.#add('POST', pattern, handler); }
  put(pattern, handler) { return this.#add('PUT', pattern, handler); }
  patch(pattern, handler) { return this.#add('PATCH', pattern, handler); }
  delete(pattern, handler) { return this.#add('DELETE', pattern, handler); }

  /** Mount a child router under a path prefix. */
  use(prefix, router) {
    for (const route of router.routes) {
      this.#add(route.method, prefix + route.pattern, route.handler);
    }
    return this;
  }

  get routes() {
    return this.#routes;
  }

  /** Find a matching route. Returns null when no path matches at all. */
  match(method, pathname) {
    const allowed = new Set();
    let found = null;

    for (const route of this.#routes) {
      const result = route.regex.exec(pathname);
      if (!result) continue;
      allowed.add(route.method);

      const routeMethod = method === 'HEAD' ? 'GET' : method;
      if (route.method !== routeMethod || found) continue;

      const params = {};
      try {
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(result[index + 1]);
        });
      } catch {
        // A malformed percent-escape must be a 400, not the URIError-driven 500 it
        // would otherwise become.
        throw invalidParameter(`Malformed path segment in ${pathname}`);
      }
      found = { handler: route.handler, params };
    }

    if (found) return found;

    // Path exists but the method does not -> 405; otherwise let later middleware try.
    if (allowed.size) {
      const allow = [...allowed].sort().join(', ');
      throw methodNotAllowed(`${method} is not supported for ${pathname}`, allow);
    }
    return null;
  }

  /** Expose the router as a middleware. */
  middleware() {
    return async (req, res, next) => {
      const match = this.match(req.method, req.pathname);
      if (!match) return next();
      req.params = match.params;
      await match.handler(req, res);
    };
  }
}

function compilePattern(pattern) {
  const keys = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { pattern, keys, regex: new RegExp(`^${source}/?$`) };
}
