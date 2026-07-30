import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { signingPayload } from '../domain/manifest.js';
import { certPayload } from '../domain/keycert.js';
import { loadOrCreateKeyPair } from '../repositories/signingKey.repository.js';

let keys = null;

export async function initSigning() {
  // With every artifact pre-signed there is nothing left for this server to sign, so it
  // holds no private key and this is a no-op. Signing then lives only in the release
  // pipeline, which is where section 10 says it belongs.
  if (config.signingRequirePresigned) return null;

  if (!keys) {
    keys = await loadOrCreateKeyPair(config.signingKeyFile,
                                     { autogen: config.signingKeyAutogen });
    if (keys.generated) {
      logger.warn(`Generated a new Ed25519 signing key at ${config.signingKeyFile}. `
        + 'Every node still holding the previous key will now reject this server\'s '
        + 'manifests with signature_invalid until it is reprovisioned.');
    }
  }
  return keys;
}

export function getKeyId() {
  return config.keyId;
}

export function getPublicKeyBase64() {
  if (!keys) throw new Error('signing is not initialised');
  return keys.publicKeyBase64;
}

/** Log the exact string an operator must provision into a node's key_id -> key map. */
export function logSigningKey() {
  logger.info(`OTA signing key_id: ${config.keyId}`);
  logger.info(`OTA public key (base64, 32 bytes): ${getPublicKeyBase64()}`);
  logger.info(`OTA private key file: ${config.signingKeyFile}`);
}

/**
 * Sign the six-field payload of spec section 7. This is the only place a signature is
 * produced, and it takes exactly the values that go into the manifest body.
 */
export function signManifest(fields) {
  if (!keys) throw new Error('signing is not initialised');
  const value = crypto.sign(null, signingPayload(fields), keys.privateKey).toString('base64');
  return { alg: 'ed25519', key_id: config.keyId, value };
}

/** Test/introspection helper: verify a signature with our own public key. */
export function verifyManifest(fields, signatureBase64) {
  if (!keys) throw new Error('signing is not initialised');
  return crypto.verify(
    null, signingPayload(fields), keys.publicKey, Buffer.from(signatureBase64, 'base64'),
  );
}

/**
 * Verify a signature made elsewhere, against a public key given as raw base64.
 *
 * This is what lets the server check a PRE-SIGNED artifact whose private half it does not
 * have. Refusing at the upload gate is worth far more than detecting later: a release no
 * node could verify becomes impossible to publish, instead of a fleet-wide outage that only
 * shows up when someone presses Check.
 */
export function verifyWithPublicKey(fields, signatureBase64, publicKeyBase64) {
  let raw;
  try {
    raw = Buffer.from(publicKeyBase64, 'base64');
  } catch {
    return false;
  }
  if (raw.length !== 32) return false;
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, signingPayload(fields), pub,
                         Buffer.from(signatureBase64, 'base64'));
  } catch {
    // Malformed key or signature material fails closed rather than throwing out of an
    // upload handler.
    return false;
  }
}

/**
 * Verify a key certificate against the configured ROOT public key.
 *
 * Run before storing one. A certificate this server cannot verify is a certificate no node
 * could verify either, so accepting it would publish manifests the whole fleet rejects —
 * and `keycert_invalid` on a device looks identical to a compromised key.
 *
 * The root's PRIVATE half is never here; this only ever reads the public one.
 */
export function verifyKeyCertificate(cert) {
  if (!config.rootKeyId || !config.rootPublicKey) {
    return { ok: false, reason: 'SIGNING_ROOT_KEY_ID / SIGNING_ROOT_PUBLIC_KEY are not configured' };
  }
  if (cert.rootKeyId !== config.rootKeyId) {
    return {
      ok: false,
      reason: `certificate names root "${cert.rootKeyId}" but this server is configured with `
        + `"${config.rootKeyId}"`,
    };
  }
  if (Buffer.from(cert.publicKey, 'base64').length !== 32) {
    return { ok: false, reason: 'public_key must be base64 of 32 raw ed25519 bytes' };
  }
  if (Buffer.from(cert.certValue, 'base64').length !== 64) {
    return { ok: false, reason: 'value must be base64 of a 64-byte ed25519 signature' };
  }

  let rootPub;
  try {
    rootPub = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
                          Buffer.from(config.rootPublicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { ok: false, reason: 'SIGNING_ROOT_PUBLIC_KEY is not a valid ed25519 public key' };
  }

  const ok = crypto.verify(null, certPayload(cert), rootPub,
                           Buffer.from(cert.certValue, 'base64'));
  return ok
    ? { ok: true }
    : {
      ok: false,
      reason: 'the root signature does not verify. The signed payload is '
        + 'key_id\\npublic_key\\nnot_before\\nnot_after, newline-joined with no trailing newline',
    };
}

export function resetSigningForTests() {
  keys = null;
}
