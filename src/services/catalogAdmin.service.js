import fsp from 'node:fs/promises';
import path from 'node:path';

import { withTransaction } from '../db/pool.js';
import { conflict, invalidBundle, invalidParameter, notFound } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { isNewer, parseVersion } from '../domain/version.js';
import * as catalog from '../repositories/catalog.repository.js';
import { insertAudit } from '../repositories/audit.repository.js';
import * as systems from '../repositories/system.repository.js';
import { findSystem } from '../repositories/system.repository.js';
import { config } from '../config/index.js';

/**
 * Catalog writes. Every one of these bumps catalog_rev inside the same transaction, so a
 * a channel moving or a new upload invalidates every cached check the moment it commits.
 */

export async function createRelease(input, actor) {
  const existing = await catalog.getRelease(input.version);
  if (existing) {
    throw conflict(
      `Release ${input.version} already exists`
      + (existing.system ? ` in system "${existing.system}"` : ''),
    );
  }

  const system = input.system ?? config.defaultSystem;
  if (!await findSystem(system)) {
    throw invalidParameter(
      `No system "${system}". Create it first — systems are never invented from a request, `
      + 'because one made from a typo starts a release line no node ever joins.',
    );
  }

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO release
         (version, version_key, system, min_version, mandatory, notes, published_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.version, parseVersion(input.version), system, input.minVersion ?? null,
        Boolean(input.mandatory), input.notes ?? null,
        input.publishedAt ? new Date(input.publishedAt) : new Date(),
        actor,
      ],
    );
    await insertAudit({
      actor, action: 'release.create', subject: input.version, detail: input,
    }, client);
    await catalog.bumpRevision(client);
  });

  return catalog.getRelease(input.version);
}

export async function updateRelease(version, changes, actor) {
  const existing = await catalog.getRelease(version);
  if (!existing) throw notFound(`No release ${version}`);

  // min_version and published_at are two of the six fields a manifest signature covers. Once
  // an artifact of this release is pre-signed, editing either leaves the manifest carrying a
  // value the signature does not cover — and EVERY node then rejects the release with
  // `signature_invalid`, a symptom indistinguishable from a key problem. Refuse the edit;
  // re-sign and re-upload instead.
  if (changes.minVersion !== undefined || changes.publishedAt !== undefined) {
    const signed = (await catalog.listArtifacts(version)).filter((a) => a.signature);
    if (signed.length) {
      throw conflict(
        `Release ${version} has pre-signed artifact(s) ${signed.map((a) => a.id).join(', ')}. `
        + 'min_version and published_at are part of the signed payload, so changing one here '
        + 'would make every node reject this release. Re-sign and re-upload instead.',
      );
    }
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE release SET
         min_version  = COALESCE($2, min_version),
         mandatory    = COALESCE($3, mandatory),
         notes        = COALESCE($4, notes),
         published_at = COALESCE($5, published_at)
       WHERE version = $1`,
      [
        version, changes.minVersion ?? null,
        changes.mandatory === undefined ? null : changes.mandatory,
        changes.notes ?? null,
        changes.publishedAt ? new Date(changes.publishedAt) : null,
      ],
    );
    await insertAudit({ actor, action: 'release.update', subject: version, detail: changes }, client);
    await catalog.bumpRevision(client);
  });

  return catalog.getRelease(version);
}

export async function deleteRelease(version, actor) {
  const release = await catalog.getRelease(version);
  if (!release) throw notFound(`No release ${version}`);

  const channels = await catalog.listChannels();
  const pointing = channels.filter((channel) => channel.latest === version);
  if (pointing.length) {
    throw conflict(
      `Release ${version} is the latest of: `
      + `${pointing.map((c) => `${c.system}/${c.name}`).join(', ')}`,
    );
  }

  const artifacts = await catalog.listArtifacts(version);

  await withTransaction(async (client) => {
    await client.query('DELETE FROM release WHERE version = $1', [version]);
    await insertAudit({
      actor, action: 'release.delete', subject: version, detail: { artifacts: artifacts.length },
    }, client);
    await catalog.bumpRevision(client);
  });

  // Files go after the transaction commits: an orphaned file is recoverable, a database row
  // pointing at bytes that no longer exist is not.
  await removeVersionDirectory(version);
  return { version, artifacts: artifacts.length };
}

export async function deleteArtifact(id, actor) {
  const artifact = await catalog.findArtifactById(id);
  if (!artifact) throw notFound(`No artifact ${id}`);

  await withTransaction(async (client) => {
    await client.query('DELETE FROM artifact WHERE id = $1', [id]);
    await insertAudit({
      actor,
      action: 'artifact.delete',
      subject: `${artifact.version}/${artifact.file}`,
      detail: { id, kind: artifact.kind, platform: artifact.platform },
    }, client);
    await catalog.bumpRevision(client);
  });

  await fsp.rm(catalog.artifactPath(artifact.version, artifact.file), { force: true })
    .catch((err) => logger.error(`could not remove artifact file ${artifact.file}`, err));

  return { id };
}

/**
 * Replace an artifact's plugin and config metadata. This is the data the `plan` is built
 * from, and the bundle itself cannot supply it (spec section 5).
 */
export async function setArtifactMetadata(id, { plugins, config: configChanges }, actor) {
  const artifact = await catalog.findArtifactById(id);
  if (!artifact) throw notFound(`No artifact ${id}`);

  await withTransaction(async (client) => {
    // Only the operator's own rows are replaced. Rows the bundle supplied survive unless this
    // body names the same (platform, name), in which case the manual value wins below.
    await client.query(
      "DELETE FROM artifact_plugin WHERE artifact_id = $1 AND source = 'manual'", [id],
    );
    await client.query('DELETE FROM artifact_config WHERE artifact_id = $1', [id]);

    for (const [platform, entries] of Object.entries(plugins ?? {})) {
      assertCovered(artifact, platform);
      for (const [name, version] of Object.entries(entries)) {
        parseVersion(version); // an operator typing a non-numeric version really is a mistake
        await client.query(
          `INSERT INTO artifact_plugin (artifact_id, platform, name, version, version_known, source)
           VALUES ($1,$2,$3,$4,true,'manual')
           ON CONFLICT (artifact_id, platform, name)
           DO UPDATE SET version = $4, version_known = true, source = 'manual'`,
          [id, platform, name, version],
        );
      }
    }

    for (const [platform, changes] of Object.entries(configChanges ?? {})) {
      assertCovered(artifact, platform);
      for (const change of changes) {
        if (!change || typeof change.target !== 'string' || typeof change.param !== 'string') {
          throw invalidParameter('each config entry needs target and param');
        }
        await client.query(
          `INSERT INTO artifact_config (artifact_id, platform, target, param, value)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, platform, change.target, change.param, JSON.stringify(change.to)],
        );
      }
    }

    await insertAudit({
      actor, action: 'artifact.metadata', subject: String(id), detail: { plugins, config: configChanges },
    }, client);
    await catalog.bumpRevision(client);
  });

  return catalog.findArtifactById(id);
}

export async function upsertChannel(system, name, changes, actor) {
  if (!await findSystem(system)) throw notFound(`No system ${system}`);

  if (changes.latest) {
    const release = await catalog.getRelease(changes.latest);
    if (!release) throw invalidParameter(`No release ${changes.latest}`);
    // A channel hands out one version, and a version belongs to one system. Pointing a drone
    // channel at a GCS release would offer every drone a bundle it cannot apply.
    if (release.system !== system) {
      throw invalidParameter(
        `Release ${changes.latest} belongs to system "${release.system}", not "${system}".`,
      );
    }

    // Moving a channel backwards is almost always a mistyped promote, and it looks harmless
    // because no node downgrades: decide() refuses anything not strictly newer. But a device
    // fresh from the factory has no such protection — it takes whatever the channel points
    // at, so the fleet quietly splits into "updated before the slip" and "provisioned after".
    const current = await catalog.getChannel(system, name);
    if (current?.latest && isNewer(current.latest, changes.latest) && !changes.allowRollback) {
      const message =
        `${system}/${name} is on ${current.latest}; ${changes.latest} is older. Nodes already `
        + 'updated will not go back, but newly provisioned ones would take it. Send '
        + '"allow_rollback": true if that is what you intend.';

      // Carried as a finding so a caller can offer the confirmation rather than parse English
      // prose to discover there is one. Same mechanism bundle inspection uses; `code` stays
      // inside the closed enum the node branches on.
      throw invalidBundle([{ rule: 'channel_rollback', message, from: current.latest, to: changes.latest }]);
    }
  }

  const released = await withTransaction(async (client) => {
    // One release runs on one channel at a time. Promoting is therefore a MOVE: the channel
    // that was serving this version lets go of it in the same transaction, so the invariant
    // can never be half-applied and never depends on someone remembering to clear the old one.
    //
    // The nodes on the released channel keep the version — they already installed it. They are
    // simply told there is nothing new until that channel is pointed somewhere again.
    //
    // Pins are deliberately untouched: a pin is an operator aiming one serial at one version
    // by hand, not a channel "running" a release, and clearing those silently would undo a
    // decision nobody asked to undo.
    let cleared = [];
    if (changes.latest) {
      const { rows } = await client.query(
        `UPDATE channel SET latest = NULL, updated_at = now()
         WHERE system = $1 AND name <> $2 AND latest = $3
         RETURNING name`,
        [system, name, changes.latest],
      );
      cleared = rows.map((row) => row.name);
    }

    await client.query(
      `INSERT INTO channel (system, name, latest, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (system, name) DO UPDATE SET
         latest = COALESCE($3, channel.latest), updated_at = now()`,
      [system, name, changes.latest ?? null],
    );
    await insertAudit({
      actor,
      action: 'channel.update',
      subject: `${system}/${name}`,
      detail: cleared.length ? { ...changes, released: cleared } : changes,
    }, client);
    await catalog.bumpRevision(client);
    return cleared;
  });

  return { ...await catalog.getChannel(system, name), released };
}

// ── systems ───────────────────────────────────────────────────────────────────────────────
// A system is the kind of device a release is for. Creating one is deliberate and explicit:
// nothing else in the server invents a system, because one made from a typo would start a
// release line no node ever joins, and the only symptom would be "nobody updated".

export async function createSystem({ name, description }, actor) {
  if (await findSystem(name)) throw conflict(`System ${name} already exists`);

  await withTransaction(async (client) => {
    await systems.createSystem({ name, description }, actor, client);

    // Every system has exactly these two, created with it. A release lands on beta when it is
    // uploaded and reaches stable only when an admin promotes it — with the set closed there
    // is nothing to name and no way to end up with a system nothing can be published to.
    await client.query(
      `INSERT INTO channel (system, name, latest, updated_at)
       SELECT $1, c.name, NULL, now() FROM (VALUES ('beta'), ('stable')) AS c(name)
       ON CONFLICT (system, name) DO NOTHING`,
      [name],
    );

    await insertAudit({
      actor, action: 'system.create', subject: name, detail: { description },
    }, client);
    await catalog.bumpRevision(client);
  });

  return findSystem(name);
}

export async function updateSystem(name, { description }, actor) {
  if (!await findSystem(name)) throw notFound(`No system ${name}`);

  await withTransaction(async (client) => {
    await client.query('UPDATE system SET description = $2 WHERE name = $1', [name, description ?? null]);
    await insertAudit({
      actor, action: 'system.update', subject: name, detail: { description },
    }, client);
    await catalog.bumpRevision(client);
  });

  return findSystem(name);
}

/**
 * Deleting a system is refused while any release still belongs to it. Those releases are what
 * classify every node on that line: drop the system and each of them becomes unresolvable, so
 * every device running one would go unclassified at its next check.
 */
export async function deleteSystem(name, actor) {
  if (!await findSystem(name)) throw notFound(`No system ${name}`);

  let removed = 0;
  await withTransaction(async (client) => {
    // Counted inside the transaction: between a check outside it and the delete, an upload
    // could add the first release of a line we are about to make unresolvable.
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM release WHERE system = $1', [name],
    );
    if (rows[0].n > 0) {
      throw conflict(
        `System ${name} still has ${rows[0].n} release(s). Delete them first — while they `
        + 'exist they are what identifies every node running one of them.',
      );
    }

    const channels = await client.query('DELETE FROM channel WHERE system = $1', [name]);
    removed = channels.rowCount;
    await client.query('DELETE FROM system WHERE name = $1', [name]);
    await insertAudit({
      actor, action: 'system.delete', subject: name, detail: { channels: removed },
    }, client);
    await catalog.bumpRevision(client);
  });

  return { name, deleted: true, channels: removed };
}

/**
 * Place a node the version lookup could not. This is the admin review step: a factory-fresh
 * device reports a version this server never published, so nothing but a human decision can
 * classify it.
 *
 * Bumps catalog_rev because it changes what that node is answered, and the check ETag is
 * built from the revision.
 */
export async function assignNodeSystem(serial, system, actor) {
  if (system !== null && !await findSystem(system)) throw notFound(`No system ${system}`);

  let ok = false;
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE unclassified_node
       SET assigned_system = $2,
           assigned_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
           assigned_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END
       WHERE serial = $1`,
      [serial, system, actor],
    );
    ok = rowCount > 0;
    if (!ok) return;

    await insertAudit({
      actor,
      action: system ? 'node.assign' : 'node.unassign',
      subject: serial,
      detail: { system },
    }, client);
    await catalog.bumpRevision(client);
  });

  if (!ok) throw notFound(`No unclassified node with serial ${serial}`);
  return { serial, system };
}

function assertCovered(artifact, platform) {
  if (!artifact.platforms.includes(platform)) {
    throw invalidParameter(
      `artifact ${artifact.id} does not cover ${platform} (covers ${artifact.platforms.join(', ')})`,
    );
  }
}

async function removeVersionDirectory(version) {
  const dir = path.join(config.paths.artifacts, version);
  const root = path.resolve(config.paths.artifacts);
  if (!path.resolve(dir).startsWith(root + path.sep)) return;
  await fsp.rm(dir, { recursive: true, force: true })
    .catch((err) => logger.error(`could not remove ${dir}`, err));
}
