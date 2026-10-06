import { config } from '../config/index.js';
import { parseCookies, readJsonBody, sendJson, serializeCookie } from '../core/http.js';
import { forbidden, invalidParameter, unauthorized } from '../core/errors.js';
import * as authService from '../services/auth.service.js';
import * as oidcLogin from '../services/oidcLogin.service.js';
import { validateNewUser } from '../validators/admin.validator.js';

const COOKIE_PATH = '/admin/api/auth';
/** Keycloak's refresh token, when the session came from the browser sign-in flow. */
const OIDC_COOKIE = 'aerocoreupdate_oidc';
/** The state and PKCE verifier of a sign-in currently in flight. */
const OIDC_TX_COOKIE = 'aerocoreupdate_oidc_tx';

/**
 * Cookies for the Keycloak sign-in, set several at a time — so this appends rather than
 * assigning, which would drop whichever was set first.
 */
function addCookie(res, name, value, options) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : [].concat(existing);
  list.push(serializeCookie(name, value, options));
  res.setHeader('Set-Cookie', list);
}

/**
 * SameSite=Lax, not Strict, and only for these two: the browser arrives at the callback by
 * a redirect FROM Keycloak, which is a cross-site navigation. Strict would withhold the
 * cookie exactly then, and the sign-in would fail with a state mismatch every single time.
 */
const oidcCookie = (maxAge) => ({
  httpOnly: true, secure: true, sameSite: 'Lax', path: COOKIE_PATH, maxAge,
});

/**
 * Where Keycloak sends the browser back to. It must match a redirect URI registered on the
 * client, so it is the address the operator actually dials.
 *
 * From PUBLIC_BASE_URL when set, otherwise from the address the browser dialled — which
 * under HTTP/2 is `:authority`, because h2 carries no `host` header at all. Reading `host`
 * alone yields `https://undefined/...` on every h2 connection, and Keycloak rejects it with
 * `invalid_redirect_uri` — a message that names the setting rather than the cause.
 *
 * The authority is attacker-controlled, and harmless here: a forged value is only ever sent
 * to Keycloak, which refuses any redirect URI it does not already know, and the browser is
 * redirected nowhere but the issuer.
 */
function callbackUri(req) {
  const authority = req.headers[':authority'] ?? req.headers.host;
  if (!config.publicBaseUrl && !authority) {
    throw invalidParameter('This request names no host; set PUBLIC_BASE_URL to sign in this way');
  }
  const base = (config.publicBaseUrl || `https://${authority}`).replace(/\/+$/, '');
  return `${base}/admin/api/auth/oidc/callback`;
}

const clientIp = (req) => req.socket?.remoteAddress ?? null;

/**
 * Cookie-bearing endpoints have a CSRF surface. SameSite=Strict and the narrow Path are the
 * first two defences; requiring a custom header is the third, because a plain HTML form
 * cannot set one. Endpoints that use Authorization instead are immune by construction.
 */
function requireFetchHeader(req) {
  if (req.headers['x-requested-with'] !== 'fetch') {
    throw invalidParameter('X-Requested-With: fetch is required');
  }
}

/**
 * Trade the Keycloak refresh cookie for an access token.
 *
 * There is one session model and one place it can come from. Until 2026-09-10 this also
 * fell back to a locally-issued refresh token; that path is gone with the local account,
 * so no cookie means no session rather than a second thing to try.
 */
export async function refresh(req, res) {
  requireFetchHeader(req);
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies[OIDC_COOKIE]) throw unauthorized('No session');
  return refreshFromKeycloak(req, res, cookies[OIDC_COOKIE]);
}

// ── signing in with a Keycloak account ─────────────────────────────────────────────────────

/**
 * GET /admin/api/auth/oidc — is there a Keycloak button to draw?
 *
 * Unauthenticated, like the registration probe and for the same reason: the sign-in page has
 * to decide what to render before anyone has a credential. Yes or no, never why.
 */
export async function oidcStatus(req, res) {
  const enabled = oidcLogin.browserLoginConfigured();
  // `reachable` is what lets the page send someone to Keycloak without asking them to click,
  // and stop doing that the moment Keycloak stops answering.
  sendJson(res, 200, { enabled, reachable: enabled && await oidcLogin.issuerReachable() });
}

/**
 * GET /admin/api/auth/oidc/start — begin the sign-in.
 *
 * A plain redirect rather than JSON the page then follows: this is a top-level navigation to
 * another origin, which is the one thing a browser will do between HTTPS and HTTP.
 */
export async function oidcStart(req, res) {
  if (!oidcLogin.browserLoginConfigured()) {
    throw forbidden('Keycloak sign-in is not configured on this server');
  }

  const tx = oidcLogin.newTransaction();
  // Ten minutes: long enough to type a password and answer an MFA prompt, short enough that
  // an abandoned attempt is not still sitting in the browser tomorrow.
  addCookie(res, OIDC_TX_COOKIE, `${tx.state}.${tx.verifier}`, oidcCookie(600));

  res.writeHead(302, {
    Location: oidcLogin.authorizeUrl({
      state: tx.state, challenge: tx.challenge, redirectUri: callbackUri(req),
    }),
  }).end();
}

/** Back to the sign-in page carrying something an operator can act on. */
function failSignIn(res, message) {
  addCookie(res, OIDC_TX_COOKIE, '', oidcCookie(0));
  res.writeHead(302, { Location: `/admin/login.html?error=${encodeURIComponent(message)}` }).end();
}

/**
 * GET /admin/api/auth/oidc/callback — Keycloak sends the browser here with a code.
 *
 * The token is verified before the session is handed out, not after: an account holding no
 * role this server recognises must be told so on the sign-in page, where the message is
 * readable and actionable, rather than being let into an app that then 403s every panel.
 */
export async function oidcCallback(req, res) {
  if (!oidcLogin.browserLoginConfigured()) {
    throw forbidden('Keycloak sign-in is not configured on this server');
  }

  // Keycloak refuses some sign-ins itself — a cancelled consent, a disabled account.
  const denied = req.query.get('error');
  if (denied) return failSignIn(res, req.query.get('error_description') || denied);

  const code = req.query.get('code');
  const state = req.query.get('state');
  const cookie = parseCookies(req.headers.cookie)[OIDC_TX_COOKIE] ?? '';
  const [expectedState, verifier] = cookie.split('.');

  // The state check is what stops a code being planted by somebody else's redirect. A missing
  // cookie is the same answer as a wrong one — usually a bookmarked callback URL or a sign-in
  // left open past its ten minutes.
  if (!code || !state || !expectedState || state !== expectedState) {
    return failSignIn(res, 'This sign-in could not be matched to one started here. Try again.');
  }

  const tokens = await oidcLogin.exchangeCode({
    code, verifier, redirectUri: callbackUri(req),
  });
  if (!tokens?.access_token) {
    return failSignIn(res, 'Keycloak would not exchange the sign-in. Try again.');
  }

  // Same verification every admin request gets, run once here so a refusal lands on the page
  // that can explain it. It also creates the local row the audit trail refers to.
  try {
    await authService.authenticate(tokens.access_token);
  } catch (err) {
    return failSignIn(res, err.message);
  }

  addCookie(res, OIDC_TX_COOKIE, '', oidcCookie(0));
  // Keycloak decides how long its own refresh token lives; the cookie is capped at this
  // server's refresh TTL so a stale one cannot outlive what it can be exchanged for.
  addCookie(res, OIDC_COOKIE, tokens.refresh_token ?? '', oidcCookie(config.refreshTtlSeconds));
  return res.writeHead(302, { Location: '/admin/' }).end();
}

/**
 * The Keycloak half of refresh(): trade the stored refresh token for a new access token.
 *
 * Returns the shape a local refresh returns, because the page cannot tell the two apart and
 * has no reason to.
 */
async function refreshFromKeycloak(req, res, refreshToken) {
  const tokens = await oidcLogin.refreshTokens(refreshToken);
  if (!tokens?.access_token) {
    addCookie(res, OIDC_COOKIE, '', oidcCookie(0));
    throw unauthorized('The Keycloak session has ended. Sign in again.');
  }

  // Verified rather than trusted: a role removed since the last refresh, or a session cut by
  // an administrator, has to bite here too — this is the moment a long-lived page would
  // otherwise keep going on yesterday's authorisation.
  const user = await authService.authenticate(tokens.access_token);

  // Keycloak rotates refresh tokens by default; keeping the old one would end the session at
  // the next refresh.
  if (tokens.refresh_token) {
    addCookie(res, OIDC_COOKIE, tokens.refresh_token, oidcCookie(config.refreshTtlSeconds));
  }
  sendJson(res, 200, {
    access_token: tokens.access_token,
    expires_in: tokens.expires_in ?? config.accessTtlSeconds,
    user: { id: user.id, username: user.username },
  });
}

/**
 * GET /admin/api/auth/registration — may this server be signed up for?
 *
 * Unauthenticated on purpose: the sign-in page has to know whether to draw the form before
 * anyone has a credential. Says only yes or no, never why — an anonymous caller has no
 * business learning which half of the configuration is missing.
 */
export async function registrationStatus(req, res) {
  sendJson(res, 200, { enabled: authService.selfRegistrationAvailable() });
}

/**
 * POST /admin/api/auth/register — create an account with no credential presented.
 *
 * Off unless ALLOW_SELF_REGISTRATION is set. The role is never taken from the body: it is
 * always KEYCLOAK_DEFAULT_ROLE, which opens nothing here while OIDC_ADMIN_ROLE is enforced.
 */
export async function register(req, res) {
  // Refused before the body is read or validated: a disabled endpoint has no business
  // describing its own schema to an anonymous caller. The service checks again — that one is
  // the boundary, this one is just not being talkative.
  if (!config.allowSelfRegistration) {
    throw forbidden('Self-service registration is disabled on this server');
  }

  const input = validateNewUser(await readJsonBody(req));
  const created = await authService.register({ input, ip: clientIp(req) });

  // Deliberately not the Keycloak id: an anonymous caller has no use for it.
  sendJson(res, 201, {
    username: created.username,
    email: created.email,
    role: created.role,
    note: created.role
      ? `Account created with the "${created.role}" role. Sign in with the password you chose.`
      : 'Account created, but no role was granted'
        + (created.roleError ? ` (${created.roleError})` : '')
        + '. An administrator must grant one before this server will let you in.',
  });
}

export async function logout(req, res) {
  const cookies = parseCookies(req.headers.cookie);

  if (cookies[OIDC_COOKIE]) {
    // Ending the Keycloak session too, or the next sign-in click walks back in with no
    // password and the sign-out looks like it did nothing.
    await oidcLogin.endSession(cookies[OIDC_COOKIE]);
    addCookie(res, OIDC_COOKIE, '', oidcCookie(0));
  }
  sendJson(res, 200, { ok: true });
}

export async function me(req, res) {
  sendJson(res, 200, {
    id: req.user.id,
    username: req.user.username,
    last_login_at: req.user.lastLoginAt,
    // What this session may actually do. The UI has no other way to know: without it a
    // publisher would be shown a Promote button that answers 403, which reads as a broken
    // page rather than as a permission they do not have. Sorted so the response is stable.
    scopes: [...req.user.scopes].sort(),
  });
}
