import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCheckQuery } from '../src/validators/update.validator.js';

/**
 * The `system` parameter, which the node has been sending all along.
 *
 * `UpdateClient::check` appends `&system=` whenever the build stamped one, and omits the
 * parameter entirely when it did not. Since two systems may publish the same version number
 * (migration 012), a node that does not say which product it is cannot be answered, so the
 * boundary this file guards is: absent and blank are refused identically, by name, and a name
 * this server does not have must NOT be refused here — that is a placement decision made
 * later, not a malformed request.
 */

const query = (extra = {}) => new URLSearchParams({
  serial: 'SN-42', platform: 'linux-x86_64', version: '0.13.4', ...extra,
});

const missingSystem = (err) => err.code === 'missing_parameter' && /system/.test(err.message);

test('an unstamped build omits system, and is refused by name', () => {
  assert.throws(() => validateCheckQuery(query()), missingSystem);
});

test('a blank system is the same as none', () => {
  // A build could stamp an empty string; the node would send `&system=`. It says nothing,
  // so it is refused the same way as saying nothing — not as a malformed name.
  assert.throws(() => validateCheckQuery(query({ system: '' })), missingSystem);
  assert.throws(() => validateCheckQuery(query({ system: '   ' })), missingSystem);
});

test('a system name is trimmed and passed through', () => {
  assert.equal(validateCheckQuery(query({ system: 'HERA' })).system, 'HERA');
  assert.equal(validateCheckQuery(query({ system: '  HERA  ' })).system, 'HERA');
});

test('an unknown system name is accepted by the validator', () => {
  // This is the important one. The node is reporting a fact about itself, not issuing a
  // command, and it is not the authority on which systems exist. Refusing here would turn one
  // typo in a build script into a 400 on every check from the whole fleet.
  assert.equal(validateCheckQuery(query({ system: 'HERA-2' })).system, 'HERA-2');
});

test('a system name that could not be one is refused', () => {
  // Bounded and printable: this value reaches a log line, the admin UI and the ETag.
  for (const bad of ['x'.repeat(65), 'HERA\ninjected', 'HERA\r\nX-Evil: 1', '../etc/passwd']) {
    assert.throws(
      () => validateCheckQuery(query({ system: bad })),
      /system/,
      `should refuse ${JSON.stringify(bad.slice(0, 20))}`,
    );
  }
});

test('a system name at the length limit is allowed', () => {
  const name = 'H'.repeat(64);
  assert.equal(validateCheckQuery(query({ system: name })).system, name);
});

test('names with spaces, dots, dashes and underscores are allowed', () => {
  // The server does not get to decide what an operator calls a product.
  for (const name of ['HERA', 'HERA 2', 'hera_gcs', 'HERA-X.1']) {
    assert.equal(validateCheckQuery(query({ system: name })).system, name);
  }
});

test('role is accepted and ignored, not refused', () => {
  // The node hardcoded it, so it distinguished nothing and the protocol dropped it. Devices in
  // the field keep sending it until they are rebuilt, and refusing them over a field the
  // server does not read would take a working fleet offline.
  const parsed = validateCheckQuery(query({ role: 'ANYTHING', system: 'HERA' }));

  assert.equal(parsed.role, undefined, 'not carried forward');
  assert.equal(parsed.serial, 'SN-42', 'and the rest of the request is unaffected');
});
