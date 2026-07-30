import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * The Ed25519 signing key lives in a file, deliberately NOT in the database: a private key
 * in Postgres leaks with every backup, while a 0600 file on a volume has a much smaller
 * surface. See spec section 10.
 */
export async function loadOrCreateKeyPair(filePath, { autogen = false } = {}) {
  let pem = await read(filePath);
  let generated = false;

  if (pem === null) {
    // Silently minting a replacement is how a fleet gets stranded: the new key goes out
    // under the SAME key_id, so every node finds the id, fails the crypto, and reports
    // `signature_invalid` — indistinguishable from a tampered manifest, with one [WARN]
    // line as the only trace. An empty volume (a `docker compose down -v`, a fresh
    // deploy) is enough to trigger it.
    //
    // A server that cannot sign correctly must not serve manifests nobody can verify.
    // Refuse to start instead, and make generation an explicit opt-in for dev and CI.
    if (!autogen) {
      throw new Error(
        `No signing key at ${filePath}, and SIGNING_KEY_AUTOGEN is off. Restore the key from `
        + 'backup, or set SIGNING_KEY_AUTOGEN=1 to mint a new one. Generating silently would '
        + 'publish manifests under the same key_id that no deployed node can verify.',
      );
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const pair = crypto.generateKeyPairSync('ed25519');
    pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

    try {
      // 'wx' fails if the file appeared meanwhile, which is what guarantees a restart (or a
      // racing process) never replaces an existing key.
      await fsp.writeFile(filePath, pem, { mode: 0o600, flag: 'wx' });
      generated = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      pem = await read(filePath);
    }
  }

  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${filePath} is a ${privateKey.asymmetricKeyType} key, expected ed25519`);
  }
  const publicKey = crypto.createPublicKey(privateKey);

  return { privateKey, publicKey, publicKeyBase64: rawPublicKeyBase64(publicKey), generated };
}

/**
 * The raw 32 public key bytes in standard base64 — the exact form a node stores in its
 * key_id -> public key map and feeds to Ed25519PublicKey.from_public_bytes().
 */
export function rawPublicKeyBase64(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

async function read(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
