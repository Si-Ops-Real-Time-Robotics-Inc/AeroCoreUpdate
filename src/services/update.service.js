import fsp from 'node:fs/promises';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { noUpdate } from '../domain/manifest.js';
import { isNewer } from '../domain/version.js';
import * as catalog from '../repositories/catalog.repository.js';
import { buildManifest } from './manifest.service.js';
import { artifactReadable } from './download.service.js';
import { assignedSystem, findSystem, recordUnclassified, soleSystem, systemForVersion }
  from '../repositories/system.repository.js';

/**
 * The check endpoints (spec sections 2 and 3).
 *
 * A withheld update and an up-to-date node look identical to a node: both are
 * {"update_available": false}. An unknown channel and a channel handing out nothing both
 * take that same path rather than an error, exactly as section 2 requires.
 */

export async function checkSingleNode({
  serial, platform, version, system: reported, channel: channelName, fleet,
}) {
  const rev = await catalog.getRevision();

  // Which kind of device is asking. Everything below is scoped to it — a drone must never be
  // offered a GCS release, and the two have independent version lines.
  const system = await resolveSystem({
    serial, platform, version, system: reported, channel: channelName, fleet,
  });
  if (!system) {
    // No system means no channels either: there is no correct list to send.
    return {
      etag: buildEtag({ offered: null, platform, channel: channelName, kind: null, rev }),
      body: noUpdate(),
      offered: null,
      system: null,
    };
  }

  // The channels this node may pick from. Sent on BOTH shapes below, because a node stuck on
  // a channel this server does not have is exactly the node that never gets an update — and
  // it is the no-update shape it keeps receiving.
  const channels = await channelNames(system);

  const decision = await decide({ serial, platform, version, channelName, system });

  const etag = buildEtag({
    offered: decision.offered, platform, channel: channelName, kind: decision.kind, rev, system,
    channels,
  });

  if (!decision.artifact) return { etag, body: noUpdate(channels), offered: null, system };

  // The system rides in the URL the server hands out, so every node asks for bytes of the
  // product it was placed in without a single client change — the node fetches this string
  // verbatim. `url` is not covered by the signature, so adding to it breaks nothing.
  // Always both parameters, whatever kind of artifact was chosen: the download validates the
  // node's platform against what the package covers, so a fleet artifact needs it too.
  const url = `/api/v1/update/download/${decision.release.version}`
    + `?platform=${encodeURIComponent(platform)}&system=${encodeURIComponent(system)}`;

  const body = await buildManifest({
    release: decision.release,
    artifact: decision.artifact,
    platforms: decision.artifact.platforms,
    url,
    channels,
    system,
  });

  // buildManifest refuses a pre-signed artifact whose stored signature no longer covers what
  // is about to be served. Answer "no update" instead of handing out something every node
  // would reject: a node left on its current version is recoverable, and the server log
  // names the release. Withholding is already an ordinary outcome here (section 2).
  //
  // The etag is dropped with it — caching "no update" under the key that means "0.14.0 is
  // available" would keep serving that answer after the release is repaired.
  if (body === null) return { etag: null, body: noUpdate(channels), offered: null, system };

  return { etag, body, offered: decision.release.version, system };
}

/**
 * Which system this node belongs to. Everything else — channel, pin, rollout, the release
 * itself — is scoped to the answer, so nothing can be decided before it.
 *
 * The node now tells us directly: UpdateClient::check sends `system` from its own runtime
 * manifest whenever the build was stamped. That is evidence, not an instruction. In order:
 *
 *   1. an assignment an operator made for this serial — a human already decided
 *   2. the system the node claims, when it exists and nothing contradicts it
 *   3. the system of the release carrying the node's version
 *   4. the only system there is
 *
 * Two cases deliberately produce nothing rather than a guess, and are recorded instead:
 * a claim naming a system this server does not have, and a claim that contradicts the version
 * the node is running. Handing a node another system's core swaps its plugin set and its
 * config in one step, and the node applies it as a silent non-fatal skip — so a wrong answer
 * here is worse than no answer.
 */
async function resolveSystem(node) {
  // 1. An operator's assignment outranks everything, including a node contradicting itself:
  //    placing it is exactly the decision this asks a human to make.
  const assigned = await assignedSystem(node.serial);
  if (assigned) {
    // Still record the sighting, so the admin sees it is alive and on which version.
    recordUnclassified(node, node.fleet);
    return assigned;
  }

  const fromVersion = await systemForVersion(node.version);

  // 2. What the node says about itself.
  if (node.system) {
    if (!await findSystem(node.system)) {
      logger.warn(
        `node ${node.serial ?? '(no serial)'} reports system "${node.system}", which does not `
        + 'exist here; offering no update until an admin places it or creates that system',
      );
      recordUnclassified(node, node.fleet);
      return null;
    }

    if (fromVersion && fromVersion !== node.system) {
      // One of the two is wrong and there is no way to tell which: a node just moved between
      // systems reports the newer truth, while a mis-stamped build reports a lie, and both
      // look like this. Picking either would be a guess with fleet-wide consequences.
      logger.warn(
        `node ${node.serial ?? '(no serial)'} reports system "${node.system}" but its version `
        + `${node.version} belongs to "${fromVersion}"; offering no update until an admin `
        + 'resolves it',
      );
      recordUnclassified(node, node.fleet);
      return null;
    }

    return node.system;
  }

  // 3. No claim: fall back to the version line it is on.
  if (fromVersion) return fromVersion;

  // 4. A device flashed at the factory reports a version this server never published, so on a
  //    brand-new fleet the version lookup places nobody. With one system there is nothing to
  //    confuse it with and no wrong answer, so it is placed rather than parked — otherwise
  //    standing up a fleet would mean confirming the same decision once per device. This does
  //    NOT rescue a wrong claim above: an explicit wrong name is a fault, not a blank.
  const sole = await soleSystem();
  if (sole) return sole;

  logger.warn(
    `unclassified node ${node.serial ?? '(no serial)'} on ${node.version} `
    + `(${node.platform}): no release carries that version, no system is assigned, and more `
    + 'than one system exists; offering no update until an admin places it',
  );
  recordUnclassified(node, node.fleet);
  return null;
}

async function decide({ serial, platform, version, channelName, system }) {
  const none = { artifact: null, offered: null, kind: null, release: null };

  const channel = await catalog.getChannel(system, channelName);
  if (!channel) {
    logger.info(`check: no channel "${channelName}" in system "${system}" for ${serial}`);
    return none;
  }
  const offered = channel.latest;
  if (!offered) return none;

  // The offered version must be strictly newer by section 1 ordering. This also blocks a
  // downgrade from a stale pin.
  if (!isNewer(offered, version)) return none;

  const release = await catalog.getRelease(offered);
  if (!release) {
    logger.error(`channel ${channelName} points at missing release ${offered}`);
    return none;
  }

  if (release.minVersion && isNewer(release.minVersion, version)) {
    // Section 8 puts enforcement on the node, so still offer — but make the gap visible.
    logger.warn(
      `${serial} is on ${version}, below min_version ${release.minVersion} of ${offered}; `
      + 'it will refuse this update until an intermediate release is published',
    );
  }

  let artifact = await catalog.findArtifact(offered, 'slim', platform);
  let kind = 'slim';

  if (!artifact && config.slimFallbackToFleet) {
    // Section 4 tells operators to publish one bundle covering every platform. Without this
    // fallback such a server answers "no update" forever for everyone.
    const fleet = await catalog.findArtifact(offered, 'fleet');
    if (fleet && fleet.platforms.includes(platform)) {
      artifact = fleet;
      kind = 'fleet';
    }
  }

  if (!artifact) return none;
  if (!await artifactReadable(artifact)) {
    logger.error(`artifact file missing for ${offered}/${artifact.file}`);
    return none;
  }

  return { artifact, offered, kind, release };
}

/**
 * The channels a node may ask for (spec section 2b).
 *
 * `update.channel` on the device is a free-text string an operator types. Ask for one that
 * does not exist for this node's system and the answer is a valid, protocol-correct 204 —
 * identical to being up to date, with no error shown anywhere. One device then stops updating
 * for good and nothing says why.
 *
 * This endpoint exists so the device can offer a list instead of a text box. It reports the
 * node's OWN system only: which channels another product runs is not a node's business, and
 * a picker showing them would invite exactly the mistake it is meant to prevent.
 *
 * Placement is the same as a check, deliberately — a node the server cannot place has no
 * channels, because channels are per system and it has no system yet.
 */
/**
 * Just the names, in the shape the node parses.
 *
 * Paused channels are included: the name is still a valid thing to select, and one that
 * quietly vanished from the device's dropdown would be the same silent failure in a new place.
 */
async function channelNames(system) {
  const channels = await catalog.listChannels(system);
  return channels.map((channel) => channel.name);
}

/**
 * Section 2 requires the ETag to be a function of everything that affects the response.
 * `rev` covers pauses, pins, denies and new uploads; serial-specific decisions are already
 * folded in because they change `offered`.
 */
function buildEtag({ offered, platform, channel, kind, rev, system, channels }) {
  // `channels` is part of the response, so it has to be part of the tag. rev bumps on a
  // channel upsert, but not on a delete, and a node holding a 304 would keep offering a
  // dropdown with a channel that no longer exists.
  const list = channels?.length ? channels.join('.') : 'none';
  return `"chk-${system ?? 'none'}-${offered ?? 'none'}-${platform}-${channel}-${kind ?? 'none'}-${list}-${rev}"`;
}
