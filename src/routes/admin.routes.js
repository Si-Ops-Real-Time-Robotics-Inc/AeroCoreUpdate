import { Router } from '../core/router.js';
import { requireAuth } from '../middlewares/auth.js';
import * as admin from '../controllers/admin.controller.js';
import * as auth from '../controllers/auth.controller.js';

/**
 * Admin routes live under /admin, not /api/v1: that namespace belongs to the node protocol
 * and is described by update-server-openapi.json.
 *
 * login and refresh are the only unauthenticated endpoints — they are how a session starts.
 */
export const adminRoutes = new Router()
  .post('/api/auth/login', auth.login)
  .post('/api/auth/refresh', auth.refresh)
  .post('/api/auth/logout', auth.logout)
  .post('/api/auth/logout-all', requireAuth(auth.logoutAll))
  .get('/api/auth/me', requireAuth(auth.me))
  .post('/api/auth/password', requireAuth(auth.changePassword))

  .get('/api/catalog', requireAuth(admin.getCatalog))

  .post('/api/releases', requireAuth(admin.createRelease))
  .patch('/api/releases/:version', requireAuth(admin.updateRelease))
  .delete('/api/releases/:version', requireAuth(admin.deleteRelease))
  // Two routes, one handler: the router cannot express an optional path segment, and the
  // version is now optional because the bundle supplies it.
  // Two-step upload: stage to look, then commit. The web UI uses these.
  .post('/api/uploads', requireAuth(admin.stageUpload))
  .post('/api/uploads/:token', requireAuth(admin.commitUpload))
  // One-shot, kept for CI.
  .post('/api/artifacts', requireAuth(admin.uploadArtifact))
  .post('/api/releases/:version/artifacts', requireAuth(admin.uploadArtifact))
  .get('/api/artifacts/:id', requireAuth(admin.getArtifact))
  .get('/api/artifacts/:id/diff', requireAuth(admin.getArtifactDiff))

  .delete('/api/artifacts/:id', requireAuth(admin.deleteArtifact))
  .put('/api/artifacts/:id/metadata', requireAuth(admin.setArtifactMetadata))

  // Systems: the kinds of device AeroCore runs on, each with its own version line.
  .get('/api/systems', requireAuth(admin.listSystems))
  .post('/api/systems', requireAuth(admin.createSystem))
  .patch('/api/systems/:name', requireAuth(admin.updateSystem))
  .delete('/api/systems/:name', requireAuth(admin.deleteSystem))

  // Nodes whose version matches no release, waiting for an admin to place them.
  .get('/api/unclassified', requireAuth(admin.listUnclassified))
  .put('/api/unclassified/:serial', requireAuth(admin.assignNode))
  .delete('/api/unclassified/:serial', requireAuth(admin.forgetNode))

  // A channel belongs to one system, so its system is part of the path.
  .get('/api/systems/:system/channels/:name', requireAuth(admin.getChannel))
  .put('/api/systems/:system/channels/:name', requireAuth(admin.putChannel))

  // Accounts live in Keycloak, so one created here works on AeroCore and aerotunnel too.
  // Created with NO roles: this server's authorisation is still binary, so a usable
  // account would be an omnipotent one.
  .get('/api/users', requireAuth(admin.listUsersHandler))
  .post('/api/users', requireAuth(admin.createUserHandler))

  .get('/api/fleet', requireAuth(admin.fleet))
  .get('/api/reports', requireAuth(admin.reports))
  .get('/api/audit', requireAuth(admin.audit))
  .get('/api/api-keys', requireAuth(admin.apiKeys))
  .get('/api/signing-key', requireAuth(admin.signingKey))
  // Upload a root-signed certificate for a signing key. The root signs it OFFLINE; this
  // server only verifies it against the root's public half and stores it.
  .put('/api/signing-key/certificate', requireAuth(admin.putSigningKeyCertificate))
  .get('/api/tls', requireAuth(admin.tls));
