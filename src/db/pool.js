import pg from 'pg';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';

let pool = null;

export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not configured');
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
    pool.on('error', (err) => logger.error('idle database client error', err));
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

/** Run fn inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Wait for the database. `depends_on: service_healthy` is not enough on its own — Postgres
 * can accept connections a moment before it accepts ours, and a container restart loop is a
 * worse failure mode than a short retry.
 */
export async function connectWithRetry({ attempts = 8, baseDelayMs = 500 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await query('SELECT 1');
      logger.info('database connection established');
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 5000);
      logger.warn(`database not ready (${err.code || err.message}), retry ${attempt}/${attempts} in ${delay}ms`);
      await new Promise((resolve) => { setTimeout(resolve, delay); });
    }
  }
}

/** Cheap liveness probe for /api/v1/health. */
export async function isHealthy() {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
