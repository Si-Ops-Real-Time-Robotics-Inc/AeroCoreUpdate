import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { sign, verify } from '../src/core/jwt.js';
import { DUMMY_HASH, hash, verify as verifyPassword } from '../src/core/password.js';

const SECRET = 'test-secret-do-not-use';
const b64u = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

test('a signed token round-trips with its claims intact', () => {
  const token = sign({ sub: '7', usr: 'admin' }, { secret: SECRET, ttlSeconds: 60 });
  const claims = verify(token, SECRET);

  assert.equal(claims.sub, '7');
  assert.equal(claims.usr, 'admin');
  assert.equal(claims.iss, 'aeroserver');
  assert.equal(claims.aud, 'admin');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
});

test('alg:none is rejected — the classic JWT hole', () => {
  const header = b64u({ alg: 'none', typ: 'JWT' });
  const payload = b64u({
    sub: '1', usr: 'admin', iss: 'aeroserver', aud: 'admin',
    exp: Math.floor(Date.now() / 1000) + 600,
  });

  assert.throws(() => verify(`${header}.${payload}.`, SECRET), /Unsupported algorithm/);
  assert.throws(() => verify(`${header}.${payload}.anything`, SECRET), /Unsupported algorithm/);
});

test('a token signed with another secret is rejected', () => {
  const token = sign({ sub: '1' }, { secret: 'other-secret', ttlSeconds: 60 });
  assert.throws(() => verify(token, SECRET), /Signature mismatch/);
});

test('tampering with the payload invalidates the signature', () => {
  const token = sign({ sub: '1', usr: 'viewer' }, { secret: SECRET, ttlSeconds: 60 });
  const [header, payload, signature] = token.split('.');

  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  forged.usr = 'admin';

  assert.throws(() => verify(`${header}.${b64u(forged)}.${signature}`, SECRET), /Signature mismatch/);
});

test('an expired token is rejected', () => {
  const token = sign({ sub: '1' }, { secret: SECRET, ttlSeconds: -1 });
  assert.throws(() => verify(token, SECRET), /expired/);
});

test('malformed tokens are rejected without throwing anything but our own error', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token', null, 42, '!!!.!!!.!!!']) {
    assert.throws(() => verify(bad, SECRET), Error);
  }
});

test('scrypt hashes verify, and a wrong password does not', async () => {
  const stored = await hash('correct horse battery staple');

  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
});

test('two hashes of the same password differ (salted)', async () => {
  const a = await hash('same-password');
  const b = await hash('same-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('cost parameters are read from the stored string, not from constants', async () => {
  const cheap = await hash('password', { N: 1024 });
  assert.match(cheap, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('password', cheap), true, 'old-parameter hashes still verify');
});

test('malformed stored hashes return false rather than throwing', async () => {
  for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e', null, undefined]) {
    assert.equal(await verifyPassword('x', bad), false);
  }
});

test('DUMMY_HASH exists so an unknown username still burns scrypt time', async () => {
  assert.match(DUMMY_HASH, /^scrypt\$/);
  assert.equal(await verifyPassword(crypto.randomBytes(8).toString('hex'), DUMMY_HASH), false);
});
