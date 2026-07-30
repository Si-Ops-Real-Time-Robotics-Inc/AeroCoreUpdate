import { buildManifestBody } from '../domain/manifest.js';
import { certBody } from '../domain/keycert.js';
import { canonicalTarget } from '../domain/platform.js';
import { findByKeyId } from '../repositories/signingKeyCert.repository.js';
import { signManifest, verifyWithPublicKey } from './signing.service.js';
import { config } from '../config/index.js';
import { logger } from '../core/logger.js';

/**
 * The single place a manifest is produced. buildManifestBody and signManifest are called
 * with one object, so the JSON can never disagree with what was signed.
 */
export async function buildManifest({ release, artifact, platforms, url, channels, system }) {
  // `fields` is exactly what gets signed. Nothing else may join it — see section 7.
  const fields = {
    version: release.version,
    size: artifact.size,
    sha256: artifact.sha256,
    target: canonicalTarget(platforms),
    minVersion: release.minVersion ?? null,
    publishedAt: release.publishedAt ?? null,
  };

  // A pre-signed artifact keeps the private key out of this server entirely (section 10).
  const signature = artifact.signature ?? signManifest(fields);

  // Backstop: never serve a pre-signed manifest whose signature does not cover the fields
  // about to go on the wire. Anything that edited a signed field without going through the
  // guard in catalogAdmin.updateRelease would otherwise strand every node that fetched this.
  // One Ed25519 verify, only on the update-available path.
  if (artifact.signature) {
    const pub = config.signingTrustedKeys.get(artifact.signature.key_id);
    if (!pub || !verifyWithPublicKey(fields, artifact.signature.value, pub)) {
      logger.error(
        `Refusing to serve ${release.version}: its stored signature does not verify over the `
        + `manifest fields (key_id ${artifact.signature.key_id}). A signed field was changed `
        + 'after upload, or the key is no longer trusted here.',
      );
      return null;
    }
  }

  // The root-signed statement that `signature.key_id` is genuine, when one has been uploaded
  // for it. Sent only when it exists: a node with no roots ignores it, and a node with roots
  // falls back to direct trust when it is absent, so this is additive in both directions and
  // needs no coordinated rollout.
  const cert = await findByKeyId(signature.key_id);

  return buildManifestBody({
    ...fields,
    url: absolute(url),
    mandatory: release.mandatory,
    notes: release.notes ?? null,
    signature,
    keyCertificate: cert ? certBody(cert) : null,
    // Alongside the signature, never inside it. Carried on this shape as well as the no-update
    // one so a node syncs its channel list whether or not it has an update waiting.
    channels,
    // Which product this answer is for. Says out loud what the URL already encodes, so a log
    // line or a support ticket does not need the catalog to be readable.
    system,
  });
}

/** Relative URLs are legal (section 2); PUBLIC_BASE_URL makes them absolute when set. */
function absolute(url) {
  if (!config.publicBaseUrl) return url;
  return `${config.publicBaseUrl.replace(/\/+$/, '')}${url}`;
}
