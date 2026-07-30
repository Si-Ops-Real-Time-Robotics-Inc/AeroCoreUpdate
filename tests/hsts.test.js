import test from 'node:test';
import assert from 'node:assert/strict';

import { getTlsInfo, setTlsInfo, shouldSendHsts } from '../src/services/tlsInfo.service.js';

/**
 * HSTS with a self-signed certificate is a one-way door: the browser records the policy, then
 * refuses to let anyone click through the certificate warning for max-age. Nobody can reach
 * the admin UI from that browser again, and nothing the server sends afterwards undoes it.
 */
test('HSTS is suppressed while the certificate is self-signed', () => {
  setTlsInfo({ enabled: true, selfSigned: true, cert: 'x', key: 'y' });
  assert.equal(shouldSendHsts(), false);
});

test('HSTS is sent behind a certificate a browser actually trusts', () => {
  setTlsInfo({ enabled: true, selfSigned: false, cert: 'x', key: 'y' });
  assert.equal(shouldSendHsts(), true);
});

test('HSTS is not sent before TLS is initialised', () => {
  setTlsInfo({ enabled: false, selfSigned: false });
  assert.equal(shouldSendHsts(), false);
});

test('key material never leaves the service', () => {
  setTlsInfo({
    enabled: true, selfSigned: false, subject: 'CN=x', cert: 'CERTPEM', key: 'KEYPEM',
  });
  const info = getTlsInfo();

  assert.equal(info.cert, undefined);
  assert.equal(info.key, undefined);
  assert.equal(info.subject, 'CN=x');
});
