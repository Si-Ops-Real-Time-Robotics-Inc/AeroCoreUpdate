/**
 * SHA-256 of a file, as lowercase hex.
 *
 * Sent ahead of the bytes as `X-Expected-SHA256` so the server can refuse a
 * corrupted or truncated transfer BEFORE it stores anything. Without it the
 * server would have to read and keep the whole upload to discover it was wrong.
 *
 * Two constraints are worth knowing before changing this:
 *
 * 1. `crypto.subtle` exists only in a secure context. That is satisfied here —
 *    the admin surface is HTTPS only, and the dev server runs on localhost,
 *    which counts as secure.
 * 2. Web Crypto has no streaming digest, so the whole file is held in memory.
 *    With the default `UPLOAD_MAX_BYTES` of 512 MB that is a real allocation and
 *    a small machine may fail on the largest allowed bundle. The alternative is
 *    an incremental SHA-256, which means a package or a hand-written one — a
 *    cost this project does not pay for a problem nobody has reported.
 */
export async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
