import zlib from 'node:zlib';

/**
 * Minimal tar WRITER, for fixtures only.
 *
 * It mirrors what `tar -czf out -C stage .` produces, because that is the exact command in
 * package_update_bundle.sh: member names carry a './' prefix and there is no wrapper
 * directory. Pass `raw: true` for the legacy `tar -czf out <dir>` shape, which has neither.
 */

const BLOCK = 512;

/**
 * @param {Array<{name: string, body?: Buffer|string, type?: '0'|'5'|'L'|'x'|'g'|'K',
 *                raw?: boolean, prefix?: string, base256?: boolean, longName?: string}>} entries
 * @returns {Buffer}
 */
export function tar(entries) {
  const blocks = [];

  for (const entry of entries) {
    const body = entry.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(entry.body);

    // GNU long name: an 'L' record whose body is the real name of the next member.
    if (entry.longName) {
      const nameBody = Buffer.from(`${entry.longName}\0`);
      blocks.push(header({ name: '././@LongLink', size: nameBody.length, type: 'L' }));
      blocks.push(pad(nameBody));
    }

    // A ustar `prefix` carries the leading './' itself, so the name field stays bare —
    // that is how a real archiver splits a path across the two fields.
    const name = entry.raw || entry.prefix ? entry.name : `./${entry.name}`;
    blocks.push(header({
      name: entry.longName ? 'ignored-by-longname' : name,
      size: body.length,
      type: entry.type ?? '0',
      prefix: entry.prefix ?? '',
      base256: entry.base256 ?? false,
    }));
    if (body.length) blocks.push(pad(body));
  }

  // Two zero blocks close the archive.
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

export function targz(entries) {
  return zlib.gzipSync(tar(entries));
}

/** A pax 'x' record carrying arbitrary "key=value" pairs for the next member. */
export function paxRecord(pairs) {
  const body = Object.entries(pairs).map(([key, value]) => {
    const tail = ` ${key}=${value}\n`;
    let length = tail.length + 1;
    // The length prefix is part of the length it declares, so it can need a second digit.
    if (String(length).length !== String(length + 1).length) length += 1;
    return `${length}${tail}`;
  }).join('');
  return Buffer.from(body, 'utf8');
}

function header({ name, size, type, prefix = '', base256 = false }) {
  const block = Buffer.alloc(BLOCK);

  block.write(name.slice(0, 100), 0, 100, 'latin1');
  block.write('0000755\0', 100, 8, 'latin1');   // mode
  block.write('0000000\0', 108, 8, 'latin1');   // uid
  block.write('0000000\0', 116, 8, 'latin1');   // gid

  if (base256) {
    block[124] = 0x80;
    block.writeUIntBE(size, 130, 6);
  } else {
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  }

  block.write(`${(0).toString(8).padStart(11, '0')}\0`, 136, 12, 'latin1'); // mtime
  block.write('        ', 148, 8, 'latin1');    // checksum placeholder: eight spaces
  block.write(type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  if (prefix) block.write(prefix.slice(0, 155), 345, 155, 'latin1');

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += block[i];
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');

  return block;
}

function pad(body) {
  const padded = Math.ceil(body.length / BLOCK) * BLOCK;
  const out = Buffer.alloc(padded);
  body.copy(out);
  return out;
}
