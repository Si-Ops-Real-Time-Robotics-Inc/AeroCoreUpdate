/**
 * The certificate description captured at boot, so the admin UI can show what browsers and
 * nodes must be told to trust without re-reading the key material on every request.
 */
let info = null;

export function setTlsInfo(value) {
  const { cert, key, ...safe } = value;
  info = safe;
}

export function getTlsInfo() {
  return info ?? { enabled: false };
}

/**
 * HSTS may only be sent behind a certificate a browser actually trusts.
 *
 * Sent with a self-signed certificate it is a trap: once the browser records the policy, the
 * certificate warning becomes non-bypassable — Chrome removes "Proceed anyway" entirely — and
 * the operator is locked out of the admin UI for max-age, with no way in from that browser.
 */
export function shouldSendHsts() {
  return Boolean(info?.enabled) && info.selfSigned === false;
}
