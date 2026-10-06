import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCOPE, mayLandOnChannel } from '../src/domain/scopes.js';
import { rollbackFinding } from '../src/domain/channel.js';

/**
 * The two rules behind "uploading is not publishing", checked without a database.
 *
 * They live in domain/ precisely so they can be tested like this: the guarantee the
 * constitution states is a property of these two functions, and a property worth stating is
 * worth checking on every run rather than only when Postgres happens to be up.
 */

const STAGING = 'beta';
const publisher = new Set([SCOPE.SELF, SCOPE.CATALOG_READ, SCOPE.ARTIFACT_WRITE]);
const admin = new Set([...publisher, SCOPE.CHANNEL_WRITE]);

describe('mayLandOnChannel', () => {
  test('landing nowhere reaches nobody, so anyone who may upload may ask for it', () => {
    assert.equal(mayLandOnChannel({ channel: null, scopes: publisher, stagingChannel: STAGING }), true);
    assert.equal(mayLandOnChannel({ channel: null, scopes: admin, stagingChannel: STAGING }), true);
  });

  test('the staging channel is where an ordinary upload lands, so it needs nothing extra', () => {
    assert.equal(mayLandOnChannel({ channel: 'beta', scopes: publisher, stagingChannel: STAGING }), true);
    assert.equal(mayLandOnChannel({ channel: 'beta', scopes: admin, stagingChannel: STAGING }), true);
  });

  test('any other channel needs channel:write', () => {
    assert.equal(mayLandOnChannel({ channel: 'stable', scopes: publisher, stagingChannel: STAGING }), false);
    assert.equal(mayLandOnChannel({ channel: 'stable', scopes: admin, stagingChannel: STAGING }), true);
  });

  test('an invented channel name is not a way around it', () => {
    assert.equal(mayLandOnChannel({ channel: 'beta2', scopes: publisher, stagingChannel: STAGING }), false);
    assert.equal(mayLandOnChannel({ channel: 'BETA', scopes: publisher, stagingChannel: STAGING }), false);
  });

  /**
   * The whole feature rests on this. `config.autoPromoteChannel` is read from an environment
   * variable and `config.stagingChannel` is a literal; a rule anchored on the former would
   * hand every publisher the fleet the moment someone set AUTO_PROMOTE_CHANNEL=stable, and no
   * line of code would look wrong. The predicate takes ONE channel argument and it is the
   * literal one — there is no parameter here that an environment could move.
   */
  test('the rule cannot be moved by configuration', () => {
    // What a deployment with AUTO_PROMOTE_CHANNEL=stable would ask for. Still refused: the
    // staging channel is 'beta' whatever the promotion target has been set to.
    assert.equal(mayLandOnChannel({ channel: 'stable', scopes: publisher, stagingChannel: 'beta' }), false);

    const args = Object.keys({ channel: null, scopes: null, stagingChannel: null });
    assert.ok(!args.includes('autoPromoteChannel'),
      'the predicate must not be able to see the env-driven promotion target');
  });

  test('a caller with no scopes at all may still land nowhere and nowhere else', () => {
    const none = new Set();
    assert.equal(mayLandOnChannel({ channel: null, scopes: none, stagingChannel: STAGING }), true);
    assert.equal(mayLandOnChannel({ channel: 'stable', scopes: none, stagingChannel: STAGING }), false);
  });
});

describe('rollbackFinding', () => {
  test('going backwards is a finding, carrying both ends of the move', () => {
    const finding = rollbackFinding('gcs', 'beta', '0.13.5', '0.13.4');
    assert.equal(finding.rule, 'channel_rollback');
    assert.equal(finding.from, '0.13.5');
    assert.equal(finding.to, '0.13.4');
    assert.match(finding.message, /gcs\/beta is on 0\.13\.5; 0\.13\.4 is older/);
    // The flag an operator has to send back is named in the message, because a refusal that
    // names a flag the UI cannot send is a dead end.
    assert.match(finding.message, /"allow_rollback": true/);
  });

  test('going forwards is not', () => {
    assert.equal(rollbackFinding('gcs', 'beta', '0.13.4', '0.13.5'), null);
  });

  test('standing still is not — re-pointing a channel at what it already serves is a no-op', () => {
    assert.equal(rollbackFinding('gcs', 'beta', '0.13.5', '0.13.5'), null);
  });

  test('a channel pointing nowhere yet cannot move backwards', () => {
    assert.equal(rollbackFinding('gcs', 'beta', null, '0.13.4'), null);
  });
});
