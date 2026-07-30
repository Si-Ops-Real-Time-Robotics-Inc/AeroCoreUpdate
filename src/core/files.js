import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { logger } from './logger.js';
import { payloadTooLarge } from './errors.js';

/** Client aborts are the expected case on a field link, not a server fault. */
const CLIENT_ABORT = new Set([
  'ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED',
]);

/**
 * Stream a byte range of a file. Content-Length is set exactly — section 6 makes it
 * mandatory, because the node uses it for progress and to reject a truncated body early.
 */
export async function sendFile(req, res, { filePath, start, end, status = 200, headers = {} }) {
  const length = end - start + 1;
  res.writeHead(status, { ...headers, 'Content-Length': String(length) });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  try {
    await pipeline(fs.createReadStream(filePath, { start, end }), res);
  } catch (err) {
    if (CLIENT_ABORT.has(err.code)) {
      logger.info(`download aborted by client: ${path.basename(filePath)}`);
      return;
    }
    if (res.headersSent) {
      logger.error('download failed mid-stream', err);
      res.destroy();
      return;
    }
    throw err;
  }
}

/** Streaming SHA-256. A 24 MB fleet bundle must never be read into memory. */
export async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Stream a request body to a temporary file, hashing and counting as it goes so the file is
 * never read a second time. The caller renames it into place once it is happy.
 */
export async function receiveToTempFile(req, { dir, limit }) {
  await fsp.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `${crypto.randomUUID()}.part`);

  const hash = crypto.createHash('sha256');
  let size = 0;
  const handle = await fsp.open(tempPath, 'w');

  try {
    const stream = handle.createWriteStream();
    await pipeline(
      req,
      async function* count(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > limit) throw payloadTooLarge(`Upload exceeds ${limit} bytes`);
          hash.update(chunk);
          yield chunk;
        }
      },
      stream,
    );
  } catch (err) {
    await fsp.rm(tempPath, { force: true });
    throw err;
  } finally {
    await handle.close().catch(() => {});
  }

  return { tempPath, size, sha256: hash.digest('hex') };
}

/** Delete leftover .part files from uploads that died mid-flight. */
export async function pruneTempFiles(dir, maxAgeMs = 3600_000) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.part')) continue;
    const full = path.join(dir, entry);
    try {
      const stat = await fsp.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fsp.rm(full, { force: true });
        removed += 1;
      }
    } catch { /* raced with another prune */ }
  }
  return removed;
}
