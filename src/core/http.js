import { config } from '../config/index.js';
import { invalidParameter, payloadTooLarge } from './errors.js';

/** Send a JSON response. Caller-supplied headers win over the defaults. */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Send a bodyless response. Deliberately sets no Content-Type and no Content-Length:
 * this is the 304 path, and a 304 carrying a content length is illegal.
 */
export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

/**
 * Compare an If-None-Match header against an ETag. Handles the multi-value list and the
 * weak `W/` prefix that a single `===` comparison would get wrong.
 */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const strip = (value) => value.trim().replace(/^W\//, '');
  const target = strip(etag);
  return ifNoneMatch.split(',').some((candidate) => {
    const value = strip(candidate);
    return value === '*' || value === target;
  });
}

/** Read and parse a JSON body, enforcing the configured size limit. */
export async function readJsonBody(req, limit = config.bodyLimit) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw payloadTooLarge();
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalidParameter('Body is not valid JSON');
  }
}

/** Chain (req, res, next) middlewares into a single sequential runner. */
export function compose(middlewares) {
  return function run(req, res, index = 0) {
    const middleware = middlewares[index];
    if (!middleware) return Promise.resolve();
    return Promise.resolve(middleware(req, res, () => run(req, res, index + 1)));
  };
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Build a Set-Cookie header value. */
export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
