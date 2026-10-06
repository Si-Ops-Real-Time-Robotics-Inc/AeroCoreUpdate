import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const resolve = (value, fallback) => path.resolve(rootDir, value || fallback);

/**
 * Parse UPDATE_API_KEYS. Accepts "fleet-a:key1,fleet-b:key2" or a bare comma-separated
 * list of keys (which get generated fleet names). Returns Map<sha256(key), fleetName>
 * so lookups never touch the raw key.
 */
function parseApiKeys(raw) {
  const keys = new Map();
  if (!raw) return keys;

  raw.split(',').map((entry) => entry.trim()).filter(Boolean).forEach((entry, index) => {
    const colon = entry.indexOf(':');
    const [fleet, key] = colon > 0
      ? [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
      : [`fleet-${index + 1}`, entry];
    if (key) keys.set(crypto.createHash('sha256').update(key).digest('hex'), fleet);
  });
  return keys;
}

/**
 * The same entries, but with the keys intact, read on demand rather than held in `config`.
 *
 * The map above deliberately keeps only digests, so verification never handles a raw key. That
 * property is worth keeping — but an operator provisioning a device has to see the key, and it
 * is already sitting in `process.env` for the life of the process. Re-parsing here rather than
 * storing a second copy keeps `config` free of secrets, and makes every place that can produce
 * a key one grep away.
 */
export function fleetApiKeys() {
  const raw = process.env.UPDATE_API_KEYS;
  if (!raw) return [];

  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry, index) => {
    const colon = entry.indexOf(':');
    const [fleet, key] = colon > 0
      ? [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
      : [`fleet-${index + 1}`, entry];
    return { fleet, key };
  }).filter((entry) => entry.key);
}

/**
 * Parse "key_id:base64,key_id2:base64" into Map<key_id, base64>. Entries whose value is not
 * 32 raw bytes are dropped with no ceremony: an ed25519 public key is exactly that length,
 * and a malformed one would only ever produce a confusing verification failure later.
 */
function parsePublicKeys(raw) {
  const keys = new Map();
  if (!raw) return keys;

  raw.split(',').map((e) => e.trim()).filter(Boolean).forEach((entry) => {
    const colon = entry.indexOf(':');
    if (colon <= 0) return;
    const id = entry.slice(0, colon).trim();
    const b64 = entry.slice(colon + 1).trim();
    if (id && Buffer.from(b64, 'base64').length === 32) keys.set(id, b64);
  });
  return keys;
}

/* ── Keycloak, derived from two settings ───────────────────────────────────────────────────
 *
 * Keycloak's URL layout is fixed, so the issuer and the JWKS endpoint follow from the base
 * URL and the realm. Asking for all four would be the same two facts written twice, and the
 * copy that drifts is the one that breaks — with a symptom ("wrong issuer") that looks
 * nothing like its cause.
 *
 * The overrides exist for one real case: behind a reverse proxy, the `iss` a token carries is
 * the PUBLIC URL while this server dials Keycloak on an internal address. Then the two
 * genuinely differ and must be stated separately.
 */
const KEYCLOAK_BASE = (process.env.KEYCLOAK_BASE_URL || '').trim().replace(/\/+$/, '');
const KEYCLOAK_REALM = (process.env.KEYCLOAK_REALM || '').trim();
const DERIVED_ISSUER = KEYCLOAK_BASE && KEYCLOAK_REALM
  ? `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}`
  : '';
const OIDC_ISSUER = (process.env.OIDC_ISSUER || '').trim() || DERIVED_ISSUER;
const OIDC_JWKS_URI = (process.env.OIDC_JWKS_URI || '').trim()
  || (DERIVED_ISSUER ? `${DERIVED_ISSUER}/protocol/openid-connect/certs` : '');

/** Every env-derived setting lives here, so nothing else reads process.env. */
export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 9443),
  serviceName: 'aerocore-update-server',
  bodyLimit: int(process.env.BODY_LIMIT, 1_000_000),
  shutdownTimeout: int(process.env.SHUTDOWN_TIMEOUT, 10_000),

  // TLS
  tlsCertFile: resolve(process.env.TLS_CERT_FILE, 'tls/server.crt'),
  tlsKeyFile: resolve(process.env.TLS_KEY_FILE, 'tls/server.key'),
  tlsCn: process.env.TLS_CN || 'aerocoreupdate',
  // Extra names/addresses to put in the certificate's subjectAltName. Anything a client will
  // actually dial has to be here, or verification fails from that address.
  tlsSan: (process.env.TLS_SAN || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Escape hatch: the node has no TLS backend (spec section 10), so if the fleet cannot
  // reach an HTTPS-only server this opens a plaintext listener for /api/v1 only.
  allowPlaintextHttp: bool(process.env.ALLOW_PLAINTEXT_HTTP, false),
  httpPort: int(process.env.HTTP_PORT, 9099),

  // Database
  databaseUrl: process.env.DATABASE_URL || '',
  dbPoolMax: int(process.env.DB_POOL_MAX, 10),
  runMigrations: bool(process.env.RUN_MIGRATIONS, true),

  // Fleet auth
  apiKeys: parseApiKeys(process.env.UPDATE_API_KEYS),

  // Admin auth
  accessTtlSeconds: int(process.env.ACCESS_TTL_SECONDS, 15 * 60),
  refreshTtlSeconds: int(process.env.REFRESH_TTL_SECONDS, 7 * 24 * 3600),

  // Signing
  keyId: process.env.SIGNING_KEY_ID || 'rtr-ota-2026',
  signingKeyFile: resolve(process.env.SIGNING_KEY_FILE, 'keys/ota-signing.key'),
  // Mint a signing key when the file is absent. OFF by default: a regenerated key keeps the
  // same key_id, so every node rejects the manifests it signs and nothing says why. Dev and
  // CI set it; a real deployment restores from backup instead.
  signingKeyAutogen: bool(process.env.SIGNING_KEY_AUTOGEN, false),
  // Refuse an artifact that arrives without a signature, and stop holding a private key at
  // all. The end state of moving signing into the release pipeline (spec section 10): a
  // server with no key cannot lose one, leak one, or silently regenerate one.
  signingRequirePresigned: bool(process.env.SIGNING_REQUIRE_PRESIGNED, false),
  // Root PUBLIC key, used to validate a key certificate before storing it. The root's
  // private half never touches this machine — that is the entire point of the scheme.
  rootKeyId: process.env.SIGNING_ROOT_KEY_ID || '',
  rootPublicKey: process.env.SIGNING_ROOT_PUBLIC_KEY || '',
  // Public keys the server will accept a PRE-SIGNED artifact under, as
  // "key_id:base64,key_id2:base64". Only the public halves — they exist so the upload gate
  // can verify a signature the release pipeline produced, not so the server can sign.
  signingTrustedKeys: parsePublicKeys(process.env.SIGNING_TRUSTED_KEYS),

  // External identity (Keycloak). One account across AeroCoreUpdate, AeroCore and aerotunnel.
  //
  // ONE realm, named ONCE: base URL + realm. The issuer and the JWKS URI are derived from
  // them below, because Keycloak's own layout fixes both — naming all four would be the
  // same two facts written twice, and the pair that drifts is the pair that breaks.
  //
  // EdDSA only — see core/oidc.js. A Keycloak realm ships RSA keys by default, so an EdDSA
  // realm key has to be added and selected, or nothing here will verify anything.
  keycloakBaseUrl: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM,
  oidcIssuer: OIDC_ISSUER,
  oidcJwksUri: OIDC_JWKS_URI,
  // Audiences are checked per surface and are deliberately different: a token minted for the
  // fleet API must not open the admin API, nor the reverse.
  oidcAudienceAdmin: process.env.OIDC_AUDIENCE_ADMIN || 'aeroserver-admin',
  oidcAudienceFleet: process.env.OIDC_AUDIENCE_FLEET || 'aerocore',
  // The realm role a Keycloak account must hold to reach /admin at all.
  //
  // The audience says which SURFACE a token was minted for; it says nothing about what the
  // account behind it may do. Without a role check every realm user opens every admin route —
  // including the `customer` accounts this server creates — and with self-registration on that
  // is anyone who can reach Keycloak.
  //
  // Deliberately not disableable. A realm missing this role locks every operator out of
  // this server, which is severe and is meant to be: an unenforced role check would open
  // the admin API to every account in a realm shared with two other products.
  oidcAdminRole: (process.env.OIDC_ADMIN_ROLE || 'aeroserver-admin').trim(),
  // Two lesser roles, so "may sign in to the admin API" stops meaning "may ship firmware".
  //
  // A publisher uploads artifacts and creates releases; only the admin role points a channel
  // at one. That is the whole authorisation model in one sentence, and the reason it exists:
  // an upload reaches nobody until a channel moves, so the two are different powers and the
  // person who reviews a build need not be the person who built it.
  //
  // Empty disables a level rather than widening it — a name nobody holds grants nothing.
  oidcPublisherRole: (process.env.OIDC_PUBLISHER_ROLE ?? 'aeroserver-publisher').trim(),
  oidcViewerRole: (process.env.OIDC_VIEWER_ROLE ?? 'aeroserver-viewer').trim(),
  // The realm role a token must hold before the FLEET API opens, checked on top of the
  // audience. The audience says a token was minted for the nodes; it does not say the
  // account behind it may pull firmware — and every account in a shared realm can ask
  // Keycloak for a fleet-audience token, including the `customer` accounts this server
  // creates and anyone who self-registers.
  //
  // Empty means no role check, which is the historical behaviour and stays the default: a
  // fleet already running on tokens must not stop updating because this server was upgraded.
  // Turning it on is a cutover like FLEET_AUTH_MODE itself — grant the role to the node
  // service account BEFORE setting it, or every node gets 403 at once.
  oidcFleetRole: (process.env.OIDC_FLEET_ROLE || '').trim(),
  // A lesser fleet role: may pull, but only what the `stable` channel currently serves.
  //
  // The distinction is not about trust in a person, it is about which build a device should
  // ever receive. An aircraft that follows stable has no business fetching a beta image, and
  // a credential that cannot ask for one cannot be talked into it by a mistyped config.
  // Holding the full role as well wins — that is a superset, not a conflict.
  oidcFleetStableRole: (process.env.OIDC_FLEET_STABLE_ROLE ?? 'aerocore-fleet-stable').trim(),
  // Signing in to the admin UI with a Keycloak account, from a browser.
  //
  // A CONFIDENTIAL client, deliberately: the code exchange happens in this process, never in
  // the page — /admin is HTTPS-only and Keycloak is usually plain HTTP on the LAN, which a
  // browser refuses to mix. So the secret never reaches a browser, and the page ends up with
  // the same session it has always had. Empty leaves the sign-in page on local passwords.
  oidcWebClientId: (process.env.OIDC_WEB_CLIENT_ID || '').trim(),
  oidcWebClientSecret: process.env.OIDC_WEB_CLIENT_SECRET || '',

  // Survives a restart taken while Keycloak is unreachable. Without it a server that reboots
  // during an IdP outage cannot verify anything until the IdP is back.
  oidcJwksCacheFile: resolve(process.env.OIDC_JWKS_CACHE_FILE, 'keys/jwks-cache.json'),

  // How /api/v1/* authenticates. `both` is the migration state: a node that already holds a
  // token uses it, one that does not keeps working on its API key. Moving to `jwt` is a one
  // line change — and a cutover, so only do it once every node has a token.
  fleetAuthMode: (process.env.FLEET_AUTH_MODE || 'apikey').trim().toLowerCase(),

  // Creating accounts from the admin UI, via Keycloak's admin REST API. The service
  // account behind these credentials must hold `manage-users` and nothing more — never
  // `realm-admin`. It lives on this box, so anything it can do, an attacker who takes this
  // box can do.
  keycloakAdminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || '',
  keycloakAdminClientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || '',
  // Realm role granted to an account created here. `customer` on purpose: the LOWEST
  // privilege level, never a convenient one. Set it empty to grant nothing at all.
  keycloakDefaultRole: (process.env.KEYCLOAK_DEFAULT_ROLE ?? 'customer').trim(),

  // Self-service account creation from the sign-in page, with no credential at all.
  //
  // OFF by default, and that default is load-bearing: an account created here is a KEYCLOAK
  // account, so it signs in to AeroCore and aerotunnel the moment it exists. Turning this on
  // is a decision about who may reach three systems, not one form on one page.
  allowSelfRegistration: bool(process.env.ALLOW_SELF_REGISTRATION, false),
  // Per-address ceiling, so an open form cannot be used to fill the realm.
  registerMaxPerIp: int(process.env.REGISTER_MAX_PER_IP, 5),
  registerWindowMinutes: int(process.env.REGISTER_WINDOW_MINUTES, 60),

  // Catalog behaviour
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  strictPlatforms: bool(process.env.STRICT_PLATFORMS, true),
  slimFallbackToFleet: bool(process.env.SLIM_FALLBACK_TO_FLEET, true),
  uploadMaxBytes: int(process.env.UPLOAD_MAX_BYTES, 512 * 1024 * 1024),
  // Where a fresh upload lands. `beta` by default, so a new build reaches the test group and
  // nothing else: stable keeps whatever it was handing out until an admin promotes.
  //
  // This is not the same as publishing in one step. beta is the staging channel — only the
  // devices an operator deliberately put there follow it — so an accidental upload reaches
  // that group, not the fleet. Set it to '' to go back to staging with no channel at all, or
  // pass ?channel= per upload (which CI usually wants).
  autoPromoteChannel: (process.env.AUTO_PROMOTE_CHANNEL ?? 'beta').trim(),
  // The channel a committed upload lands on. Every system has exactly `beta` and `stable`, so
  // this is not configurable — naming it once keeps the two places that mention it in step.
  stagingChannel: 'beta',
  releaseChannel: 'stable',
  // A bundle carries only its own config payload, so a node that skips releases never sees
  // what they set. Refusing a non-cumulative payload is the only way to guarantee a node
  // arriving from any older version ends up in the intended state.
  requireCumulativeConfig: bool(process.env.REQUIRE_CUMULATIVE_CONFIG, true),
  // System a bundle is filed under when its release.json names none. Systems are created by
  // an admin, never invented from a bundle, so this must already exist.
  defaultSystem: (process.env.DEFAULT_SYSTEM || 'default').trim(),
  // Refuse a bundle that carries no config component at all. The cumulative check only fires
  // once an earlier release has set something, so a release line that never ships config
  // would never be caught by it. Off by default because a core-only or plugin-only release is
  // legitimate; turn it on where every release is required to restate the full config.
  requireConfigComponent: bool(process.env.REQUIRE_CONFIG_COMPONENT, false),
  // Refuse a bundle whose shipped core config would blank update.server_url / api_key or set
  // update.enabled=false. Off: AeroCore already protects those on the node — but only where
  // the param is locked or readonly (reconcile_param keeps the live value for frozen params
  // and the package value for every other). Turn it on if the fleet's provisioning does not
  // reliably lock them, because a node that applies a blank server URL can never be reached.
  refuseConfigLifeline: bool(process.env.REFUSE_CONFIG_LIFELINE, false),
  // Refuse to serve a version no channel points at. Off by default: the download endpoint
  // resolves by version, so turning this on makes an in-flight download 404 the moment a
  // channel moves past it, and a resuming node would have to start over.
  downloadRequiresChannel: bool(process.env.DOWNLOAD_REQUIRES_CHANNEL, false),
  checkLogRetentionDays: int(process.env.CHECK_LOG_RETENTION_DAYS, 90),

  maintenance: bool(process.env.MAINTENANCE, false),
  maintenanceRetryAfter: int(process.env.MAINTENANCE_RETRY_AFTER, 300),

  paths: {
    root: rootDir,
    public: path.join(rootDir, 'public'),
    artifacts: resolve(process.env.ARTIFACTS_DIR, 'artifacts'),
  },
};

export const isProduction = () => config.env === 'production';
