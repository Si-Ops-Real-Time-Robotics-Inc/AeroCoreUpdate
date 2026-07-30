import fsp from 'node:fs/promises';
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Minimal streaming tar(.gz) reader.
 *
 * It exists because Node ships gzip but no tar parser, and shelling out to `tar` would be a
 * hidden runtime dependency (the runtime image only has BusyBox tar). It knows the tar
 * container and nothing about what the archive is for.
 *
 * The whole stream is read once, start to finish. Tar has no central directory, so there is
 * nothing to seek to, and gzip cannot be seeked at all — bodies we do not want are read and
 * discarded rather than buffered, which keeps memory flat regardless of archive size.
 */

const BLOCK = 512;

export class TarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TarError';
    this.code = code;
  }
}

const DEFAULTS = {
  maxMemberBytes: 1024 * 1024,
  maxSelectedBytes: 8 * 1024 * 1024,
  maxEntries: 50_000,
  maxInflatedBytes: Infinity,
  maxHeaderBodyBytes: 64 * 1024,
};

/**
 * @param {import('node:stream').Readable} source  a PLAIN tar stream (already decompressed)
 * @param {object} options
 * @param {(name: string, size: number) => boolean} [options.select] which bodies to retain
 * @returns {Promise<{names: Set<string>, files: Map<string, Buffer>, oversize: string[], entries: number}>}
 */
export async function readTar(source, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const select = opts.select ?? (() => false);

  const names = new Set();
  const files = new Map();
  const oversize = [];

  let entries = 0;
  let selectedBytes = 0;
  let inflated = 0;
  let sawValidHeader = false;
  let zeroBlocks = 0;
  let done = false;

  // Names carried by a GNU 'L' record or a pax 'x' record, applying to the NEXT member.
  let pendingGnuName = null;
  let pendingPaxName = null;

  const reader = new BlockReader(source);

  try {
    while (!done) {
      const header = await reader.read(BLOCK);
      if (header === null) {
        // A clean end without the two zero blocks. Every real tool accepts this, and
        // truncated padding is common, so only complain if we never saw a valid header.
        if (!sawValidHeader) throw new TarError('not_tar', 'No tar header found');
        break;
      }
      if (header.length < BLOCK) {
        if (!sawValidHeader) throw new TarError('not_tar', 'Stream is shorter than one tar header');
        throw new TarError('truncated', 'Stream ends in the middle of a tar header');
      }

      inflated += BLOCK;
      if (inflated > opts.maxInflatedBytes) {
        throw new TarError('inflate_budget',
          `Archive expands beyond the ${opts.maxInflatedBytes} byte inspection budget`);
      }

      if (isZeroBlock(header)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break; // end of archive; anything after it is padding
        continue;
      }
      zeroBlocks = 0;

      if (!checksumOk(header)) {
        // This is what separates a real tar from bytes that merely happen to be 512-aligned.
        if (!sawValidHeader) throw new TarError('not_tar', 'The first block is not a tar header');
        throw new TarError('truncated', 'Corrupt tar header mid-archive');
      }
      sawValidHeader = true;

      const size = parseSize(header);
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      inflated += padded;
      if (inflated > opts.maxInflatedBytes) {
        throw new TarError('inflate_budget',
          `Archive expands beyond the ${opts.maxInflatedBytes} byte inspection budget`);
      }

      // ── metadata records: they describe the NEXT member, they are not members ────────────
      if (typeflag === 'L' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
        const body = size <= opts.maxHeaderBodyBytes
          ? await reader.exact(padded, size)
          : (await reader.skip(padded), null);

        if (body) {
          if (typeflag === 'L') pendingGnuName = stripNul(body.toString('utf8'));
          else if (typeflag === 'x') {
            const path = parsePaxPath(body);
            if (path !== null) pendingPaxName = path;
          }
          // 'K' (long link name) and 'g' (global pax) carry nothing we need.
        }
        continue;
      }

      const rawName = pendingPaxName ?? pendingGnuName ?? headerName(header);
      pendingPaxName = null;
      pendingGnuName = null;

      const isDirectory = typeflag === '5';
      const name = normalise(rawName, isDirectory);

      // ── the member itself ───────────────────────────────────────────────────────────────
      if (name) {
        entries += 1;
        if (entries > opts.maxEntries) {
          throw new TarError('too_many_entries',
            `Archive has more than ${opts.maxEntries} members`);
        }
        names.add(name);
      }

      const wanted = !isDirectory && name && select(name, size);

      if (!wanted) {
        await reader.skip(padded);
        continue;
      }

      // A zero-byte member is still a member. Dropping it here would make an empty
      // manifest.json indistinguishable from an absent one, and empty ones exist in the wild.
      if (size === 0) {
        files.set(name, Buffer.alloc(0));
        continue;
      }

      if (size > opts.maxMemberBytes || selectedBytes + size > opts.maxSelectedBytes) {
        oversize.push(name);
        await reader.skip(padded);
        continue;
      }

      const body = await reader.exact(padded, size);
      if (body === null) throw new TarError('truncated', `Stream ends inside ${name}`);
      files.set(name, body);
      selectedBytes += size;
    }
  } finally {
    source.destroy?.();
  }

  return { names, files, oversize, entries };
}

/**
 * Read a .tar.gz from disk. The gzip magic is checked up front so a non-gzip upload produces
 * a clear answer instead of zlib's "incorrect header check".
 */
export async function readTarGz(filePath, options = {}) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const magic = Buffer.alloc(3);
    const { bytesRead } = await handle.read(magic, 0, 3, 0);
    if (bytesRead < 3 || magic[0] !== 0x1f || magic[1] !== 0x8b || magic[2] !== 0x08) {
      throw new TarError('not_gzip', 'File is not a gzip archive');
    }
  } finally {
    await handle.close();
  }

  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(filePath).pipe(gunzip);

  try {
    return await readTar(stream, options);
  } catch (err) {
    if (err instanceof TarError) throw err;
    // zlib failures reach us as plain errors; the archive is simply not readable.
    if (err.code === 'Z_DATA_ERROR' || err.code === 'Z_BUF_ERROR') {
      throw new TarError('not_gzip', `Gzip stream is corrupt: ${err.message}`);
    }
    throw err;
  }
}

// ── header decoding ───────────────────────────────────────────────────────────────────────

function headerName(header) {
  const name = cstring(header, 0, 100);
  // `prefix` is POSIX ustar only. GNU writes "ustar  \0" there and uses 'L' records instead,
  // leaving bytes 345.. as something else entirely.
  const magic = header.toString('latin1', 257, 263);
  if (magic === 'ustar\0') {
    const prefix = cstring(header, 345, 500);
    if (prefix) return `${prefix}/${name}`;
  }
  return name;
}

function parseSize(header) {
  // GNU base-256: the high bit of the first byte marks a big-endian integer instead of octal.
  if (header[124] & 0x80) {
    let value = 0n;
    for (let i = 125; i < 136; i += 1) value = (value << 8n) | BigInt(header[i]);
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TarError('not_tar', 'Tar header declares an unusable member size');
    }
    return size;
  }

  const raw = cstring(header, 124, 136).trim();
  const size = raw === '' ? 0 : parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TarError('not_tar', `Tar header declares an invalid size: "${raw}"`);
  }
  return size;
}

function checksumOk(header) {
  const raw = cstring(header, 148, 156).trim();
  const declared = parseInt(raw, 8);
  if (!Number.isFinite(declared)) return false;

  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself counts as eight spaces.
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return declared === unsigned || declared === signed;
}

/** pax records are "<len> <key>=<value>\n". Only `path` renames the next member. */
function parsePaxPath(body) {
  let offset = 0;
  const text = body.toString('utf8');

  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space < 0) break;

    const length = parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;

    const record = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);

    offset += length;
  }
  return null;
}

function normalise(raw, isDirectory) {
  let name = stripNul(raw).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!name || name === '.') return '';
  name = name.replace(/\/+$/, '');
  if (!name) return '';
  return isDirectory ? `${name}/` : name;
}

function cstring(buffer, start, end) {
  const slice = buffer.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.toString('latin1', 0, nul === -1 ? slice.length : nul);
}

const stripNul = (value) => value.replace(/\0+$/, '');

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false;
  return true;
}

// ── block-oriented reader over an async stream ────────────────────────────────────────────

/**
 * Turns a chunked stream into "give me exactly N bytes". Buffers only what a caller asked
 * for; skipped ranges are counted, never accumulated.
 */
class BlockReader {
  #iterator;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor(source) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #pull() {
    if (this.#ended) return false;
    const { value, done } = await this.#iterator.next();
    if (done) {
      this.#ended = true;
      return false;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, value]) : value;
    return true;
  }

  /** Up to `n` bytes. null at a clean end of stream; a short buffer when truncated. */
  async read(n) {
    while (this.#buffer.length < n) {
      if (!await this.#pull()) break;
    }
    if (this.#buffer.length === 0) return null;

    const take = Math.min(n, this.#buffer.length);
    const out = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    return out;
  }

  /** `padded` bytes consumed, the first `size` of them returned. null when truncated. */
  async exact(padded, size) {
    const block = await this.read(padded);
    if (block === null || block.length < padded) return null;
    return Buffer.from(block.subarray(0, size));
  }

  /** Consume and discard `n` bytes without holding them. */
  async skip(n) {
    let remaining = n;
    while (remaining > 0) {
      if (this.#buffer.length === 0 && !await this.#pull()) {
        throw new TarError('truncated', 'Stream ends in the middle of a member');
      }
      const take = Math.min(remaining, this.#buffer.length);
      this.#buffer = this.#buffer.subarray(take);
      remaining -= take;
    }
  }
}
