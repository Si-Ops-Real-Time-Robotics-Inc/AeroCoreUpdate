import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { fileSha256, receiveToTempFile } from '../core/files.js';
import { conflict, invalidBundle, invalidParameter, notFound } from '../core/errors.js';
import { withTransaction } from '../db/pool.js';

// Postgres unique_violation. Raised by artifact_fleet_uniq and by the (version, kind,
// platform) constraint when two uploads race past the advisory check above.
const UNIQUE_VIOLATION = '23505';
import { parseVersion } from '../domain/version.js';
import { resolveKind } from '../domain/bundle.js';
import { canonicalTarget } from '../domain/platform.js';
import { verifyWithPublicKey } from './signing.service.js';
import * as catalog from '../repositories/catalog.repository.js';
import { insertAudit } from '../repositories/audit.repository.js';
import { inspectArtifact } from './bundleInspect.service.js';
import { gapsForRelease, offeredConfigFrom } from './configGap.service.js';
import { findSystem, soleSystem } from '../repositories/system.repository.js';

const TEMP_DIR = () => path.join(config.paths.artifacts, '.tmp');

/**
 * Receive and publish an artifact.
 *
 * The bundle is the source of truth: the version and the platform set come out of its
 * manifest.json, not out of the URL. Anything the caller asserted is cross-checked and a
 * mismatch is refused, because the node's apply path reports a stale bundle as
 * {"action":"skipped","reason":"same_version"} with no error — success-looking, fleet-wide,
 * and invisible until someone notices nothing changed.
 *
 * Three properties this has to keep:
 *   - the bytes land in a temp file and are renamed into place, so artifacts/<version>/ never
 *     holds a half-written file a node could download;
 *   - sha256 is computed while streaming, so a 24 MB bundle is never read twice over the wire;
 *   - the database rows and the file commit together.
 */
/**
 * Everything that decides whether these bytes may become an artifact, and what it would be.
 *
 * Pulled out of uploadArtifact because it now runs twice: once when an operator asks to see
 * what a file contains, and again when they commit it. The second run is not a formality —
 * the catalog can change in between, so duplicates and cumulative-config are re-checked
 * against the state at commit time rather than the state at preview time.
 *
 * Reads nothing but the file and the database. Writes nothing.
 */
async function examine(received, { version, platforms, kind, expectedSha256 }) {
  if (received.size === 0) throw invalidParameter('Upload was empty');

  // Before inspection: a corrupted transfer must not be reported as a bundle-format fault.
  if (expectedSha256 && expectedSha256 !== received.sha256) {
    throw invalidParameter(
      `sha256 mismatch: expected ${expectedSha256}, received ${received.sha256}`,
    );
  }

  const inspection = await inspectArtifact(received.tempPath, { version, platforms, kind });

  // A config-only bundle covers no platform of its own; crossCheck has already insisted the
  // caller name them.
  const finalPlatforms = inspection.platforms.length ? inspection.platforms : [...platforms];
  const finalKind = resolveKind(finalPlatforms, kind);
  const finalPlatform = finalKind === 'slim' ? finalPlatforms[0] : null;
  const finalVersion = inspection.version;

  // Which kind of device this is for. An admin creates systems explicitly, so an unknown
  // name is refused rather than invented: a typo would silently start a release line of its
  // own that no node ever joins, and the mistake would only surface as "nobody updated".
  // A bundle that names nothing goes to the only system there is, and failing that to
  // DEFAULT_SYSTEM. The sole-system rule matches how the check path places a node it cannot
  // identify: with one system there is no ambiguity to resolve, so nobody is asked to.
  const systemName = inspection.release.system
    ?? await soleSystem()
    ?? config.defaultSystem;

  if (!await findSystem(systemName)) {
    throw invalidBundle([{
      rule: 'unknown_system',
      message: inspection.release.system
        ? `Unknown system "${systemName}". Create it on the Systems tab, or fix the name.`
        : `No system named, and the default "${systemName}" does not exist. Build with a `
          + '"system" field in the manifest, or create that system.',
    }]);
  }

  // Config must travel as a component, and — where the policy demands it — must always be
  // present. A core slice's own config/ directory is NOT this: that path replaces every
  // unlocked param on the node, which is why it is warned about separately.
  if (config.requireConfigComponent && !inspection.configs.length) {
    throw invalidBundle([{
      rule: 'config_component_required',
      message: 'No config component. Every release must restate its settings so a node '
        + 'arriving from any older version ends up correct. Add --config core=values.json. '
        + "Shipping the core's own config/ does not count.",
    }]);
  }

  // A bundle carries only its own config payload, and the node applies exactly what it is
  // handed — so a param an earlier release set and this one omits is never restored on a
  // node that skipped that release, and nothing on either side reports it. Checked here,
  // before a byte is committed.
  const gaps = await gapsForRelease(
    finalVersion,
    offeredConfigFrom(inspection, finalPlatforms),
    inspection.release.configDropped,
    systemName,
  );

  if (gaps.length) {
    const listed = gaps.map((g) => `${g.target}.${g.param} (set by ${g.version})`).join(', ');
    const advice = 'Config payloads must be cumulative — a node skipping those releases '
      + 'never receives them. Locked params are skipped by the node anyway, so re-sending is '
      + 'safe. To drop one on purpose, list it in release.json as config_dropped.';

    if (config.requireCumulativeConfig) {
      throw invalidBundle([{
        rule: 'config_not_cumulative',
        message: `Omits ${gaps.length} config param(s) earlier releases set: ${listed}. `
          + advice,
      }]);
    }

    inspection.warnings.push({
      rule: 'config_not_cumulative',
      message: `Omits ${gaps.length} config param(s) earlier releases set: ${listed}. `
        + advice,
    });
  }

  // Systems have separate version lines and a version names exactly one of them — that is
  // the whole mechanism by which a checking node is classified. Letting two systems share a
  // number would attach this artifact to the other system's release and, worse, make every
  // node on that version resolve to the wrong system from then on.
  const existingRelease = await catalog.getRelease(finalVersion);
  if (existingRelease && existingRelease.system !== systemName) {
    throw conflict(
      `Version ${finalVersion} already belongs to system "${existingRelease.system}", but `
      + `this bundle declares "${systemName}". Each system has its own version line and a `
      + 'version number is never reused across systems, because the server identifies a '
      + "node's system from the version it reports. Give this release a number that "
      + `"${systemName}" has not used.`,
    );
  }

  if (await catalog.findArtifact(finalVersion, finalKind, finalPlatform)) {
    throw conflict(
      `An artifact already exists for ${finalVersion} ${finalKind} `
      + `${finalPlatform ?? '(fleet)'}`,
    );
  }

  return {
    inspection,
    version: finalVersion,
    kind: finalKind,
    platform: finalPlatform,
    platforms: finalPlatforms,
    system: systemName,
  };
}

// The staging token IS the temp file's name. Nothing else needs to be stored, and a token
// that does not look exactly like the UUID receiveToTempFile generated never reaches the
// filesystem — otherwise this parameter would be a path traversal straight into ARTIFACTS_DIR.
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stagedPath(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw invalidParameter(`Not an upload token: ${token}`);
  }
  return path.join(TEMP_DIR(), `${token}.part`);
}

/**
 * Step one: take the bytes, open them, say what they are — and store nothing.
 *
 * The whole point is that an operator sees the version, the plugins, the config params and
 * the diff BEFORE any of it is in the catalog. Nothing here writes a row or renames a file;
 * the upload sits in the temp directory under a token until it is committed or expires.
 *
 * Expiry is the pruner server.js already runs: `.part` files older than an hour are swept, so
 * an abandoned preview costs disk for at most that long and needs no bookkeeping of its own.
 */
export async function stageUpload(req, { version, platforms, kind, expectedSha256 }) {
  const received = await receiveToTempFile(req, {
    dir: TEMP_DIR(), limit: config.uploadMaxBytes,
  });

  try {
    const examined = await examine(received, { version, platforms, kind, expectedSha256 });
    return {
      token: path.basename(received.tempPath, '.part'),
      size: received.size,
      sha256: received.sha256,
      ...examined,
    };
  } catch (err) {
    await fsp.rm(received.tempPath, { force: true })
      .catch((rmErr) => logger.error('could not remove the staged upload', rmErr));
    throw err;
  }
}

/**
 * Step two: commit what was staged.
 *
 * Re-examines from the file rather than trusting anything step one returned. The bytes are the
 * source of truth and the token only says WHICH bytes — between the preview and the click,
 * another upload may have taken this version, or a release may have added a config param this
 * bundle now omits. Both are refusals that can only be made against the state right now.
 *
 * Re-hashing costs a read of a file that was written minutes ago and is still in page cache,
 * and it is also what catches a temp file that was truncated in the meantime.
 */
export async function commitUpload(token, { platforms, kind, channel, actor }) {
  const tempPath = stagedPath(token);

  let stat;
  try {
    stat = await fsp.stat(tempPath);
  } catch {
    throw notFound(
      `Staged upload ${token} is gone. Staged uploads are discarded after an hour — `
      + 'upload the file again.',
    );
  }

  const received = { tempPath, size: stat.size, sha256: await fileSha256(tempPath) };

  try {
    const examined = await examine(received, { version: null, platforms, kind });
    // The two-step path cannot carry a signature yet: the headers ride with the BODY, which
    // arrived at stage time and was not kept. Run the same gate anyway so
    // SIGNING_REQUIRE_PRESIGNED cannot be bypassed by uploading through the Web UI —
    // silently accepting an unsigned artifact here would defeat the whole setting.
    await checkSignature(received, examined, null, null);
    return await store(received, { ...examined, channel, actor });
  } catch (err) {
    // Deliberately NOT removing the file: a commit refused because the catalog moved is worth
    // retrying after the operator fixes the cause, and losing the bytes would mean re-sending
    // the whole bundle. The pruner reclaims it either way.
    throw err;
  }
}

/**
 * One-shot upload: receive, check, store, point a channel at it — all in one call.
 *
 * Kept for CI, which wants a single command and is not going to look at a preview. The web UI
 * uses the two-step form below instead.
 */
export async function uploadArtifact(req, {
  version, platforms, kind, channel, expectedSha256, signature = null, publishedAt = null, actor,
}) {
  const received = await receiveToTempFile(req, {
    dir: TEMP_DIR(), limit: config.uploadMaxBytes,
  });

  try {
    const examined = await examine(received, { version, platforms, kind, expectedSha256 });
    await checkSignature(received, examined, signature, publishedAt);
    return await store(received, { ...examined, channel, signature, publishedAt, actor });
  } catch (err) {
    await fsp.rm(received.tempPath, { force: true })
      .catch((rmErr) => logger.error('could not remove the upload temp file', rmErr));
    throw err;
  }
}

/**
 * Refuse a signature this server cannot verify, before anything is committed.
 *
 * Runs AFTER examine(), because only then are size, sha256 and the canonical target known —
 * they are four of the six fields the signature covers. Rejecting here rather than at serve
 * time is the whole value of the check: a release no node could verify becomes impossible to
 * publish, instead of a fleet-wide outage discovered when an operator presses Check.
 */
async function checkSignature(received, examined, signature, publishedAt) {
  if (!signature) {
    if (config.signingRequirePresigned) {
      throw invalidParameter(
        'SIGNING_REQUIRE_PRESIGNED is set: this server holds no signing key, so an artifact '
        + 'must arrive signed by the release pipeline',
      );
    }
    return;
  }

  // One release, one published_at: every platform's artifact signs the same string, so a
  // second upload has to match what the release already carries.
  // mapRelease already hands back an RFC3339 string trimmed to seconds, which is the exact
  // form the signer used.
  const existing = await catalog.getRelease(examined.version);
  if (existing?.publishedAt && existing.publishedAt !== publishedAt) {
    throw conflict(
      `Release ${examined.version} was published at ${existing.publishedAt}, but this upload `
      + `signed ${publishedAt}. Every artifact of a release signs the same published_at.`,
    );
  }

  const fields = {
    version: examined.version,
    size: received.size,
    sha256: received.sha256,
    target: canonicalTarget(examined.platforms),
    minVersion: examined.inspection.release.minVersion ?? null,
    publishedAt,
  };

  const pub = config.signingTrustedKeys.get(signature.key_id);
  if (!verifyWithPublicKey(fields, signature.value, pub)) {
    throw invalidParameter(
      `signature does not verify under key_id "${signature.key_id}". The signed payload is `
      + 'version\\nsize\\nsha256\\ntarget\\nmin_version\\npublished_at, newline-joined with no '
      + `trailing newline — here that is ${JSON.stringify(fields)}`,
    );
  }
}

async function store(received, {
  inspection, version, kind, platform, platforms, channel, system, signature, publishedAt, actor,
}) {
  const file = kind === 'fleet' ? 'fleet.tar.gz' : `${platform}.tar.gz`;
  const finalPath = catalog.artifactPath(version, file);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  // Same filesystem, so this is atomic: a downloader sees either the old file or the new one.
  await fsp.rename(received.tempPath, finalPath);

  try {
    const { id, releaseCreated, promoted } = await withTransaction(async (client) => {
      // The bundle version is machine-generated and has already been checked against every
      // core slice, so it is a better source than anything typed into a URL. A release is
      // invisible to every node until a channel points at it.
      // min_version / notes / mandatory come from an optional release.json in the bundle —
      // the only release metadata the bundle manifest has no place for. Applied on creation
      // only, so a later artifact cannot silently rewrite what an operator has since edited.
      // published_at comes from the signer when there is one: it is a SIGNED field, and a
      // value this server invented after the upload is one CI could not have signed over.
      const release = await client.query(
        `INSERT INTO release (version, version_key, system, min_version, mandatory, notes,
                              published_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($8::timestamptz, now()), $7)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
        [
          version, parseVersion(version), system,
          inspection.release.minVersion, inspection.release.mandatory, inspection.release.notes,
          actor, publishedAt,
        ],
      );
      const created = release.rowCount > 0;
      if (created) {
        await insertAudit({
          actor,
          action: 'release.create',
          subject: version,
          detail: { auto: true, system, ...inspection.release },
        }, client);
      }

      const inserted = await client.query(
        `INSERT INTO artifact
           (version, kind, platform, platforms, file, size, sha256, uploaded_by,
            bundle_format, inspection,
            signature_alg, signature_key_id, signature_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          version, kind, platform, platforms, file, received.size, received.sha256, actor,
          inspection.format, JSON.stringify(serializeInspection(inspection)),
          // Columns that have existed since 001_init and, until now, nothing ever wrote.
          signature?.alg ?? null, signature?.key_id ?? null, signature?.value ?? null,
        ],
      );
      const artifactId = Number(inserted.rows[0].id);

      // Per-plugin versions are not in the bundle manifest (spec section 5), but they ARE in
      // each plugin's own slice manifest — which is the only place the plan can get them.
      for (const plugin of inspection.plugins) {
        if (plugin.version === null) continue;
        await client.query(
          `INSERT INTO artifact_plugin
             (artifact_id, platform, name, version, version_known, source)
           VALUES ($1,$2,$3,$4,$5,'bundle')`,
          [artifactId, plugin.platform, plugin.name, plugin.version, plugin.versionKnown],
        );
      }

      // The params each config component sets, read out of its slim payload. A config
      // component is platform-independent — the node applies it whatever platform it is —
      // so it is recorded against every platform this artifact covers.
      for (const entry of inspection.configs) {
        for (const change of entry.params) {
          for (const p of platforms) {
            await client.query(
              `INSERT INTO artifact_config (artifact_id, platform, target, param, value)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (artifact_id, platform, target, param) DO UPDATE SET value = $5`,
              [artifactId, p, entry.target, change.param, JSON.stringify(change.value)],
            );
          }
        }
      }

      await insertAudit({
        actor,
        action: 'artifact.upload',
        subject: `${version}/${file}`,
        detail: {
          kind,
          platform,
          platforms,
          size: received.size,
          sha256: received.sha256,
          format: inspection.format,
          warnings: inspection.warnings.length,
        },
      }, client);

      // Promote in the same transaction: an artifact that is published but not reachable is
      // a half-done release, and the operator asked for one action, not two.
      let promoted = null;
      let released = [];
      if (channel) {
        // Same invariant upsertChannel keeps: one release runs on one channel. Re-uploading an
        // artifact for a version another channel already serves would otherwise put it on two.
        const { rows } = await client.query(
          `UPDATE channel SET latest = NULL, updated_at = now()
           WHERE system = $1 AND name <> $2 AND latest = $3
           RETURNING name`,
          [system, channel, version],
        );
        released = rows.map((row) => row.name);

        // A channel belongs to one system: its latest names one version, and a version
        // belongs to one system, so a global "stable" could not serve two.
        //
        // Created if absent. A channel is only a pointer, so inventing one costs nothing and
        // is the difference between a first upload landing somewhere and failing — unlike a
        // system, which is a version line and must be created deliberately.
        await client.query(
          `INSERT INTO channel (system, name, latest, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (system, name) DO UPDATE SET latest = $3, updated_at = now()`,
          [system, channel, version],
        );
        await insertAudit({
          actor,
          action: 'channel.update',
          subject: `${system}/${channel}`,
          detail: released.length
            ? { latest: version, system, auto: true, released }
            : { latest: version, system, auto: true },
        }, client);
        promoted = channel;
      }

      await catalog.bumpRevision(client);
      return { id: artifactId, releaseCreated: created, promoted };
    });

    logger.info(
      `published ${version} ${kind} ${platform ?? ''} (${received.size} bytes, `
      + `${inspection.format}, ${inspection.warnings.length} warnings) by ${actor}`
      + (promoted ? ` and promoted to ${promoted}` : ''),
    );

    const artifact = await catalog.findArtifactById(id);
    return { artifact, inspection, releaseCreated, promoted, system };
  } catch (err) {
    // The advisory SELECT in uploadArtifact is a TOCTOU window: two uploads of one version can
    // both pass it and both reach this INSERT, where the unique index stops the second. That
    // is the index working, not a server fault — 409 says "someone got there first", while the
    // 500 this used to raise says "the server is broken" and invites a retry that cannot win.
    if (err?.code === UNIQUE_VIOLATION) {
      // Deliberately NOT removing finalPath. Both uploads renamed onto the same path, so it
      // now belongs to the upload whose row committed; deleting it here left that row pointing
      // at nothing, and the catalog offering a release whose bytes were gone.
      throw conflict(
        `An artifact for ${version} ${kind}${platform ? ` ${platform}` : ''} `
        + 'was uploaded concurrently.',
      );
    }

    // Our rows never landed and nobody else claimed the path, so the file must not survive.
    await fsp.rm(finalPath, { force: true })
      .catch((rmErr) => logger.error('could not roll back the uploaded file', rmErr));
    throw err;
  }
}

/** What goes into artifact.inspection — the report, minus the errors that never happened. */
/**
 * The inspection report as the admin API returns it.
 *
 * Exported because the upload response and GET /artifacts/:id must describe an artifact the
 * same way. They used to each carry their own copy of this mapping, which meant every new
 * field had to be added twice and silently drifted when it was not.
 */
export function serializeInspection(inspection) {
  return {
    format: inspection.format,
    version: inspection.version,
    platforms: inspection.platforms,
    cores: inspection.cores.map((core) => ({
      platform: core.platform,
      path: core.path,
      slice_version: core.sliceVersion,
      // The system this slice was stamped for; what a bundled plugin has to cover.
      system: core.system ?? null,
      bundled_plugins: (core.bundledPlugins ?? []).map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        version_known: plugin.versionKnown,
        systems: plugin.declaredSystems ?? [],
      })),
      shipped_config: core.shippedConfig ?? [],
    })),
    plugins: inspection.plugins.map((plugin) => ({
      name: plugin.name,
      platform: plugin.platform,
      path: plugin.path,
      version: plugin.version,
      version_known: plugin.versionKnown,
      // Which products this plugin is valid on. Empty means "everything" — the same reading
      // system_covers() gives it on the node.
      systems: plugin.declaredSystems ?? [],
      shipped_config: plugin.shippedConfig ?? [],
    })),
    configs: inspection.configs,
    release: inspection.release,
    warnings: inspection.warnings,
  };
}

export function tempDir() {
  return TEMP_DIR();
}
