import { config } from '../config/index.js';
import { invalidParameter, missingParameter } from '../core/errors.js';
import { isValidVersion } from '../domain/version.js';
import { isValidPlatform } from '../domain/platform.js';

const SHA256_RE = /^[0-9a-f]{64}$/i;

export function validateVersionParam(raw) {
  if (!raw) throw missingParameter('version');
  if (!isValidVersion(raw)) throw invalidParameter(`version is not a dotted numeric version: ${raw}`);
  return raw;
}

export function validateReleaseBody(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') throw missingParameter('body');

  const out = {};
  if (!partial) {
    out.version = validateVersionParam(body.version);
    // Which kind of device this release is for. Omitted means the default system, so an
    // installation that only ever ships one thing never has to think about it.
    if (body.system !== undefined && body.system !== null) {
      out.system = validateSystemName(body.system);
    }
  } else if (body.system !== undefined) {
    // Moving a release between systems would re-classify every node reporting that version,
    // in both directions at once. Delete and re-publish instead.
    throw invalidParameter(
      'a release cannot change system: the version is what identifies a node\'s system, so '
      + 'moving it would silently re-classify every device running it',
    );
  }

  if (body.min_version !== undefined && body.min_version !== null) {
    if (!isValidVersion(body.min_version)) throw invalidParameter(`min_version is invalid: ${body.min_version}`);
    out.minVersion = body.min_version;
  }
  if (body.system !== undefined && body.system !== null) {
    out.system = validateSystemName(body.system);
  }
  if (body.mandatory !== undefined) out.mandatory = Boolean(body.mandatory);
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') throw invalidParameter('notes must be a string');
    out.notes = body.notes;
  }
  if (body.published_at !== undefined && body.published_at !== null) {
    const when = new Date(body.published_at);
    if (Number.isNaN(when.getTime())) throw invalidParameter('published_at must be an RFC 3339 timestamp');
    out.publishedAt = when.toISOString();
  }
  return out;
}

/**
 * Upload query parameters. Since the server now reads the bundle, these are ASSERTIONS the
 * caller may make, not facts it must supply: the version and platform set come from the
 * bundle's own manifest.json and anything given here is cross-checked against it.
 *
 * `?platforms=` is still required for a config-only bundle, which covers no platform of its
 * own — that check lives in the domain's crossCheck, where the bundle contents are known.
 */
export function validateUploadQuery(query) {
  const rawKind = query.get('kind');
  if (rawKind && !['fleet', 'slim'].includes(rawKind)) {
    throw invalidParameter("kind must be 'fleet' or 'slim'");
  }

  const raw = query.get('platforms') || query.get('platform') || '';
  const platforms = raw.split(',').map((item) => item.trim()).filter(Boolean);
  for (const platform of platforms) {
    if (!isValidPlatform(platform)) throw invalidParameter(`unknown platform: ${platform}`);
  }

  // ?channel= overrides the automatic promotion target; ?channel= (empty) disables it for
  // this one upload.
  const rawChannel = query.get('channel');
  const channel = rawChannel === null
    ? config.autoPromoteChannel
    : (rawChannel === '' ? '' : validateChannelName(rawChannel));

  return { kind: rawKind || null, platforms: [...new Set(platforms)], channel: channel || null };
}

export function validateExpectedSha256(header) {
  if (header === undefined || header === '') return null;
  if (typeof header !== 'string' || !SHA256_RE.test(header)) {
    throw invalidParameter('X-Expected-Sha256 must be 64 hex characters');
  }
  return header.toLowerCase();
}

/**
 * The signature headers of a pre-signed upload, or null when it is an ordinary one.
 *
 * All three or none. A partially-present set is an ERROR and never a quiet fallback to
 * server-side signing: a pipeline that meant to sign and misspelled a header name has to
 * find out here, not by shipping an artifact signed by something else entirely.
 */
export function validateSignatureHeaders(headers) {
  const alg = headers['x-signature-alg'];
  const keyId = headers['x-signature-key-id'];
  const value = headers['x-signature-value'];

  const present = [alg, keyId, value].filter((v) => v !== undefined && v !== '');
  if (present.length === 0) return null;
  if (present.length !== 3) {
    throw missingParameter(
      'X-Signature-Alg, X-Signature-Key-Id and X-Signature-Value must be sent together',
    );
  }
  if (alg !== 'ed25519') throw invalidParameter(`unsupported signature alg: ${alg}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw invalidParameter('X-Signature-Key-Id is malformed');
  }
  if (Buffer.from(value, 'base64').length !== 64) {
    throw invalidParameter('X-Signature-Value must be base64 of a 64-byte ed25519 signature');
  }
  if (!config.signingTrustedKeys.has(keyId)) {
    throw invalidParameter(
      `unknown signing key_id "${keyId}" — add its public key to SIGNING_TRUSTED_KEYS`,
    );
  }
  return { alg, key_id: keyId, value };
}

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * `published_at` supplied by the signer, because it is one of the six SIGNED fields and the
 * server's own now() is a value CI cannot possibly know at signing time.
 *
 * Strict to the second, UTC, Z-suffixed: any formatting difference between what was signed
 * and what is served rejects the release on every node at once, with a symptom that looks
 * exactly like a key problem.
 */
export function validatePublishedAt(header, { required = false } = {}) {
  if (header === undefined || header === '') {
    if (required) {
      throw missingParameter(
        'X-Published-At is required for a pre-signed upload: it is part of the signed payload',
      );
    }
    return null;
  }
  if (typeof header !== 'string' || !RFC3339_UTC.test(header)) {
    throw invalidParameter(
      'X-Published-At must be RFC3339 UTC to the second, e.g. 2026-07-30T04:15:00Z',
    );
  }
  // A typo here parks the release beyond every node's clock, and a node whose own clock is
  // sane would refuse it indefinitely without explaining why.
  if (Date.parse(header) > Date.now() + 24 * 3600 * 1000) {
    throw invalidParameter('X-Published-At is more than 24h in the future');
  }
  return header;
}

/**
 * A key certificate as uploaded by an operator, produced offline by signing the four-field
 * payload with the ROOT key. Shape only — signing.service.verifyKeyCertificate decides
 * whether it is genuine.
 */
export function validateKeyCertificateBody(body) {
  if (!body || typeof body !== 'object') throw missingParameter('body');
  if (body.alg !== undefined && body.alg !== 'ed25519') {
    throw invalidParameter(`unsupported alg: ${body.alg}`);
  }

  const str = (field, wire) => {
    const v = body[wire];
    if (typeof v !== 'string' || v === '') throw missingParameter(wire);
    return v;
  };

  const keyId = str('keyId', 'key_id');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw invalidParameter('key_id is malformed');

  const notBefore = str('notBefore', 'not_before');
  const notAfter = str('notAfter', 'not_after');
  for (const [wire, v] of [['not_before', notBefore], ['not_after', notAfter]]) {
    if (!RFC3339_UTC.test(v)) {
      throw invalidParameter(`${wire} must be RFC3339 UTC to the second, e.g. 2026-07-30T00:00:00Z`);
    }
  }
  // The node compares against these verbatim, so a backwards window would be a certificate
  // that can never be valid on any device.
  if (Date.parse(notAfter) <= Date.parse(notBefore)) {
    throw invalidParameter('not_after must be later than not_before');
  }

  return {
    keyId,
    publicKey: str('publicKey', 'public_key'),
    notBefore,
    notAfter,
    rootKeyId: str('rootKeyId', 'root_key_id'),
    certValue: str('certValue', 'value'),
  };
}

export function validateArtifactMetadata(body) {
  if (!body || typeof body !== 'object') throw missingParameter('body');

  const plugins = body.plugins ?? {};
  const config = body.config ?? {};

  if (typeof plugins !== 'object' || Array.isArray(plugins)) {
    throw invalidParameter('plugins must be an object keyed by platform');
  }
  for (const [platform, entries] of Object.entries(plugins)) {
    if (!isValidPlatform(platform)) throw invalidParameter(`unknown platform: ${platform}`);
    if (typeof entries !== 'object' || Array.isArray(entries)) {
      throw invalidParameter(`plugins.${platform} must be an object of name -> version`);
    }
    for (const [name, version] of Object.entries(entries)) {
      if (!isValidVersion(version)) throw invalidParameter(`plugin ${name} version is invalid: ${version}`);
    }
  }

  if (typeof config !== 'object' || Array.isArray(config)) {
    throw invalidParameter('config must be an object keyed by platform');
  }
  for (const [platform, changes] of Object.entries(config)) {
    if (!isValidPlatform(platform)) throw invalidParameter(`unknown platform: ${platform}`);
    if (!Array.isArray(changes)) throw invalidParameter(`config.${platform} must be an array`);
    for (const change of changes) {
      if (!change || typeof change.target !== 'string' || typeof change.param !== 'string') {
        throw invalidParameter(`config.${platform} entries need target and param`);
      }
      if (change.to === undefined) throw invalidParameter(`config.${platform} entries need a "to" value`);
    }
  }

  return { plugins, config };
}

export function validateChannelBody(body) {
  if (!body || typeof body !== 'object') throw missingParameter('body');
  const out = {};
  if (body.latest !== undefined && body.latest !== null) {
    out.latest = validateVersionParam(body.latest);
  }
  // Deliberate rollback. Not counted as a change on its own — on its own there is nothing to
  // allow.
  if (body.allow_rollback !== undefined) out.allowRollback = Boolean(body.allow_rollback);
  if (out.latest === undefined) {
    throw invalidParameter('nothing to change: send latest');
  }
  return out;
}

export function validateSerial(raw) {
  if (!raw) throw missingParameter('serial');
  if (raw.length > 128) throw invalidParameter('serial is too long');
  return raw;
}

export function validateSystemName(raw) {
  if (!raw) throw missingParameter('system');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(raw)) throw invalidParameter(`invalid system name: ${raw}`);
  return raw;
}

export function validateSystemBody(body) {
  if (!body || typeof body !== 'object') throw missingParameter('body');
  const out = { name: validateSystemName(body.name) };
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') throw invalidParameter('description must be a string');
    out.description = body.description;
  }
  return out;
}

export function validateChannelName(raw) {
  if (!raw) throw missingParameter('channel');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(raw)) throw invalidParameter(`invalid channel name: ${raw}`);
  return raw;
}
