import { query } from '../db/pool.js';
import { logger } from '../core/logger.js';

/**
 * Systems: the kinds of device AeroCore runs on — drone, GCS, whatever else — each with its
 * own plugin set, its own config, and its own version line.
 *
 * An admin creates them explicitly. Nothing here invents one, because a system invented from a
 * typo in a bundle would quietly start its own release line that no node ever joins.
 */

export async function listSystems() {
  const { rows } = await query(`
    SELECT s.name, s.description, s.created_at, s.created_by,
           (SELECT count(*) FROM release r WHERE r.system = s.name)::int AS releases,
           (SELECT count(*) FROM channel c WHERE c.system = s.name)::int AS channels,
           (SELECT r.version FROM release r WHERE r.system = s.name
             ORDER BY r.version_key DESC LIMIT 1) AS newest
    FROM system s ORDER BY s.name
  `);
  return rows.map(mapSystem);
}

export async function findSystem(name) {
  const { rows } = await query(
    'SELECT name, description, created_at, created_by FROM system WHERE name = $1', [name],
  );
  return rows[0] ? mapSystem(rows[0]) : null;
}

export async function createSystem({ name, description }, actor, client = null) {
  const runner = client ?? { query };
  await runner.query(
    'INSERT INTO system (name, description, created_by) VALUES ($1, $2, $3)',
    [name, description ?? null, actor],
  );
}

export async function updateSystem(name, { description }) {
  const { rowCount } = await query(
    'UPDATE system SET description = $2 WHERE name = $1', [name, description ?? null],
  );
  return rowCount > 0;
}

/** Refuses while any release still belongs to it — a system is not a label to delete lightly. */
export async function deleteSystem(name) {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM release WHERE system = $1', [name],
  );
  if (rows[0].n > 0) return { deleted: false, releases: rows[0].n };

  await query('DELETE FROM system WHERE name = $1', [name]);
  return { deleted: true, releases: 0 };
}

/**
 * The one system, when there is exactly one.
 *
 * Where a bundle that names no system goes. With a single system there is nothing to confuse
 * it with and no wrong answer, so nobody is asked to choose.
 */
export async function soleSystem() {
  const { rows } = await query('SELECT name FROM system LIMIT 2');
  return rows.length === 1 ? rows[0].name : null;
}

/**
 * The admin's answer for a node that could not be placed by what it reported.
 *
 * Read on every check for a node that has one, so it is a single indexed lookup by primary
 * key. Returns null for the overwhelming majority of nodes, which have no assignment at all.
 */
export async function assignedSystem(serial) {
  if (!serial) return null;
  const { rows } = await query(
    'SELECT assigned_system FROM unclassified_node WHERE serial = $1', [serial],
  );
  return rows[0]?.assigned_system ?? null;
}

/**
 * Park a node we could not classify. Never blocks the response — a check must answer even if
 * this write fails.
 *
 * An existing assignment is deliberately left alone: this runs on every check from an
 * assigned node too, and overwriting it would undo the admin's decision once per request.
 */
export function recordUnclassified(node, fleet) {
  query(
    `INSERT INTO unclassified_node
       (serial, platform, version, role, channel, fleet, reported_system)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (serial) DO UPDATE SET
       platform = $2, version = $3, role = $4, channel = $5, fleet = $6,
       reported_system = $7,
       last_seen = now(), seen_count = unclassified_node.seen_count + 1`,
    [node.serial ?? null, node.platform ?? null, node.version ?? null,
      node.role ?? null, node.channel ?? null, fleet ?? null, node.system ?? null],
  ).catch((err) => logger.error('failed to record an unclassified node', err));
}

/** @param {'pending'|'assigned'|'all'} filter */
export async function listUnclassified({ limit = 200, filter = 'all' } = {}) {
  const { rows } = await query(
    `SELECT serial, platform, version, role, channel, fleet, reported_system,
            first_seen, last_seen, seen_count,
            assigned_system, assigned_at, assigned_by
     FROM unclassified_node
     WHERE ($2 = 'all')
        OR ($2 = 'pending'  AND assigned_system IS NULL)
        OR ($2 = 'assigned' AND assigned_system IS NOT NULL)
     ORDER BY assigned_system NULLS FIRST, last_seen DESC
     LIMIT $1`, [limit, filter],
  );
  return rows;
}

/** Assign a serial to a system, or pass null to put it back in the pending list. */
export async function assignNode(serial, system, actor) {
  const { rowCount } = await query(
    `UPDATE unclassified_node
     SET assigned_system = $2,
         assigned_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
         assigned_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END
     WHERE serial = $1`,
    [serial, system, actor],
  );
  return rowCount > 0;
}

export async function forgetNode(serial) {
  const { rowCount } = await query('DELETE FROM unclassified_node WHERE serial = $1', [serial]);
  return rowCount > 0;
}

export async function countPending() {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM unclassified_node WHERE assigned_system IS NULL',
  );
  return rows[0].n;
}

function mapSystem(row) {
  return {
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    createdBy: row.created_by,
    releases: row.releases,
    channels: row.channels,
    newest: row.newest ?? null,
  };
}
