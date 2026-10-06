import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminCsp, issuerOrigin } from '../src/core/csp.js';

const directives = (issuer) => Object.fromEntries(
  adminCsp(issuer).split('; ').map((d) => {
    const [name, ...values] = d.split(' ');
    return [name, values];
  }),
);

test('a deployment without Keycloak is not widened at all', () => {
  assert.deepEqual(directives('')['connect-src'], ["'self'"]);
  assert.deepEqual(directives(undefined)['connect-src'], ["'self'"]);
});

test('the issuer origin is allowed to be reached, so the code exchange can happen', () => {
  const connect = directives('http://192.168.194.129:8081/realms/aerotunnel')['connect-src'];
  assert.deepEqual(connect, ["'self'", 'http://192.168.194.129:8081']);
});

test('only the origin travels, never the realm path', () => {
  // connect-src matches on origin regardless, so carrying the path would imply
  // a narrowing this directive cannot actually express.
  assert.equal(issuerOrigin('https://id.example.com/realms/aerotunnel'), 'https://id.example.com');
});

test('a malformed issuer contributes nothing rather than something loose', () => {
  assert.deepEqual(directives('not a url')['connect-src'], ["'self'"]);
  assert.equal(issuerOrigin('not a url'), '');
});

test('the directives that must not move have not moved', () => {
  const d = directives('https://id.example.com/realms/x');
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'self'"]);
  assert.deepEqual(d['default-src'], ["'self'"]);
  // The issuer is reachable by fetch, and deliberately NOT by anything else:
  // a token endpoint has no business being a script or a frame parent.
  assert.equal(adminCsp('https://id.example.com/realms/x').includes("script-src 'self' https"), false);
});
