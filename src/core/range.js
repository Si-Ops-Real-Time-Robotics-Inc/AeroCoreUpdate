/**
 * Range header parsing for the download endpoint (spec section 6).
 *
 * Returns one of:
 *   { type: 'none' }                        -> serve the whole body, 200
 *   { type: 'unsatisfiable' }               -> caller throws 416
 *   { type: 'satisfiable', start, end }     -> 206, end inclusive
 *
 * Only `bytes=N-` is required by the spec — that is what a resuming node sends. The other
 * forms are supported because they are free.
 */
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return NONE;

  const value = header.trim();
  // RFC 9110: an unknown range unit must be ignored, not rejected.
  if (!value.toLowerCase().startsWith('bytes=')) return NONE;

  const spec = value.slice(6).trim();

  // Multi-range is explicitly not required; section 6 says reject it with 416.
  if (spec.includes(',')) return UNSATISFIABLE;
  if (size === 0) return UNSATISFIABLE;

  const dash = spec.indexOf('-');
  if (dash < 0) return NONE;

  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  // Suffix form: bytes=-N means the last N bytes.
  if (rawStart === '') {
    if (!/^\d+$/.test(rawEnd)) return NONE;
    const suffix = Number(rawEnd);
    if (suffix === 0) return UNSATISFIABLE;
    return satisfiable(Math.max(0, size - suffix), size - 1);
  }

  if (!/^\d+$/.test(rawStart)) return NONE;
  const start = Number(rawStart);
  if (start >= size) return UNSATISFIABLE;

  if (rawEnd === '') return satisfiable(start, size - 1);
  if (!/^\d+$/.test(rawEnd)) return NONE;

  const end = Math.min(Number(rawEnd), size - 1);
  if (start > end) return UNSATISFIABLE;
  return satisfiable(start, end);
}

const NONE = Object.freeze({ type: 'none' });
const UNSATISFIABLE = Object.freeze({ type: 'unsatisfiable' });
const satisfiable = (start, end) => ({ type: 'satisfiable', start, end });
