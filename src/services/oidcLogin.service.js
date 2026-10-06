import crypto from 'node:crypto';

import { config } from '../config/index.js';
import { logger } from '../core/logger.js';
import { upstreamUnavailable } from '../core/errors.js';

/**
 * Signing in to the admin UI with a Keycloak account, from a browser.
 *
 * The code exchange happens HERE rather than in the page, and not for elegance: this server
 * is HTTPS-only for /admin while Keycloak is commonly plain HTTP on the same LAN, and a
 * browser refuses to let an HTTPS page POST to an HTTP token endpoint at all. The redirect
 * itself is a top-level navigation, which is allowed — so the flow works only if the half
 * that needs fetch() lives server-side.
 *
 * Two things fall out of that, both good. The client stays CONFIDENTIAL, because its secret
 * never leaves this process. And the browser ends up holding exactly what it held before:
 * an access token in memory and an HttpOnly refresh cookie it cannot read — the same session
 * shape as a local sign-in, so nothing downstream of `refresh()` knows the difference.
 *
 * PKCE is used anyway. The secret already authenticates this client, so PKCE adds little
 * here, but it costs one hash and it is what makes the authorization code useless to anyone
 * who intercepts the redirect.
 */

const TIMEOUT_MS = 10_000;

export function browserLoginConfigured() {
  return Boolean(config.oidcIssuer && config.keycloakBaseUrl
                 && config.oidcWebClientId && config.oidcWebClientSecret);
}

const b64u = (buf) => buf.toString('base64url');

/**
 * Is the identity provider actually answering?
 *
 * Asked because the sign-in page redirects to Keycloak on its own, without waiting for a
 * click. That is a good default and a trap: when Keycloak is down, an automatic redirect
 * sends the operator to a dead address and the page never gets to explain why.
 *
 * So the page asks first, and states the outage when the answer is no. There is nothing to
 * fall back to — this server holds no account of its own.
 *
 * Only the NEGATIVE answer is remembered, and only briefly. A healthy probe costs a few
 * milliseconds to a Keycloak on the same LAN, so caching it would buy nothing and would keep
 * reporting an outage that has already ended. An unreachable one costs the full timeout, and
 * a sign-in page reloaded in a loop must not stall for two seconds every time.
 */
const UNREACHABLE_TTL_MS = 10_000;
const REACHABLE_TIMEOUT_MS = 2_000;
let unreachableUntil = 0;

export async function issuerReachable() {
  if (!browserLoginConfigured()) return false;
  if (Date.now() < unreachableUntil) return false;

  let ok = false;
  try {
    const res = await fetch(`${config.oidcIssuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS),
    });
    ok = res.ok;
  } catch {
    // Down, unreachable, or slower than a person will wait. All the same answer to the page.
    ok = false;
  }
  if (!ok) unreachableUntil = Date.now() + UNREACHABLE_TTL_MS;
  return ok;
}

/** A fresh state and PKCE pair for one sign-in attempt. */
export function newTransaction() {
  const verifier = b64u(crypto.randomBytes(32));
  return {
    state: b64u(crypto.randomBytes(16)),
    verifier,
    challenge: b64u(crypto.createHash('sha256').update(verifier).digest()),
  };
}

/**
 * Where to send the browser.
 *
 * Built from the ISSUER, not from the internal base URL: this is the address the person's
 * browser dials, and it has to be the one Keycloak stamps into `iss` or the token comes back
 * failing the issuer check for reasons nobody will enjoy diagnosing.
 */
export function authorizeUrl({ state, challenge, redirectUri }) {
  const url = new URL(`${config.oidcIssuer}/protocol/openid-connect/auth`);
  url.search = new URLSearchParams({
    client_id: config.oidcWebClientId,
    response_type: 'code',
    scope: 'openid profile email',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** The token endpoint this server dials, which may be an internal address. */
const tokenEndpoint = () =>
  `${config.keycloakBaseUrl.replace(/\/+$/, '')}/realms/${config.keycloakRealm}`
  + '/protocol/openid-connect/token';

async function postToken(params, what) {
  let res;
  try {
    res = await fetch(tokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.oidcWebClientId,
        client_secret: config.oidcWebClientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.error(`Keycloak is not reachable at ${tokenEndpoint()}: ${err.message}`);
    throw upstreamUnavailable('The identity provider is not reachable right now');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The cause goes to the log; the caller gets a sentence. `invalid_grant` on a refresh is
    // the ordinary end of a Keycloak session, not a fault worth alarming anyone about.
    logger.warn(`Keycloak refused the ${what} (HTTP ${res.status}): `
      + `${body.error ?? '?'} ${body.error_description ?? ''}`.trim());
    return null;
  }
  return body;
}

/** Trade the authorization code for tokens. Returns null when Keycloak refuses. */
export function exchangeCode({ code, verifier, redirectUri }) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, 'authorization code');
}

/** Trade a refresh token for a new pair. Null means the session is over. */
export function refreshTokens(refreshToken) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'refresh token');
}

/**
 * Ask Keycloak to end its own session too.
 *
 * Without this, signing out here leaves the Keycloak session cookie intact and the next
 * "Sign in with Keycloak" click walks straight back in without a password — which looks
 * exactly like the sign-out having silently failed.
 */
export async function endSession(refreshToken) {
  try {
    await fetch(tokenEndpoint().replace(/\/token$/, '/logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.oidcWebClientId,
        client_secret: config.oidcWebClientSecret,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A sign-out that could not reach the IdP still signed the person out of this server.
    logger.warn(`Could not end the Keycloak session: ${err.message}`);
  }
}
