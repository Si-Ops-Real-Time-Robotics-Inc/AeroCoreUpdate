import { config } from '../config/index.js';

/**
 * Platform strings and the canonical `target` set, per update-server-api.md sections 1 and 7.
 * Treat a platform as an opaque string and match it exactly; never parse it apart.
 */

/** The Platform enum from update-server-openapi.json. */
export const KNOWN_PLATFORMS = [
  'linux-x86_64', 'linux-aarch64', 'linux-arm', 'linux-x86',
  'windows-x86_64', 'windows-aarch64', 'windows-x86',
  'android-aarch64', 'android-x86_64', 'android-arm', 'android-x86',
  'macos-x86_64', 'macos-aarch64',
];

const PLATFORM_RE = /^[a-z0-9]+-[a-z0-9_]+$/;

export function isValidPlatform(value) {
  if (typeof value !== 'string' || !PLATFORM_RE.test(value)) return false;
  return config.strictPlatforms ? KNOWN_PLATFORMS.includes(value) : true;
}

/** An Android core binary cannot be replaced over the air (section 5). */
export function isAndroid(platform) {
  return typeof platform === 'string' && platform.startsWith('android-');
}

/**
 * The platform set an artifact covers, canonicalised so both sides derive the same signed
 * string: sorted ascending in byte order, comma-joined, no spaces. Duplicates are dropped —
 * a catalog listing a platform twice would otherwise change the signature.
 */
export function canonicalTarget(platforms) {
  return [...new Set(platforms)].sort().join(',');
}

/** Step 2 of section 7 verification: is this platform inside that target set? */
export function targetIncludes(target, platform) {
  return target.split(',').includes(platform);
}
