import { Router } from '../core/router.js';
import { requireScope } from '../middlewares/auth.js';
import { SCOPE } from '../domain/scopes.js';
import * as admin from '../controllers/admin.controller.js';
import * as auth from '../controllers/auth.controller.js';

/**
 * Admin routes live under /admin, not /api/v1: that namespace belongs to the node protocol
 * and is described by update-server-openapi.json.
 *
 * The unauthenticated endpoints are the ones a browser needs before it holds anything: login
 * and refresh, the two probes a sign-in page renders itself from, register (inert unless
 * ALLOW_SELF_REGISTRATION is set), and the three that carry out the Keycloak redirect dance.
 *
 * Every other line names the permission it takes rather than merely demanding a token, so
 * this file IS the authorisation model (docs/rbac-proposal.md). Read down the scopes and the
 * asymmetry is the point: `artifact:write` fills the catalog, `channel:write` is what makes
 * any of it reach an aircraft, and no role holds both except admin.
 */
export const adminRoutes = new Router()
  .post('/api/auth/refresh', auth.refresh)
  .get('/api/auth/registration', auth.registrationStatus)
  // Signing in with a Keycloak account. All three are unauthenticated by definition: they
  // are how a browser gets a credential in the first place.
  .get('/api/auth/oidc', auth.oidcStatus)
  .get('/api/auth/oidc/start', auth.oidcStart)
  .get('/api/auth/oidc/callback', auth.oidcCallback)
  .post('/api/auth/register', auth.register)
  .post('/api/auth/logout', auth.logout)
  .get('/api/auth/me', requireScope(SCOPE.SELF, auth.me))

  .get('/api/catalog', requireScope(SCOPE.CATALOG_READ, admin.getCatalog))

  // A release lives under its system: two systems may publish the same version number, so a
  // version alone names nothing (migration 012).
  .post('/api/systems/:system/releases', requireScope(SCOPE.ARTIFACT_WRITE, admin.createRelease))
  .patch('/api/systems/:system/releases/:version',
    requireScope(SCOPE.ARTIFACT_WRITE, admin.updateRelease))
  .delete('/api/systems/:system/releases/:version',
    requireScope(SCOPE.CATALOG_DELETE, admin.deleteRelease))
  // Two-step upload: stage to look, then commit. The web UI uses these.
  .post('/api/uploads', requireScope(SCOPE.ARTIFACT_WRITE, admin.stageUpload))
  .post('/api/uploads/:token', requireScope(SCOPE.ARTIFACT_WRITE, admin.commitUpload))
  // One-shot, kept for CI. Two routes, one handler: the router cannot express optional path
  // segments, and system and version are optional because the bundle supplies both.
  .post('/api/artifacts', requireScope(SCOPE.ARTIFACT_WRITE, admin.uploadArtifact))
  .post('/api/systems/:system/releases/:version/artifacts',
    requireScope(SCOPE.ARTIFACT_WRITE, admin.uploadArtifact))
  .get('/api/artifacts/:id', requireScope(SCOPE.CATALOG_READ, admin.getArtifact))
  .get('/api/artifacts/:id/diff', requireScope(SCOPE.CATALOG_READ, admin.getArtifactDiff))

  .delete('/api/artifacts/:id', requireScope(SCOPE.CATALOG_DELETE, admin.deleteArtifact))
  .put('/api/artifacts/:id/metadata', requireScope(SCOPE.ARTIFACT_WRITE, admin.setArtifactMetadata))

  // Systems: the kinds of device AeroCore runs on, each with its own version line.
  .get('/api/systems', requireScope(SCOPE.CATALOG_READ, admin.listSystems))
  .post('/api/systems', requireScope(SCOPE.SYSTEM_WRITE, admin.createSystem))
  .patch('/api/systems/:name', requireScope(SCOPE.SYSTEM_WRITE, admin.updateSystem))
  .delete('/api/systems/:name', requireScope(SCOPE.SYSTEM_WRITE, admin.deleteSystem))

  // Nodes claiming a system this server does not have, waiting for an admin to place them.
  .get('/api/unclassified', requireScope(SCOPE.CATALOG_READ, admin.listUnclassified))
  .put('/api/unclassified/:serial', requireScope(SCOPE.SYSTEM_WRITE, admin.assignNode))
  .delete('/api/unclassified/:serial', requireScope(SCOPE.SYSTEM_WRITE, admin.forgetNode))

  // A channel belongs to one system, so its system is part of the path.
  //
  // The PUT is the only route in this file that reaches an aircraft: everything else adds to
  // a catalog nobody is served from. It is the reason `channel:write` exists as a scope of
  // its own — an engineer uploads, and the admin reviewing the build is who moves the
  // channel. A leaked publisher token stages a file; it does not ship firmware.
  .get('/api/systems/:system/channels/:name', requireScope(SCOPE.CATALOG_READ, admin.getChannel))
  .put('/api/systems/:system/channels/:name', requireScope(SCOPE.CHANNEL_WRITE, admin.putChannel))

  // Accounts live in Keycloak, so one created here works on AeroCore and aerotunnel too.
  // Created with NO roles: this server's authorisation is still binary, so a usable
  // account would be an omnipotent one.
  .get('/api/users', requireScope(SCOPE.USER_ADMIN, admin.listUsersHandler))
  .post('/api/users', requireScope(SCOPE.USER_ADMIN, admin.createUserHandler))
  // The second half of a demotion: Keycloak stops granting the role, this stops the token
  // that still claims it. `user:admin` because it acts on somebody else's access.
  .delete('/api/users/:username/sessions', requireScope(SCOPE.USER_ADMIN, admin.revokeSessions))

  .get('/api/fleet', requireScope(SCOPE.CATALOG_READ, admin.fleet))
  .get('/api/reports', requireScope(SCOPE.CATALOG_READ, admin.reports))
  .get('/api/audit', requireScope(SCOPE.CATALOG_READ, admin.audit))
  .get('/api/api-keys', requireScope(SCOPE.SIGNING_KEY, admin.apiKeys))
  .get('/api/signing-key', requireScope(SCOPE.SIGNING_KEY, admin.signingKey))
  // Upload a root-signed certificate for a signing key. The root signs it OFFLINE; this
  // server only verifies it against the root's public half and stores it.
  .put('/api/signing-key/certificate', requireScope(SCOPE.SIGNING_KEY, admin.putSigningKeyCertificate))
  .get('/api/tls', requireScope(SCOPE.CATALOG_READ, admin.tls));
