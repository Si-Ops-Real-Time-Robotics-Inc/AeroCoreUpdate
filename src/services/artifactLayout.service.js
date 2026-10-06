import fsp from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../core/logger.js';
import * as catalog from '../repositories/catalog.repository.js';

/**
 * Move artifact files from <root>/<version>/ to <root>/<system>/<version>/.
 *
 * Migration 012 let two systems publish the same version number, and the old layout had one
 * directory per number — the second system's upload would have renamed its bytes over the
 * first's. The rows were re-keyed in SQL; the files can only be moved from here.
 *
 * Runs at every boot and does nothing once there is nothing left to move, so a deployment
 * never has to remember a one-off step. A file already at its new path is left alone, and a
 * row whose file is in neither place is not this function's problem — the catalog already
 * reports it as unreadable.
 *
 * Not in a transaction with anything: rename is atomic per file, and a crash halfway leaves
 * some files moved and some not, which the next boot finishes.
 */
export async function moveLegacyArtifacts() {
  let moved = 0;
  const emptied = new Set();

  for (const { system, version, file } of await catalog.listAllArtifactFiles()) {
    const target = catalog.artifactPath(system, version, file);
    if (await exists(target)) continue;

    const legacy = catalog.legacyArtifactPath(version, file);
    if (!await exists(legacy)) continue;

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(legacy, target);
    emptied.add(path.dirname(legacy));
    moved += 1;
  }

  // Only directories this run emptied, and only if they really are empty — rmdir refuses
  // otherwise, which is the point: anything else in there is not ours to throw away.
  for (const dir of emptied) await fsp.rmdir(dir).catch(() => {});

  if (moved) logger.info(`moved ${moved} artifact file(s) into the per-system layout`);
  return moved;
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
