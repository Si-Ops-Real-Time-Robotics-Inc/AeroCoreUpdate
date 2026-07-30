import { query } from '../db/pool.js';
import { toRfc3339 } from './catalog.repository.js';

/**
 * Stored key certificates, one per key_id.
 *
 * Retired keys keep their rows: a manifest signed months ago is still verifiable only while
 * the certificate naming its key is here, and dropping it the moment a rotation completes is
 * how an in-flight download turns into `keycert_unknown_root` on the node.
 */

function map(row) {
  return {
    keyId: row.key_id,
    publicKey: row.public_key,
    // Serialised to the exact form the root signed over — RFC3339 UTC trimmed to seconds.
    notBefore: toRfc3339(row.not_before),
    notAfter: toRfc3339(row.not_after),
    rootKeyId: row.root_key_id,
    certValue: row.cert_value,
    uploadedAt: toRfc3339(row.uploaded_at),
    uploadedBy: row.uploaded_by,
  };
}

export async function findByKeyId(keyId) {
  const { rows } = await query(
    `SELECT key_id, public_key, not_before, not_after, root_key_id, cert_value,
            uploaded_at, uploaded_by
     FROM signing_key_cert WHERE key_id = $1`, [keyId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function listCerts() {
  const { rows } = await query(
    `SELECT key_id, public_key, not_before, not_after, root_key_id, cert_value,
            uploaded_at, uploaded_by
     FROM signing_key_cert ORDER BY not_after DESC`,
  );
  return rows.map(map);
}

/** Upsert: re-uploading a corrected certificate for the same key_id replaces it. */
export async function putCert(cert, actor) {
  const { rows } = await query(
    `INSERT INTO signing_key_cert
       (key_id, public_key, not_before, not_after, root_key_id, cert_value, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key_id) DO UPDATE SET
       public_key  = EXCLUDED.public_key,
       not_before  = EXCLUDED.not_before,
       not_after   = EXCLUDED.not_after,
       root_key_id = EXCLUDED.root_key_id,
       cert_value  = EXCLUDED.cert_value,
       uploaded_at = now(),
       uploaded_by = EXCLUDED.uploaded_by
     RETURNING key_id, public_key, not_before, not_after, root_key_id, cert_value,
               uploaded_at, uploaded_by`,
    [cert.keyId, cert.publicKey, cert.notBefore, cert.notAfter, cert.rootKeyId,
     cert.certValue, actor],
  );
  return map(rows[0]);
}
