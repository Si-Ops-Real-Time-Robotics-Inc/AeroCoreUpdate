import { config } from '../config/index.js';
import { invalidParameter, missingParameter } from '../core/errors.js';
import { isValidVersion } from '../domain/version.js';
import { isValidPlatform } from '../domain/platform.js';


// Bounded and printable, because this value reaches the log line, the admin UI and the ETag.
// Deliberately permissive about WHICH name — the server does not get to decide what an
// operator calls a product, only that it cannot be an injection vector or a novel.
const MAX_SYSTEM_LENGTH = 64;
const SYSTEM_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const PLUGIN_ENTRY_RE = /^[A-Za-z0-9_.-]+@\d+(\.\d+)*$/;

/** Absent OR empty is "missing" (spec section 1); present but malformed is "invalid". */
function required(value, name) {
  if (value === null || value === undefined || value === '') throw missingParameter(name);
  return value;
}

export function validateCheckQuery(query) {
  const serial = required(query.get('serial'), 'serial');
  const platform = required(query.get('platform'), 'platform');
  const version = required(query.get('version'), 'version');

  if (!isValidVersion(version)) throw invalidParameter(`version is not a dotted numeric version: ${version}`);
  if (!isValidPlatform(platform)) throw invalidParameter(`unknown platform: ${platform}`);

  const channel = query.get('channel') || 'stable';

  // No `role`. The node hardcodes it to "GCS" (UpdateService.cpp), so it was a constant
  // travelling on every request and recorded on every row — a field that could never
  // distinguish anything. It still means something in the fleet form below, where one entry
  // really is the GCS and the others are not. A node that still sends it is ignored rather
  // than refused: devices in the field keep the parameter until they are rebuilt.
  return {
    serial,
    platform,
    version,
    system: parseSystem(query.get('system'), 'system'),
    channel,
    plugins: parsePluginList(query.get('plugins')),
  };
}

/**
 * The system a node claims to be, from its own manifest.
 *
 * Absent and blank are the same thing: a build that was not stamped omits the parameter
 * entirely, so treating an empty value as an error would refuse a fleet that is merely older.
 *
 * A name this server does not have is NOT rejected here. That is a placement decision, not a
 * malformed request — the node is reporting a fact about itself, and the server answers by
 * offering nothing and recording the sighting (spec section 2, Placing a node). Only shapes
 * that could not be a system name at all are refused, because they end up in logs and in the
 * admin UI.
 */
function parseSystem(raw, field) {
  if (typeof raw !== 'string') return null;

  const name = raw.trim();
  if (!name) return null;

  if (name.length > MAX_SYSTEM_LENGTH) {
    throw invalidParameter(`${field} must be at most ${MAX_SYSTEM_LENGTH} characters`);
  }
  if (!SYSTEM_NAME.test(name)) {
    throw invalidParameter(`${field} contains characters a system name cannot have: ${name}`);
  }
  return name;
}

/** "Name@1.2.0,Other@2.0.1" -> Map. An empty value is treated as absent, not as an error. */
function parsePluginList(raw) {
  if (!raw) return null;
  const map = new Map();
  for (const entry of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    if (!PLUGIN_ENTRY_RE.test(entry)) throw invalidParameter(`malformed plugins entry: ${entry}`);
    const at = entry.lastIndexOf('@');
    map.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return map.size ? map : null;
}

export function validateDownloadRequest(params, query) {
  // Three things identify a download, and all three are required. A caller never composes this
  // URL — the check response hands it over complete — so a request missing any of them is
  // something that built the URL itself.
  const version = required(params.version, 'version');
  if (!isValidVersion(version)) throw invalidParameter(`version is not a dotted numeric version: ${version}`);

  const system = parseSystem(query.get('system'), 'system');
  if (!system) throw missingParameter('system');

  const platform = required(query.get('platform'), 'platform');
  if (!isValidPlatform(platform)) throw invalidParameter(`unknown platform: ${platform}`);

  return { version, system, platform };
}

/**
 * Reports are accepted leniently: the OpenAPI declares no 400 for /report, and the node
 * treats a failure here as non-fatal, so rejecting on schema would be pointless noise.
 */
export function normalizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const pick = (value) => (typeof value === 'string' ? value : undefined);
  return {
    ...body,
    serial: pick(body.serial),
    platform: pick(body.platform),
    role: pick(body.role),
    from_version: pick(body.from_version),
    to_version: pick(body.to_version),
    result: pick(body.result),
    error: pick(body.error) ?? '',
    at: pick(body.at),
  };
}
