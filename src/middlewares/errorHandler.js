import { HttpError } from '../core/errors.js';
import { sendJson } from '../core/http.js';
import { logger } from '../core/logger.js';
import { isProduction } from '../config/index.js';

/** Wraps the whole pipeline: any thrown error becomes the spec's {error, message} envelope. */
export function errorHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const isHttp = err instanceof HttpError;
      const status = isHttp ? err.status : 500;
      const code = isHttp ? err.code : 'server_error';

      // Mask by ORIGIN, not by status. An HttpError's message was written to be read by the
      // caller — `maintenance` says "Temporarily unavailable", upstreamUnavailable says which
      // service to wait on — and masking every 5xx swallowed all of them, so a 503 anyone was
      // meant to retry arrived saying "Internal server error" and reading like a crash.
      // What must never escape is a raw throw, whose message is for the log alone.
      const message = isHttp || !isProduction() ? err.message : 'Internal server error';

      if (status >= 500) logger.error(`${req.method} ${req.url}`, err);

      // Once a body has started (a download stream), truncate the connection rather than
      // delivering a short body that looks clean to the client's parser.
      if (res.headersSent) return res.destroy();

      const body = { error: code, message };
      if (isHttp && err.details) body.details = err.details;

      sendJson(res, status, body, isHttp ? err.headers : {});
    }
  };
}
