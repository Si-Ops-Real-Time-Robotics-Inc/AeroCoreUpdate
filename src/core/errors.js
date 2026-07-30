/**
 * Error carrying an HTTP status, a stable machine code and optional response headers.
 * Any layer throws this; errorHandler turns it into the spec's {error, message} envelope.
 *
 * `code` values come from the closed enum in update-server-api.md section 1. Statuses the
 * spec does not name (403/405/409/413/415/426) keep their correct HTTP status but reuse the
 * nearest legal code, so a conforming node never sees a code it cannot branch on.
 */
export class HttpError extends Error {
  constructor(status, code, message, { headers = {}, details = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    // Optional list of individual findings, used by bundle inspection so an operator sees
    // every problem at once instead of one round trip per mistake. Nothing under /api/v1
    // sets it, so the node-facing envelope is unchanged.
    this.details = details;
  }
}

/** invalidParameter carrying every finding, not just the first. */
export const invalidBundle = (findings) =>
  new HttpError(400, 'invalid_parameter', findings[0].message, { details: findings });

export const missingParameter = (name) =>
  new HttpError(400, 'missing_parameter', `${name} is required`);

export const invalidParameter = (message = 'Invalid parameter') =>
  new HttpError(400, 'invalid_parameter', message);

export const invalidApiKey = (message = 'API key not recognised') =>
  new HttpError(401, 'invalid_api_key', message);

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'invalid_api_key', message);

export const forbidden = (message = 'Forbidden') =>
  new HttpError(403, 'invalid_api_key', message);

export const notFound = (message = 'Not found') =>
  new HttpError(404, 'not_found', message);

export const methodNotAllowed = (message = 'Method not allowed', allow = '') =>
  new HttpError(405, 'not_found', message, { headers: allow ? { Allow: allow } : {} });

export const conflict = (message = 'Already exists') =>
  new HttpError(409, 'invalid_parameter', message);

export const payloadTooLarge = (message = 'Payload too large') =>
  new HttpError(413, 'invalid_parameter', message);

export const unsupportedMedia = (message = 'Unsupported media type') =>
  new HttpError(415, 'invalid_parameter', message);

export const rangeNotSatisfiable = (size) =>
  new HttpError(416, 'range_not_satisfiable', 'Range beyond end of resource', {
    headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
  });

export const upgradeRequired = (message = 'TLS is required for this endpoint') =>
  new HttpError(426, 'invalid_parameter', message, {
    headers: { Upgrade: 'TLS/1.2, HTTP/1.1' },
  });

export const rateLimited = (retryAfterSeconds) =>
  new HttpError(429, 'rate_limited', 'Too many requests', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });

export const serverError = (message = 'Internal server error') =>
  new HttpError(500, 'server_error', message);

export const maintenance = (retryAfterSeconds) =>
  new HttpError(503, 'maintenance', 'Temporarily unavailable', {
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
