/**
 * Version ordering, per update-server-api.md section 1.
 *
 * Dotted numeric, compared COMPONENT-WISE AS INTEGERS with the shorter side zero-padded:
 *   0.9.0  < 0.10.0     (a string compare says the opposite and silently inverts a rollout)
 *   1.0   == 1.0.0
 *
 * Nothing outside this module may order version strings. That includes SQL: sort on the
 * release.version_key int[] column, never `ORDER BY version`.
 */

export const VERSION_RE = /^\d+(\.\d+)*$/;

export function isValidVersion(value) {
  return typeof value === 'string' && value.length > 0 && VERSION_RE.test(value);
}

/** '0.13.3' -> [0, 13, 3]. Throws on anything that is not a dotted numeric version. */
export function parseVersion(value) {
  if (!isValidVersion(value)) throw new TypeError(`Invalid version: ${value}`);
  return value.split('.').map(Number);
}

/** -1 | 0 | 1, component-wise over integers with the shorter side zero-padded. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `a` is strictly newer than `b`. */
export function isNewer(a, b) {
  return compareVersions(a, b) > 0;
}
