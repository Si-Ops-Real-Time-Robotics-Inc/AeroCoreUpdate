import { logger } from '../core/logger.js';

/** Log every request with its status code and duration. */
export function requestLogger() {
  return async (req, res, next) => {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info(`${req.method} ${req.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });

    await next();
  };
}
