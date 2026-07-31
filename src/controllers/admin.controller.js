import { readJsonBody, sendJson } from '../core/http.js';
import { conflict, invalidParameter, notFound } from '../core/errors.js';
import { config, fleetApiKeys } from '../config/index.js';
import * as catalog from '../repositories/catalog.repository.js';
import { artifactReadable } from '../services/download.service.js';
import * as catalogAdmin from '../services/catalogAdmin.service.js';
import * as publish from '../services/publish.service.js';
import { diffAgainstPrevious, diffForInspection, isNoOp } from '../services/diff.service.js';
import * as telemetry from '../repositories/telemetry.repository.js';
import { insertAudit, listAudit } from '../repositories/audit.repository.js';
import * as systems from '../repositories/system.repository.js';
import { getKeyId, getPublicKeyBase64, verifyKeyCertificate } from '../services/signing.service.js';
import { listCerts, putCert } from '../repositories/signingKeyCert.repository.js';
import { createUser, keycloakAdminConfigured, listUsers }
  from '../services/keycloakAdmin.service.js';
import { getTlsInfo } from '../services/tlsInfo.service.js';
import {
  validateArtifactMetadata, validateChannelBody, validateChannelName, validateExpectedSha256,
  validateKeyCertificateBody, validateNewUser, validatePublishedAt, validateReleaseBody,
  validateSerial, validateSignatureHeaders, validateSystemBody, validateSystemName,
  validateUploadQuery, validateVersionParam,
} from '../validators/admin.validator.js';

const intParam = (raw, fallback, max) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** Everything the admin UI needs to draw the catalog in one round trip. */
export async function getCatalog(req, res) {
  const system = req.query.get('system') || null;
  const [releases, channels, systemList, pending, strayChannels] = await Promise.all([
    catalog.listReleases({ limit: intParam(req.query.get('limit'), 100, 500), system }),
    catalog.listChannels(system),
    systems.listSystems(),
    systems.countPending(),
    // Nodes asking for a channel that does not exist for their system. They get a correct 204
    // and no error, so this is the only place the misconfiguration ever becomes visible.
    telemetry.unknownChannels(),
  ]);

  const withArtifacts = await Promise.all(releases.map(async (release) => ({
    ...release,
    artifacts: await Promise.all(
      (await catalog.listArtifacts(release.version)).map(async (artifact) => ({
        ...serializeArtifact(artifact),
        // Whether the bytes are actually there. A row whose file has gone is invisible from
        // every other angle: the catalog shows the release as live, the channel points at it,
        // and nodes are simply told there is no update — the check path declines to offer an
        // artifact it cannot read, and says so only in the server log.
        readable: await artifactReadable(artifact),
      })),
    ),
  })));

  sendJson(res, 200, {
    revision: await catalog.getRevision(),
    systems: systemList,
    unclassified_pending: pending,
    channels,
    stray_channels: strayChannels,
    releases: withArtifacts,
  });
}

// ── systems ───────────────────────────────────────────────────────────────────────────────

export async function listSystems(req, res) {
  sendJson(res, 200, { systems: await systems.listSystems() });
}

export async function createSystem(req, res) {
  const input = validateSystemBody(await readJsonBody(req));
  sendJson(res, 201, await catalogAdmin.createSystem(input, req.user.username));
}

export async function updateSystem(req, res) {
  const name = validateSystemName(req.params.name);
  const body = await readJsonBody(req);
  if (body.description !== undefined && body.description !== null
      && typeof body.description !== 'string') {
    throw invalidParameter('description must be a string');
  }
  sendJson(res, 200, await catalogAdmin.updateSystem(name, body, req.user.username));
}

export async function deleteSystem(req, res) {
  const name = validateSystemName(req.params.name);
  sendJson(res, 200, await catalogAdmin.deleteSystem(name, req.user.username));
}

// ── nodes the version lookup could not place ──────────────────────────────────────────────

export async function listUnclassified(req, res) {
  const filter = ['pending', 'assigned', 'all'].includes(req.query.get('filter'))
    ? req.query.get('filter') : 'all';
  sendJson(res, 200, {
    nodes: await systems.listUnclassified({
      limit: intParam(req.query.get('limit'), 200, 1000), filter,
    }),
  });
}

/**
 * The admin review step. Send {"system": null} to put a node back in the pending list.
 *
 * This is the only way to classify a device whose version this server never published — a
 * factory-fresh unit, or one flashed by hand. Nothing resolves itself with time.
 */
export async function assignNode(req, res) {
  const serial = validateSerial(req.params.serial);
  const body = await readJsonBody(req);
  const system = body.system === null || body.system === undefined
    ? null
    : validateSystemName(body.system);

  sendJson(res, 200, {
    ok: true, ...await catalogAdmin.assignNodeSystem(serial, system, req.user.username),
  });
}

export async function forgetNode(req, res) {
  const serial = validateSerial(req.params.serial);
  if (!await systems.forgetNode(serial)) throw notFound(`No unclassified node ${serial}`);

  await insertAudit({ actor: req.user.username, action: 'node.forget', subject: serial });
  sendJson(res, 200, { ok: true, serial });
}

export async function createRelease(req, res) {
  const input = validateReleaseBody(await readJsonBody(req));
  sendJson(res, 201, await catalogAdmin.createRelease(input, req.user.username));
}

export async function updateRelease(req, res) {
  const version = validateVersionParam(req.params.version);
  const changes = validateReleaseBody(await readJsonBody(req), { partial: true });
  sendJson(res, 200, await catalogAdmin.updateRelease(version, changes, req.user.username));
}

export async function deleteRelease(req, res) {
  const version = validateVersionParam(req.params.version);
  sendJson(res, 200, await catalogAdmin.deleteRelease(version, req.user.username));
}

/**
 * POST /admin/api/artifacts                          — version comes from the bundle
 * POST /admin/api/releases/:version/artifacts        — version asserted, cross-checked
 *
 * The raw body is the .tar.gz. Everything that does not depend on the version is validated
 * here, before a byte is read, so a malformed query never costs a full upload.
 */
/**
 * POST /admin/api/uploads — step one: open the bundle and say what it holds, storing nothing.
 *
 * The point of splitting the upload is that an operator reads the version, the plugins, the
 * config params and the diff BEFORE any of it is in the catalog. Nothing here writes a row.
 */
export async function stageUpload(req, res) {
  const { kind, platforms } = validateUploadQuery(req.query);
  const expectedSha256 = validateExpectedSha256(req.headers['x-expected-sha256']);

  const staged = await publish.stageUpload(req, {
    version: null, kind, platforms, expectedSha256,
  });

  const diff = await diffForInspection(staged.inspection, staged, staged.system);

  sendJson(res, 200, {
    token: staged.token,
    version: staged.version,
    system: staged.system,
    kind: staged.kind,
    platform: staged.platform,
    platforms: staged.platforms,
    size: staged.size,
    sha256: staged.sha256,
    // Nothing is stored yet, and the panel says so. Without it an operator reads this screen
    // as "done" — it looks exactly like the old one, which came after the write.
    stored: false,
    diff: { ...diff, no_op: isNoOp(diff) },
    inspection: publish.serializeInspection(staged.inspection),
  });
}

/**
 * POST /admin/api/uploads/:token — step two: commit what was staged, onto beta.
 *
 * No channel to choose. A release lands on beta and reaches stable only when an admin
 * promotes it, so this call takes no target.
 */
export async function commitUpload(req, res) {
  const { kind, platforms } = validateUploadQuery(req.query);

  const { artifact, inspection, releaseCreated, promoted, system } = await publish.commitUpload(
    req.params.token,
    { kind, platforms, channel: config.stagingChannel, actor: req.user.username },
  );

  const diff = await diffAgainstPrevious(artifact, system);

  sendJson(res, 201, {
    ...serializeArtifact(artifact),
    release_created: releaseCreated,
    promoted_to: promoted,
    system,
    stored: true,
    diff: { ...diff, no_op: isNoOp(diff) },
    inspection: publish.serializeInspection(inspection),
  });
}

export async function uploadArtifact(req, res) {
  const version = req.params.version ? validateVersionParam(req.params.version) : null;
  const { kind, platforms, channel } = validateUploadQuery(req.query);
  const expectedSha256 = validateExpectedSha256(req.headers['x-expected-sha256']);
  // Pre-signed uploads carry the signature and the published_at it was signed over; both
  // are absent on an ordinary one. See docs/ota-presigned-artifacts.md.
  const signature = validateSignatureHeaders(req.headers);
  const publishedAt = validatePublishedAt(req.headers['x-published-at'],
                                          { required: Boolean(signature) });

  const { artifact, inspection, releaseCreated, promoted, system } = await publish.uploadArtifact(req, {
    version, kind, platforms, channel, expectedSha256, signature, publishedAt,
    actor: req.user.username,
  });

  // Against the previous release OF THIS SYSTEM. Passing it explicitly also saves the lookup
  // diffAgainstPrevious would otherwise do to find it.
  const diff = await diffAgainstPrevious(artifact, system);

  sendJson(res, 201, {
    ...serializeArtifact(artifact),
    release_created: releaseCreated,
    promoted_to: promoted,
    system,
    // What promoting this would actually change. Nothing else in the system answers that: the
    // node reports a release that changes nothing exactly like one that changes everything.
    diff: { ...diff, no_op: isNoOp(diff) },
    inspection: publish.serializeInspection(inspection),
  });
}

/** GET /admin/api/artifacts/:id — the artifact plus its stored inspection report. */
export async function getArtifact(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw invalidParameter(`invalid artifact id: ${req.params.id}`);

  const artifact = await catalog.findArtifactById(id);
  if (!artifact) throw notFound(`No artifact ${id}`);

  sendJson(res, 200, { ...serializeArtifact(artifact), inspection: artifact.inspection });
}

/** GET /admin/api/artifacts/:id/diff — what changes against the release below this one. */
export async function getArtifactDiff(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw invalidParameter(`invalid artifact id: ${req.params.id}`);

  const artifact = await catalog.findArtifactById(id);
  if (!artifact) throw notFound(`No artifact ${id}`);

  const diff = await diffAgainstPrevious(artifact);
  sendJson(res, 200, { ...diff, no_op: isNoOp(diff) });
}

export async function deleteArtifact(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw invalidParameter(`invalid artifact id: ${req.params.id}`);
  sendJson(res, 200, await catalogAdmin.deleteArtifact(id, req.user.username));
}

export async function setArtifactMetadata(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw invalidParameter(`invalid artifact id: ${req.params.id}`);

  const metadata = validateArtifactMetadata(await readJsonBody(req));
  const artifact = await catalogAdmin.setArtifactMetadata(id, metadata, req.user.username);
  sendJson(res, 200, serializeArtifact(artifact));
}

export async function getChannel(req, res) {
  const system = validateSystemName(req.params.system);
  const name = validateChannelName(req.params.name);
  const channel = await catalog.getChannel(system, name);
  if (!channel) throw notFound(`No channel ${system}/${name}`);

  sendJson(res, 200, {
    system: channel.system,
    name: channel.name,
    latest: channel.latest,
    updated_at: channel.updatedAt,
    pins: Object.fromEntries(channel.pin),
    denies: [...channel.deny],
  });
}

export async function putChannel(req, res) {
  const system = validateSystemName(req.params.system);
  const name = validateChannelName(req.params.name);
  const changes = validateChannelBody(await readJsonBody(req));
  const channel = await catalogAdmin.upsertChannel(system, name, changes, req.user.username);

  sendJson(res, 200, {
    system: channel.system,
    name: channel.name,
    latest: channel.latest,
    // Channels this version was taken off, so the caller can say what else moved.
    released: channel.released ?? [],
  });
}

export async function fleet(req, res) {
  sendJson(res, 200, {
    nodes: await telemetry.fleetInventory({ limit: intParam(req.query.get('limit'), 500, 2000) }),
  });
}

export async function reports(req, res) {
  const version = req.query.get('version');
  const [stats, recent] = await Promise.all([
    telemetry.rolloutStats(version || null),
    telemetry.recentReports({ limit: intParam(req.query.get('limit'), 50, 500) }),
  ]);
  sendJson(res, 200, { version: version || null, stats, recent });
}

export async function audit(req, res) {
  sendJson(res, 200, {
    entries: await listAudit({ limit: intParam(req.query.get('limit'), 100, 500) }),
  });
}

/** The exact string an operator provisions into a node's key_id -> public key map. */
/**
 * GET /admin/api/api-keys — the fleet keys, so a device can be provisioned without shell access
 * to the server.
 *
 * Every read is audited. The key is a **shared** credential: every node presents the same
 * string, so seeing it is equivalent to being able to impersonate any node, and rotating it
 * means re-provisioning the whole fleet. That is why the read leaves a trace even though the
 * caller is already an authenticated admin.
 */
export async function apiKeys(req, res) {
  const keys = fleetApiKeys();

  await insertAudit({
    actor: req.user.username,
    action: 'apikey.read',
    subject: keys.map((entry) => entry.fleet).join(', ') || '(none configured)',
    detail: { count: keys.length },
  });

  sendJson(res, 200, {
    keys,
    // Said in the payload, not only in the UI: anything that consumes this endpoint should be
    // able to repeat the warning without knowing the deployment.
    shared: true,
    note: 'One key is shared by every node in a fleet. Rotating it means re-provisioning them '
      + 'all, and it is configured with UPDATE_API_KEYS, not in the database.',
  });
}

export async function signingKey(req, res) {
  // With SIGNING_REQUIRE_PRESIGNED there is no local key pair at all, and asking for its
  // public half throws. That is the goal state, not an error — report it as such, and keep
  // this endpoint answering so fleet-vs-server fingerprint monitoring keeps working.
  let local = null;
  try {
    local = getPublicKeyBase64();
  } catch {
    local = null;
  }

  sendJson(res, 200, {
    key_id: getKeyId(),
    public_key_base64: local,
    algorithm: 'ed25519',
    key_file: local ? config.signingKeyFile : null,
    holds_private_key: local !== null,
    root_key_id: config.rootKeyId || null,
    root_public_key_base64: config.rootPublicKey || null,
    trusted_key_ids: [...config.signingTrustedKeys.keys()],
    certificates: (await listCerts()).map((c) => ({
      key_id: c.keyId,
      public_key: c.publicKey,
      root_key_id: c.rootKeyId,
      not_before: c.notBefore,
      not_after: c.notAfter,
      uploaded_at: c.uploadedAt,
      uploaded_by: c.uploadedBy,
    })),
  });
}

/**
 * PUT /admin/api/signing-key/certificate — store a root-signed key certificate.
 *
 * Verified against the configured root BEFORE it is stored: a certificate this server cannot
 * verify is one no node could verify either, and storing it would publish manifests the whole
 * fleet rejects with a reason that looks like a compromised key.
 */
export async function putSigningKeyCertificate(req, res) {
  const cert = validateKeyCertificateBody(await readJsonBody(req));

  const verdict = verifyKeyCertificate(cert);
  if (!verdict.ok) throw invalidParameter(`key certificate rejected: ${verdict.reason}`);

  const stored = await putCert(cert, req.user.username);
  await insertAudit({
    actor: req.user.username,
    action: 'signing.certificate.put',
    subject: cert.keyId,
    detail: { root_key_id: cert.rootKeyId, not_after: cert.notAfter },
  });

  sendJson(res, 200, {
    key_id: stored.keyId,
    public_key: stored.publicKey,
    root_key_id: stored.rootKeyId,
    not_before: stored.notBefore,
    not_after: stored.notAfter,
    uploaded_at: stored.uploadedAt,
  });
}

export async function tls(req, res) {
  sendJson(res, 200, getTlsInfo());
}

/**
 * GET /admin/api/users — accounts in the Keycloak realm.
 *
 * Answers with `configured: false` rather than an error when Keycloak is not wired up, so
 * the admin UI can hide the panel instead of showing a broken one.
 */
export async function listUsersHandler(req, res) {
  if (!keycloakAdminConfigured()) {
    sendJson(res, 200, { configured: false, users: [] });
    return;
  }
  const users = await listUsers({
    limit: intParam(req.query.get('limit'), 50, 200),
    search: req.query.get('search') ?? '',
  });
  sendJson(res, 200, { configured: true, users });
}

/**
 * POST /admin/api/users — create an account in Keycloak.
 *
 * The account is granted NO roles. It can sign in and will see nothing until an admin
 * assigns one — see keycloakAdmin.service.js for why that is not optional while this
 * server's authorisation is still binary.
 */
export async function createUserHandler(req, res) {
  const input = validateNewUser(await readJsonBody(req));
  const created = await createUser(input);

  await insertAudit({
    actor: req.user.username,
    action: 'user.create',
    subject: created.username,
    // Never the password, not even its length.
    detail: { id: created.id, email: created.email, role: created.role },
  });

  sendJson(res, 201, {
    ...created,
    note: created.role
      ? `Granted the "${created.role}" role. The temporary password must be changed at `
        + 'first sign-in.'
      : 'No role was granted' + (created.roleError ? ` (${created.roleError})` : '')
        + '. The account can sign in but should not be given an admin session until one '
        + 'is assigned.',
  });
}

function serializeArtifact(artifact) {
  return {
    id: artifact.id,
    version: artifact.version,
    kind: artifact.kind,
    platform: artifact.platform,
    platforms: artifact.platforms,
    file: artifact.file,
    size: artifact.size,
    sha256: artifact.sha256,
    pre_signed: Boolean(artifact.signature),
    uploaded_at: artifact.uploadedAt,
    uploaded_by: artifact.uploadedBy,
    // NULL means the row predates bundle inspection, which is not the same as 'legacy'.
    bundle_format: artifact.bundleFormat,
    warning_count: artifact.inspection?.warnings?.length ?? 0,
    plugins: Object.fromEntries(
      [...artifact.plugins].map(([platform, map]) => [
        platform,
        Object.fromEntries([...map].map(([name, entry]) => [name, entry.version])),
      ]),
    ),
    plugins_unknown: [...artifact.plugins].flatMap(([platform, map]) =>
      [...map].filter(([, entry]) => !entry.known).map(([name]) => `${platform}/${name}`)),
    config: Object.fromEntries(artifact.config),
  };
}
