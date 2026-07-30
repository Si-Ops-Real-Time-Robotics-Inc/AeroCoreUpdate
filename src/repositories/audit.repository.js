import { query } from '../db/pool.js';
import { logger } from '../core/logger.js';

/** Who did what on the admin surface. */
export async function insertAudit({ actor, action, subject, detail }, client = null) {
  const runner = client ?? { query };
  await runner.query(
    'INSERT INTO audit (actor, action, subject, detail) VALUES ($1, $2, $3, $4)',
    [actor ?? null, action, subject ?? null, detail ? JSON.stringify(detail) : null],
  );
}

/** Audit must never break the operation it is recording. */
export async function insertAuditSafe(entry) {
  try {
    await insertAudit(entry);
  } catch (err) {
    logger.error('failed to write audit entry', err);
  }
}

export async function listAudit({ limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    'SELECT id, at, actor, action, subject, detail FROM audit ORDER BY at DESC LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}
