/**
 * The admin surface's Content-Security-Policy.
 *
 * Pure, and separate from the middleware, because the one directive that varies
 * is the one that fails invisibly: the admin UI signs in against Keycloak from
 * the browser (public client, PKCE), so it fetches the issuer's metadata and
 * posts the code exchange to its token endpoint. Under `connect-src 'self'`
 * both are blocked, and what an operator sees is a sign-in button that does
 * nothing — no redirect, no message, nothing but a console entry.
 */

const BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

/**
 * @param {string} issuer  the OIDC issuer URL, or '' when Keycloak is not configured
 * @returns {string} the header value
 */
export function adminCsp(issuer) {
  const origins = ["'self'"];
  const origin = issuerOrigin(issuer);
  // Only the ORIGIN, never the issuer path: `connect-src` matches on origin
  // anyway, and carrying the realm path in would suggest a narrowing this
  // directive cannot express.
  if (origin) origins.push(origin);

  return [`connect-src ${origins.join(' ')}`, ...BASE].sort().join('; ');
}

/** The scheme://host:port of an issuer URL, or '' when there is not one. */
export function issuerOrigin(issuer) {
  if (typeof issuer !== 'string' || !issuer) return '';
  try {
    return new URL(issuer).origin;
  } catch {
    // A malformed issuer must not widen the policy to something a browser reads
    // loosely — an unparseable value contributes nothing at all.
    return '';
  }
}
