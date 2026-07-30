import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from './pool.js';
import { logger } from '../core/logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Apply pending .sql migrations in filename order, each inside its own transaction.
 * Deliberately tiny: an external migration tool would be another dependency to install,
 * configure and keep in sync with the container's entrypoint.
 */
export async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    const files = (await fsp.readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const name of files) {
      if (applied.has(name)) continue;

      const sql = await fsp.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${name} failed: ${err.message}`, { cause: err });
      }
      logger.info(`applied migration ${name}`);
      count += 1;
    }

    if (count === 0) logger.info(`schema up to date (${applied.size} migrations)`);
    return count;
  } finally {
    client.release();
  }
}
