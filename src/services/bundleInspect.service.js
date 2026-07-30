import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { TarError, readTarGz } from '../core/tar.js';
import { invalidBundle, invalidParameter } from '../core/errors.js';
import { crossCheck, inspectBundle, isInspectableMember } from '../domain/bundle.js';

/**
 * Open an uploaded .tar.gz and decide whether it is a bundle we are willing to publish.
 *
 * The server is the only place these mistakes are cheap. The node's apply path sets ok = true
 * unconditionally and reports per-component skips with no top-level error, so a malformed
 * bundle reaches the whole fleet looking like a success.
 */

const CONTAINER_MESSAGES = {
  not_gzip: 'The uploaded file is not a gzip archive. Expected a .tar.gz produced by '
    + 'package_update_bundle.sh.',
  not_tar: 'The gzip stream does not contain a tar archive.',
  truncated: 'The tar archive is truncated: it ends in the middle of a member. Re-upload the '
    + 'file.',
  too_many_entries: 'The archive has far more members than an AeroCore update bundle could '
    + 'have.',
  inflate_budget: 'The archive expands far beyond its compressed size; refusing to inspect '
    + 'it.',
};

/**
 * @param {string} filePath  the received temp file
 * @param {{version?: string|null, platforms?: string[]|null, kind?: string|null}} asserted
 * @returns {Promise<import('../domain/bundle.js').Inspection>}
 */
export async function inspectArtifact(filePath, asserted = {}) {
  const scan = await scanArchive(filePath);

  const json = new Map();
  const unparseable = new Set();
  const sizes = new Map();

  for (const [name, body] of scan.files) {
    sizes.set(name, body.length);
    try {
      json.set(name, JSON.parse(body.toString('utf8')));
    } catch {
      unparseable.add(name);
    }
  }

  const inspection = inspectBundle({
    names: scan.names,
    json,
    unparseable,
    sizes,
    oversize: scan.oversize,
    refuseConfigLifeline: config.refuseConfigLifeline,
  });

  inspection.errors.push(...crossCheck(inspection, asserted));

  if (inspection.errors.length) throw invalidBundle(inspection.errors);

  for (const warning of inspection.warnings) {
    logger.warn(`bundle ${inspection.version}: ${warning.rule} — ${warning.message}`);
  }

  return inspection;
}

async function scanArchive(filePath) {
  try {
    return await readTarGz(filePath, {
      select: isInspectableMember,
      // A gzip bomb would otherwise inflate for as long as we let it.
      maxInflatedBytes: config.uploadMaxBytes * 20,
    });
  } catch (err) {
    if (err instanceof TarError) {
      throw invalidParameter(CONTAINER_MESSAGES[err.code] ?? err.message);
    }
    throw err;
  }
}
