/**
 * The payload a key certificate's signature covers.
 *
 * Same discipline as signingPayload in manifest.js, for the same reason: a canonical-JSON
 * scheme lets two implementations disagree about key order and whitespace in silence, and
 * here that silence looks exactly like a compromised key.
 *
 * Mirrored on the node by UpdateClient::keycert_payload — keep the two identical.
 */

/**
 * key_id \n public_key \n not_before \n not_after
 *
 * Exactly four fields, joined by \n, NO trailing newline. `publicKey` is the base64 TEXT, not
 * the decoded bytes: re-encoding could differ in padding and reject a valid certificate.
 */
export function certPayload({ keyId, publicKey, notBefore, notAfter }) {
  return Buffer.from([keyId, publicKey, notBefore, notAfter].join('\n'), 'utf8');
}

/** The wire shape, served alongside a manifest's `signature` and covered by none of it. */
export function certBody(row) {
  return {
    alg: 'ed25519',
    root_key_id: row.rootKeyId,
    key_id: row.keyId,
    public_key: row.publicKey,
    not_before: row.notBefore,
    not_after: row.notAfter,
    value: row.certValue,
  };
}
