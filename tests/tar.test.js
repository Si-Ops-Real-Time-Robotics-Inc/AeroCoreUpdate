import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { TarError, readTar } from '../src/core/tar.js';
import { paxRecord, tar } from './helpers/targz.js';

const stream = (buffer) => Readable.from([buffer]);
const read = (buffer, options) => readTar(stream(buffer), options);
const allJson = { select: (name) => name.endsWith('.json') };

/** Deterministic incompressible bytes — the same generator the harness uses. */
function noise(size, seed = 7) {
  const out = Buffer.alloc(size);
  let state = seed;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

test('members lose the ./ prefix that tar -C stage . adds', async () => {
  const scan = await read(tar([
    { name: 'manifest.json', body: '{"a":1}' },
    { name: 'core/linux-x86_64/bin/aerocore', body: 'ELF' },
  ]), allJson);

  assert.deepEqual([...scan.names].sort(), ['core/linux-x86_64/bin/aerocore', 'manifest.json']);
  assert.equal(scan.files.get('manifest.json').toString(), '{"a":1}');
  assert.equal(scan.entries, 2);
});

test('only selected bodies are retained', async () => {
  const scan = await read(tar([
    { name: 'manifest.json', body: '{}' },
    { name: 'big.bin', body: noise(4096) },
  ]), allJson);

  assert.ok(scan.files.has('manifest.json'));
  assert.ok(!scan.files.has('big.bin'), 'unselected bodies are discarded, not buffered');
  assert.ok(scan.names.has('big.bin'), 'but the name is still recorded');
});

test('directory entries keep exactly one trailing slash and carry no body', async () => {
  const scan = await read(tar([
    { name: 'core/', type: '5' },
    { name: 'core/linux-x86_64/', type: '5' },
  ]), allJson);

  assert.deepEqual([...scan.names].sort(), ['core/', 'core/linux-x86_64/']);
});

test('the bare ./ entry that tar emits first is dropped', async () => {
  const scan = await read(tar([
    { name: '', type: '5' },
    { name: 'manifest.json', body: '{}' },
  ]), allJson);

  assert.deepEqual([...scan.names], ['manifest.json']);
  assert.equal(scan.entries, 1);
});

test('the .components build leftover is an ordinary member, never an error', async () => {
  const scan = await read(tar([
    { name: 'manifest.json', body: '{}' },
    { name: '.components', body: 'core|linux-x86_64|core/linux-x86_64\n' },
  ]), allJson);

  assert.ok(scan.names.has('.components'));
});

test('a GNU L record renames the following member', async () => {
  const long = `plugins/${'Very_Long_Plugin_Name'.repeat(4)}/linux-x86_64/manifest.json`;
  assert.ok(long.length > 100, 'the fixture must actually exceed the 100-byte name field');

  const scan = await read(tar([
    { name: 'placeholder', longName: long, body: '{"plugin":"x"}' },
  ]), allJson);

  assert.ok(scan.names.has(long));
  assert.equal(scan.files.get(long).toString(), '{"plugin":"x"}');
});

test('a pax x record with path= renames the following member', async () => {
  const long = 'plugins/Name/linux-x86_64/manifest.json';
  const scan = await read(tar([
    { name: 'pax', type: 'x', body: paxRecord({ path: long }) },
    { name: 'ignored', body: '{"plugin":"y"}' },
  ]), allJson);

  assert.ok(scan.names.has(long));
  assert.ok(!scan.names.has('ignored'));
});

test('a pax x record without path= leaves the next name alone', async () => {
  // bsdtar emits an x record carrying only mtime for EVERY entry. Treating that as a rename
  // would corrupt every name in the archive.
  const scan = await read(tar([
    { name: 'pax', type: 'x', body: paxRecord({ mtime: '1785000000.123456789' }) },
    { name: 'manifest.json', body: '{}' },
  ]), allJson);

  assert.deepEqual([...scan.names], ['manifest.json']);
});

test('a ustar prefix is rejoined with the name', async () => {
  // A real archiver splits a long path across prefix + name, and the './' lives in the
  // prefix. The rejoined path must still normalise to the same member name.
  const scan = await read(tar([
    { name: 'manifest.json', prefix: './plugins/Name/linux-x86_64', body: '{}' },
  ]), allJson);

  assert.ok(scan.names.has('plugins/Name/linux-x86_64/manifest.json'),
    `got ${[...scan.names].join(', ')}`);
});

test('a base-256 size field is decoded', async () => {
  const scan = await read(tar([
    { name: 'manifest.json', body: '{"big":true}', base256: true },
  ]), allJson);

  assert.equal(scan.files.get('manifest.json').toString(), '{"big":true}');
});

test('an unknown typeflag is skipped, never fatal', async () => {
  // A reader that rejects what it does not understand rejects next year's archives.
  const scan = await read(tar([
    { name: 'weird', type: 'V', body: 'volume header' },
    { name: 'manifest.json', body: '{}' },
  ]), allJson);

  assert.ok(scan.files.has('manifest.json'));
});

test('trailing padding after the two zero blocks is ignored', async () => {
  const archive = Buffer.concat([
    tar([{ name: 'manifest.json', body: '{}' }]),
    Buffer.alloc(8192),
  ]);
  const scan = await read(archive, allJson);
  assert.ok(scan.files.has('manifest.json'));
});

test('a member over maxMemberBytes is reported, not buffered', async () => {
  const scan = await read(tar([
    { name: 'huge.json', body: noise(4096) },
    { name: 'manifest.json', body: '{}' },
  ]), { select: (name) => name.endsWith('.json'), maxMemberBytes: 1024 });

  assert.deepEqual(scan.oversize, ['huge.json']);
  assert.ok(!scan.files.has('huge.json'));
  assert.ok(scan.files.has('manifest.json'), 'and the scan continues past it');
});

test('maxSelectedBytes caps the total retained', async () => {
  const scan = await read(tar([
    { name: 'a.json', body: noise(800) },
    { name: 'b.json', body: noise(800) },
  ]), { select: () => true, maxSelectedBytes: 1000 });

  assert.equal(scan.files.size, 1);
  assert.deepEqual(scan.oversize, ['b.json']);
});

test('maxEntries bounds the name set', async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, body: 'x' }));
  await assert.rejects(
    read(tar(entries), { maxEntries: 5 }),
    (err) => err instanceof TarError && err.code === 'too_many_entries',
  );
});

test('maxInflatedBytes stops a decompression bomb', async () => {
  await assert.rejects(
    read(tar([{ name: 'big', body: noise(20_000) }]), { maxInflatedBytes: 4096 }),
    (err) => err instanceof TarError && err.code === 'inflate_budget',
  );
});

test('random bytes are not a tar', async () => {
  await assert.rejects(
    read(noise(2048)),
    (err) => err instanceof TarError && err.code === 'not_tar',
  );
});

test('a truncated archive is detected', async () => {
  const full = tar([{ name: 'manifest.json', body: noise(3000) }]);
  await assert.rejects(
    read(full.subarray(0, full.length - 2400)),
    (err) => err instanceof TarError && err.code === 'truncated',
  );
});

test('an archive with no trailing zero blocks still reads', async () => {
  const full = tar([{ name: 'manifest.json', body: '{}' }]);
  const scan = await read(full.subarray(0, full.length - 1024), allJson);
  assert.ok(scan.files.has('manifest.json'));
});

test('a corrupt header mid-archive is truncated, not not_tar', async () => {
  const full = tar([
    { name: 'manifest.json', body: '{}' },
    { name: 'second.json', body: '{}' },
  ]);
  // Scribble over the second header block so its checksum fails.
  full.fill(0x41, 1024, 1100);

  await assert.rejects(
    read(full),
    (err) => err instanceof TarError && err.code === 'truncated',
  );
});

test('gunzipped input flows through unchanged', async () => {
  const scan = await readTar(
    Readable.from([zlib.gunzipSync(zlib.gzipSync(tar([{ name: 'manifest.json', body: '{}' }])))]),
    allJson,
  );
  assert.ok(scan.files.has('manifest.json'));
});
