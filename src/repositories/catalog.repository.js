import path from 'node:path';

import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { VERSION_RE, parseVersion } from '../domain/version.js';
import { invalidParameter } from '../core/errors.js';

/**
 * Reads of the catalog: releases, artifacts and channels. Writes live in
 * catalogAdmin.service.js because they must also bump catalog_rev in the same transaction.
 */

/** Monotonic revision of the catalog; any admin change bumps it. Drives the check ETag. */
export async function getRevision() {
  const { rows } = await query('SELECT rev FROM catalog_rev WHERE id = true');
  return rows[0] ? String(rows[0].rev) : '0';
}

export async function bumpRevision(client) {
  const runner = client ?? { query };
  const { rows } = await runner.query(
    'UPDATE catalog_rev SET rev = rev + 1 WHERE id = true RETURNING rev',
  );
  return String(rows[0].rev);
}

export async function getChannel(system, name) {
  const { rows } = await query(
    'SELECT system, name, latest, updated_at FROM channel WHERE system = $1 AND name = $2',
    [system, name],
  );
  if (!rows[0]) return null;

  return {
    system: rows[0].system,
    name: rows[0].name,
    latest: rows[0].latest,
    updatedAt: rows[0].updated_at,
  };
}

export async function listChannels(system = null) {
  const { rows } = await query(`
    SELECT system, name, latest, updated_at
    FROM channel
    WHERE $1::text IS NULL OR system = $1
    ORDER BY system, name
  `, [system]);
  return rows.map((row) => ({
    system: row.system,
    name: row.name,
    latest: row.latest,
    updatedAt: row.updated_at,
  }));
}

/** A version names a release only together with its system (migration 012). */
export async function getRelease(system, version) {
  const { rows } = await query(
    `SELECT version, system, min_version, mandatory, notes, published_at, created_at, created_by
     FROM release WHERE system = $1 AND version = $2`, [system, version],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/** Ordered by version_key, never by the text column. */
export async function listReleases({ limit = 100, offset = 0, system = null } = {}) {
  const { rows } = await query(
    `SELECT version, system, min_version, mandatory, notes, published_at, created_at, created_by
     FROM release
     WHERE $3::text IS NULL OR system = $3
     ORDER BY version_key DESC, system LIMIT $1 OFFSET $2`, [limit, offset, system],
  );
  return rows.map(mapRelease);
}

/**
 * Load one artifact with its plugin and config metadata attached.
 * `kind` is 'fleet' (platform must be null) or 'slim' (platform required).
 */
export async function findArtifact(system, version, kind, platform = null) {
  const { rows } = await query(
    `SELECT * FROM artifact
     WHERE system = $1 AND version = $2 AND kind = $3 AND platform IS NOT DISTINCT FROM $4`,
    [system, version, kind, platform],
  );
  if (!rows[0]) return null;
  return hydrate(rows[0]);
}

/**
 * The release immediately below this one, WITHIN ITS OWN SYSTEM.
 *
 * Scoping by system is not optional. Two systems have independent version lines that can
 * interleave numerically, so an unscoped query would happily pick a GCS release as the
 * baseline for a drone one and produce a diff describing a device that does not exist.
 *
 * Ordered by version_key, never by the text column — `ORDER BY version` would put 0.9.0 above
 * 0.10.0 and pick the wrong baseline for a different reason.
 */
export async function findPreviousRelease(version, system) {
  const { rows } = await query(
    `SELECT version, system, min_version, mandatory, notes, published_at, created_at, created_by
     FROM release
     WHERE system = $2 AND version_key < $1
     ORDER BY version_key DESC LIMIT 1`,
    [parseVersion(version), system],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/** Newest release of one system, by version_key. */
export async function newestRelease(system) {
  const { rows } = await query(
    `SELECT version, system, min_version, mandatory, notes, published_at, created_at, created_by
     FROM release WHERE system = $1 ORDER BY version_key DESC LIMIT 1`, [system],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/**
 * Config params set by releases in a version range, oldest first.
 *
 * A bundle carries only its own release's config payload, so a node that jumps several
 * versions never sees the params the releases it skipped would have set. This is the query
 * that makes that gap visible.
 *
 * Bounds are exclusive, and ordering is by version_key — never by the text column.
 */
export async function configParamsBetween(afterVersion, beforeVersion, system) {
  const { rows } = await query(
    `SELECT r.version, ac.platform, ac.target, ac.param, ac.value
     FROM release r
     JOIN artifact a  ON a.system = r.system AND a.version = r.version
     JOIN artifact_config ac ON ac.artifact_id = a.id
     WHERE r.system = $3
       AND ($1::int[] IS NULL OR r.version_key > $1)
       AND r.version_key < $2
     ORDER BY r.version_key ASC`,
    [afterVersion ? parseVersion(afterVersion) : null, parseVersion(beforeVersion), system],
  );

  return rows.map((row) => ({
    version: row.version,
    platform: row.platform,
    target: row.target,
    param: row.param,
    to: row.value,
  }));
}

export async function findArtifactById(id) {
  const { rows } = await query('SELECT * FROM artifact WHERE id = $1', [id]);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function listArtifacts(system, version) {
  const { rows } = await query(
    'SELECT * FROM artifact WHERE system = $1 AND version = $2 ORDER BY kind, platform',
    [system, version],
  );
  return Promise.all(rows.map(hydrate));
}

async function hydrate(row) {
  const [plugins, configs] = await Promise.all([
    query(
      `SELECT platform, name, version, version_known, source
       FROM artifact_plugin WHERE artifact_id = $1`, [row.id],
    ),
    query(
      'SELECT platform, target, param, value FROM artifact_config WHERE artifact_id = $1',
      [row.id],
    ),
  ]);

  // platform -> Map<pluginName, {version, known}>
  //
  // `known` is load-bearing: a plugin built with no version define reports the literal string
  // 'unknown', and isNewer('unknown', x) throws. Anything that orders these must check it.
  const pluginsByPlatform = new Map();
  for (const p of plugins.rows) {
    if (!pluginsByPlatform.has(p.platform)) pluginsByPlatform.set(p.platform, new Map());
    pluginsByPlatform.get(p.platform).set(p.name, {
      version: p.version,
      known: p.version_known,
      source: p.source,
    });
  }

  // platform -> [{target, param, to}]
  const configByPlatform = new Map();
  for (const c of configs.rows) {
    if (!configByPlatform.has(c.platform)) configByPlatform.set(c.platform, []);
    configByPlatform.get(c.platform).push({ target: c.target, param: c.param, to: c.value });
  }

  return {
    id: Number(row.id),
    system: row.system,
    version: row.version,
    kind: row.kind,
    platform: row.platform,
    platforms: row.platforms,
    file: row.file,
    size: Number(row.size),
    sha256: row.sha256,
    bundleFormat: row.bundle_format ?? null,
    inspection: row.inspection ?? null,
    signature: row.signature_value
      ? { alg: row.signature_alg, key_id: row.signature_key_id, value: row.signature_value }
      : null,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
    plugins: pluginsByPlatform,
    config: configByPlatform,
  };
}

function mapRelease(row) {
  return {
    version: row.version,
    system: row.system,
    minVersion: row.min_version,
    mandatory: row.mandatory,
    notes: row.notes,
    // The signed payload must not depend on how a timestamp is rendered, so normalise to
    // RFC 3339 with a Z suffix exactly like the spec's examples.
    publishedAt: row.published_at ? toRfc3339(row.published_at) : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function toRfc3339(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Every version some channel of this system currently points at — what "published" means here.
 * Anything else sits in the catalog unreachable: staged, not published.
 *
 * Per system, because a number no longer names one release: HERAHUB/stable serving 0.2.0 says
 * nothing about whether HERA's 0.2.0 is published.
 *
 * `names` narrows it to particular channels, which is how a credential restricted to stable
 * is stopped from fetching a beta build by version number. Omitted, it answers for all of
 * them, which is what the global DOWNLOAD_REQUIRES_CHANNEL gate asks.
 */
export async function reachableVersions(system, { names = null } = {}) {
  const channels = await listChannels(system);
  return new Set(channels
    .filter((channel) => !names || names.includes(channel.name))
    .map((channel) => channel.latest)
    .filter(Boolean));
}

export function versionKey(version) {
  return parseVersion(version);
}

/**
 * Absolute path of an artifact file: <root>/<system>/<version>/<file>.
 *
 * The system is a directory of its own because two systems may now publish the same version
 * number, and under the old <root>/<version>/ layout the second upload would have renamed its
 * bytes over the first's.
 *
 * Guarded against traversal. The router's `:version` pattern happily matches
 * `..%2f..%2fpackage.json`, and decodeURIComponent turns the escapes back into separators, so
 * this check is what stops it.
 */
export function artifactPath(system, version, file) {
  return path.join(releaseDirectory(system, version), checkedSegment(file, 'artifact file'));
}

/** <root>/<system>/<version>, the directory holding one release's files. */
export function releaseDirectory(system, version) {
  if (!VERSION_RE.test(version)) throw invalidParameter(`Invalid version: ${version}`);
  return path.join(systemDirectory(system), version);
}

/** <root>/<system>. */
export function systemDirectory(system) {
  const root = config.paths.artifacts;
  const full = path.resolve(root, checkedSegment(system, 'system'));
  if (!full.startsWith(root + path.sep)) throw invalidParameter('Artifact path escapes the root');
  return full;
}

/**
 * Where an artifact lived before migration 012 — <root>/<version>/<file>. Read only by the
 * one-time move into the per-system layout.
 */
export function legacyArtifactPath(version, file) {
  if (!VERSION_RE.test(version)) throw invalidParameter(`Invalid version: ${version}`);
  const root = config.paths.artifacts;
  const full = path.resolve(root, version, checkedSegment(file, 'artifact file'));
  if (!full.startsWith(root + path.sep)) throw invalidParameter('Artifact path escapes the root');
  return full;
}

/** One path segment, never a separator or a dot-name that would climb out of its parent. */
function checkedSegment(value, what) {
  if (!value || path.basename(value) !== value || value === '.' || value === '..') {
    throw invalidParameter(`Invalid ${what}: ${value}`);
  }
  return value;
}

/** Every artifact row, for the one-time move into the per-system layout. */
export async function listAllArtifactFiles() {
  const { rows } = await query('SELECT system, version, file FROM artifact');
  return rows;
}

// ── removal (feature 005) ─────────────────────────────────────────────────────────────────
//
// These take the transaction's client and are used in one order: lockRelease, then
// channelsServing, then a delete. That order is the guarantee that a removal cannot empty a
// channel — see lockRelease.

/**
 * Lock one release row for the rest of the transaction, or null if it is gone.
 *
 * FOR UPDATE, not a plain read. Every path that points a channel at a release — the promote's
 * UPDATE and an upload's INSERT … ON CONFLICT — runs a foreign-key check that takes FOR KEY
 * SHARE on this row, and FOR UPDATE conflicts with it. Once this returns, no promote can land on
 * this release until the transaction ends; one that committed before is visible to the next
 * statement, because READ COMMITTED gives every statement a fresh snapshot.
 */
export async function lockRelease(client, system, version) {
  const { rows } = await client.query(
    'SELECT version, system FROM release WHERE system = $1 AND version = $2 FOR UPDATE',
    [system, version],
  );
  return rows[0] ?? null;
}

/** Every channel serving this release, as `system/name`, in a stable order. */
export async function channelsServing(client, system, version) {
  const { rows } = await client.query(
    'SELECT system, name FROM channel WHERE system = $1 AND latest = $2 ORDER BY name',
    [system, version],
  );
  return rows.map((row) => `${row.system}/${row.name}`);
}

/** Delete one release; its artifacts go with it (ON DELETE CASCADE). Returns rows deleted. */
export async function deleteReleaseRow(client, system, version) {
  const { rowCount } = await client.query(
    'DELETE FROM release WHERE system = $1 AND version = $2', [system, version],
  );
  return rowCount;
}

/** Delete one artifact row. Returns rows deleted: 0 means someone else got there first. */
export async function deleteArtifactRow(client, id) {
  const { rowCount } = await client.query('DELETE FROM artifact WHERE id = $1', [id]);
  return rowCount;
}
