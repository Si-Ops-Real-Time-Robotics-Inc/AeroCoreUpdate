import { query } from '../db/pool.js';
import { logger } from '../core/logger.js';
import { config } from '../config/index.js';

/** Node-reported update outcomes (spec section 11) and the check history behind the fleet view. */

export async function insertReport(record, fleet) {
  await query(
    `INSERT INTO node_report
       (serial, platform, role, from_version, to_version, result, error, at, fleet, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      record.serial ?? null, record.platform ?? null, record.role ?? null,
      record.from_version ?? null, record.to_version ?? null,
      record.result ?? null, record.error || null,
      record.at ? new Date(record.at) : null,
      fleet ?? null, JSON.stringify(record),
    ],
  );
}

/** Rollout health for one version: how many succeeded, and how the rest failed. */
export async function rolloutStats(version) {
  const { rows } = await query(
    `SELECT result, coalesce(nullif(error, ''), '(none)') AS error, count(*)::int AS count
     FROM node_report
     WHERE ($1::text IS NULL OR to_version = $1)
     GROUP BY result, error ORDER BY count DESC`,
    [version ?? null],
  );
  return rows;
}

export async function recentReports({ limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT id, serial, platform, role, from_version, to_version, result, error, at, received_at
     FROM node_report ORDER BY received_at DESC LIMIT $1`, [limit],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/**
 * Fire-and-forget: a check must not fail because the log write did. Losing a log line is
 * survivable; failing a fleet's update is not.
 */
export function logCheck(record) {
  query(
    `INSERT INTO check_log
       (serial, platform, version, role, channel, form, offered, update_available, fleet, system)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      record.serial ?? null, record.platform ?? null, record.version ?? null,
      record.role ?? null, record.channel ?? null, record.form,
      record.offered ?? null, Boolean(record.updateAvailable), record.fleet ?? null,
      record.system ?? null,
    ],
  ).catch((err) => logger.error('failed to write check_log', err));
}

/** One row per serial: what it last reported running. */
export async function fleetInventory({ limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT DISTINCT ON (serial)
            serial, platform, version, role, channel, offered, update_available, at, system
     FROM check_log
     WHERE serial IS NOT NULL
     ORDER BY serial, at DESC
     LIMIT $1`, [limit],
  );
  return rows;
}

/**
 * Nodes asking for a channel their system does not have.
 *
 * `update.channel` is a free-text field an operator types on the device — no enum, no
 * validation against this server. Ask for `beta` where only `stable` exists and the answer is
 * a correct, protocol-compliant 204, identical to being up to date. The device shows no error.
 * So one drone stops updating forever and nothing anywhere says why.
 *
 * The join is the whole point: a channel name is only meaningful inside a system, so `beta`
 * existing for `drone` says nothing about a `HERA` node asking for it.
 *
 * Only rows that were placed (`system IS NOT NULL`) can be judged — an unplaced node's channel
 * cannot be wrong yet, because it has no system to be wrong in. Those show up under
 * unclassified nodes instead.
 */
export async function unknownChannels({ days = 7, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT c.system, c.channel, count(DISTINCT c.serial)::int AS nodes, max(c.at) AS last_seen
     FROM check_log c
     WHERE c.system IS NOT NULL
       AND c.channel IS NOT NULL
       AND c.at > now() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM channel ch WHERE ch.system = c.system AND ch.name = c.channel
       )
     GROUP BY c.system, c.channel
     ORDER BY nodes DESC, last_seen DESC
     LIMIT $2`,
    [String(days), limit],
  );
  return rows;
}

export async function pruneCheckLog(days = config.checkLogRetentionDays) {
  const { rowCount } = await query(
    "DELETE FROM check_log WHERE at < now() - ($1 || ' days')::interval", [String(days)],
  );
  if (rowCount) logger.info(`pruned ${rowCount} check_log rows older than ${days} days`);
  return rowCount;
}
