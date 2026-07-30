/**
 * The signed payload and the manifest body, per update-server-api.md section 7.
 *
 * What is signed is NOT the JSON. Canonical-JSON schemes invite two implementations
 * disagreeing about key order, whitespace and number formatting, and the failure is silent.
 * Instead: a fixed-order, newline-delimited payload of exactly six fields.
 *
 * Both functions are called from one place (manifest.service.js) with one object, so the
 * manifest can never disagree with what was signed.
 */

/**
 * version \n size \n sha256 \n target \n min_version \n published_at
 *
 * Exactly six fields, joined by \n, NO trailing newline. An absent optional field
 * contributes the empty string so the separators are still present.
 */
export function signingPayload({ version, size, sha256, target, minVersion, publishedAt }) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError(`size must be a non-negative safe integer, got ${size}`);
  }
  return Buffer.from(
    [version, String(size), sha256, target, minVersion ?? '', publishedAt ?? ''].join('\n'),
    'utf8',
  );
}

/**
 * The manifest JSON, in the field order of section 2. Optional fields are omitted when
 * absent here, while signingPayload still contributes '' for them — that asymmetry is the
 * documented "two trailing separators" case.
 */
export function buildManifestBody({
  version, url, size, sha256, target,
  minVersion, mandatory = false, notes, publishedAt, signature, keyCertificate,
  channels, system,
}) {
  const body = { update_available: true, version, url, size, sha256, target };
  if (minVersion) body.min_version = minVersion;
  body.mandatory = Boolean(mandatory);
  if (notes) body.notes = notes;
  if (publishedAt) body.published_at = publishedAt;
  body.signature = signature;
  // A sibling of `signature`, outside everything signingPayload covers — same placement and
  // same reasoning as `channels` and `system` below. Omitted entirely when no certificate has
  // been uploaded for this key, which is what keeps older deployments unchanged.
  if (keyCertificate) body.key_certificate = keyCertificate;
  // Both sit outside everything signingPayload covers; see the note on withChannels.
  if (system) body.system = system;
  withChannels(body, channels);
  return body;
}

/** The no-update shape. Still 200 with a body — the node's client treats any other status
 *  as an error and never parses it, so a 204 here would read as a broken server. */
export function noUpdate(channels) {
  return withChannels({ update_available: false }, channels);
}

/**
 * The channels this node's system has, so the device can offer the real list.
 *
 * A flat array of names, on BOTH response shapes. The node reads it with
 * `UpdateClient.cpp` (`c.is_string()` only, so objects would be dropped) and
 * `UpdateService::sync_channel_options` writes them into `update.channel`'s `options` —
 * which is why a node sitting on a channel this server does not have can be corrected at all.
 *
 * Placed OUTSIDE everything signingPayload covers. The signature is over six fixed fields;
 * adding a sibling key changes no signed byte, and must never be made to.
 */
function withChannels(body, channels) {
  if (channels?.length) body.channels = channels;
  return body;
}
