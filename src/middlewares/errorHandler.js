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
      const message = status >= 500 && isProduction() ? 'Internal server error' : err.message;

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
