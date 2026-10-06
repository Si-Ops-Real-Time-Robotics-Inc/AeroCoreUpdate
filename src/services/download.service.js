import fsp from 'node:fs/promises';

import { config } from '../config/index.js';
import { forbidden, notFound } from '../core/errors.js';
import * as catalog from '../repositories/catalog.repository.js';

/**
 * Resolve the bytes for GET /api/v1/update/download/{version} (spec section 6).
 *
 * With a `platform` this serves ONLY the slim artifact, never falling back to the fleet
 * bundle: a fallback would hand over bytes whose size and sha256 differ from the manifest
 * the node already holds, and the node would fail its own integrity check.
 */
export async function resolveArtifact(version, platform, system, { channels = null } = {}) {
  // System and version together name one release — two systems may share a number (migration
  // 012). Platform then picks the bytes and is checked against what the package covers. These
  // bytes are a firmware image: a device handed another product's core has its plugin set and
  // its config replaced in one step, and a device handed a package with no variant for its
  // platform installs nothing while reporting success.
  const release = await catalog.getRelease(system, version);
  if (!release) {
    // 404 rather than 403 — "wrong system" and "no such version" are the same answer to a
    // caller with no business here, and telling them apart would leak which version numbers
    // other systems use.
    throw notFound(`No artifact for ${version} in system ${system}`);
  }

  // A staged artifact is never offered by /check, but this endpoint resolves by version, so
  // without this gate anyone holding a fleet key could fetch an unpublished build by guessing
  // its number. They could not make a node apply it — that needs a signed manifest — but the
  // bytes would still be readable.
  if (config.downloadRequiresChannel) {
    const reachable = await catalog.reachableVersions(system);
    if (!reachable.has(version)) throw notFound(`No artifact for ${version}/${platform}`);
  }

  // A credential restricted to certain channels may fetch only what those channels serve
  // right now. Deliberately a 403 that says so, not the 404 above: this caller is a known
  // device asking for a real build, and "no such artifact" would send its operator hunting
  // for a missing file instead of at the credential they need to change.
  if (channels) {
    const allowed = await catalog.reachableVersions(system, { names: channels });
    if (!allowed.has(version)) {
      throw forbidden(
        `This credential serves ${channels.join(', ')} only, and ${version} is not what `
        + `${channels.length === 1 ? 'that channel points' : 'those channels point'} at.`,
      );
    }
  }

  // Prefer the slim artifact built for exactly this platform; fall back to a fleet artifact,
  // but only one that actually covers it. Serving a package with no matching variant is the
  // `no_variant_for_platform` skip — non-fatal on the node, so the update would report success
  // having changed nothing.
  let artifact = await catalog.findArtifact(system, version, 'slim', platform);
  if (!artifact) {
    const fleet = await catalog.findArtifact(system, version, 'fleet');
    if (fleet?.platforms.includes(platform)) artifact = fleet;
  }
  if (!artifact) throw notFound(`No artifact for ${version}/${platform}`);

  const filePath = catalog.artifactPath(system, version, artifact.file);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw notFound(`No artifact for ${version}/${platform}`);
  }

  return {
    filePath,
    size: stat.size,
    sha256: artifact.sha256,
    // Content-addressed, so republishing a version under the same name invalidates caches.
    etag: `"pkg-${system}-${version}-${platform}-${artifact.sha256.slice(0, 8)}"`,
    filename: `aerocore-${version}-${platform}.tar.gz`,
  };
}

/**
 * Are the bytes actually on disk?
 *
 * A row whose file has gone is invisible from every other angle: the catalog lists the release,
 * a channel points at it, and every node is simply told there is no update — the check path
 * declines to offer what it cannot read. Shared with the admin catalog so an operator sees the
 * same fact the fleet is silently acting on.
 */
export async function artifactReadable(artifact) {
  try {
    await fsp.access(catalog.artifactPath(artifact.system, artifact.version, artifact.file));
    return true;
  } catch {
    return false;
  }
}
