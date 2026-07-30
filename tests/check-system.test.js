import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_MESSAGE, bundle, fleetHeaders, hasDatabase, publish, setChannel, signIn, startServer,
} from './helpers/harness.js';

/**
 * Placing a node by the `system` it reports (spec section 2, "Placing a node").
 *
 * The node has been sending this all along — `UpdateClient::check` appends `&system=` from its
 * own runtime manifest — and the server used to drop it and infer the system from the version
 * instead. These tests pin the order the server now resolves in, and the two cases where it
 * deliberately refuses to guess.
 *
 * The stakes are why guessing is not an option: handing a node another system's core swaps its
 * plugin set and its config in one step, and the node records that as a non-fatal
 * `system_mismatch` skip — the update reports success and nothing changed.
 */
describe('check: placing a node by system', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer();
    session = await signIn(server);

    // Two systems, so nothing can be resolved by "there is only one".
    await publish(session, {
      version: '0.15.0',
      system: 'HERA',
      body: bundle({
        version: '0.15.0',
        cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
      }),
    });
    await publish(session, {
      version: '2.1.0',
      system: 'drone',
      body: bundle({
        version: '2.1.0',
        cores: [{ platform: 'linux-x86_64', system: 'drone' }],
      }),
    });

    await setChannel(session, 'stable', { latest: '0.15.0' }, 'HERA');
    await setChannel(session, 'stable', { latest: '2.1.0' }, 'drone');
  });

  after(async () => { await server?.close(); });

  const check = (query) => server.request(
    `/api/v1/update/check?${new URLSearchParams(query)}`, { headers: fleetHeaders() },
  );

  /**
   * Recording an unplaced node is deliberately fire-and-forget: the check path answers the
   * fleet without waiting on a bookkeeping row. So the row lands shortly AFTER the response,
   * and reading it once is a race — this polls briefly rather than asserting on a coin flip.
   */
  const unplaced = async (serial) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { nodes } = (await session.api('/admin/api/unclassified')).json();
      const found = nodes.find((node) => node.serial === serial);
      if (found) return found;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    return undefined;
  };

  test('a node is served the release line of the system it reports', async () => {
    const hera = await check({
      serial: 'SN-H1', platform: 'linux-x86_64', version: '0.13.0', system: 'HERA',
    });
    assert.equal(hera.status, 200);
    assert.equal(hera.json().version, '0.15.0');

    const drone = await check({
      serial: 'SN-D1', platform: 'linux-x86_64', version: '2.0.0', system: 'drone',
    });
    assert.equal(drone.status, 200);
    assert.equal(drone.json().version, '2.1.0');
  });

  test('a system this server does not have parks the node instead of failing', async () => {
    // A typo in a build script. 400 would make the whole fleet log an error against a server
    // that is working fine, and the node is not the authority on which systems exist.
    const res = await check({
      serial: 'SN-TYPO', platform: 'linux-x86_64', version: '0.13.0', system: 'HERA-2',
    });

    // 200 with update_available:false — the node's client treats any other status as a
    // broken server, so this protocol never answers with a bare 204.
    assert.equal(res.status, 200, 'no update, not an error');
    assert.equal(res.json().update_available, false);

    const node = await unplaced('SN-TYPO');
    assert.ok(node, 'the node must be recorded, or nobody can act on it');
    assert.equal(node.reported_system, 'HERA-2', 'the claim IS the diagnosis');
    assert.equal(node.assigned_system, null);
  });

  test('an unknown system is never created from what a node says', async () => {
    const res = await session.api('/admin/api/catalog');
    const names = res.json().systems.map((system) => system.name);

    assert.ok(!names.includes('HERA-2'),
      'auto-creating would turn a typo into a version line nothing is published to');
  });

  test('a claim contradicting the running version parks the node', async () => {
    // 0.15.0 belongs to HERA, so a node on it claiming `drone` is either a device that was
    // just moved or a mis-stamped build. Both look identical from here.
    const res = await check({
      serial: 'SN-MIX', platform: 'linux-x86_64', version: '0.15.0', system: 'drone',
    });

    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);

    const node = await unplaced('SN-MIX');
    assert.ok(node);
    assert.equal(node.reported_system, 'drone');
  });

  test('an operator assignment settles a contradiction', async () => {
    const assign = await session.api('/admin/api/unclassified/SN-MIX', {
      method: 'PUT', body: JSON.stringify({ system: 'drone' }),
    });
    assert.equal(assign.status, 200, assign.text());

    const res = await check({
      serial: 'SN-MIX', platform: 'linux-x86_64', version: '0.15.0', system: 'drone',
    });

    assert.equal(res.status, 200, 'a human decided, so there is nothing left to guess');
    assert.equal(res.json().version, '2.1.0');
  });

  test('a node that sends no system still resolves by its version', async () => {
    // An older build with nothing stamped. It must keep working exactly as before.
    const res = await check({
      serial: 'SN-OLD', platform: 'linux-x86_64', version: '0.15.0',
    });

    // It is already on the channel's latest, so there is nothing to offer — an offer must be
    // strictly newer. What proves it was PLACED is the channel list: an unplaced node gets
    // none, because channels belong to a system and it would have no system.
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);
    assert.ok(res.json().channels.includes('stable'), 'placed on the HERA line via its version');
  });

  test('the ETag changes with the system, so a moved node cannot reuse its answer', async () => {
    const hera = await check({
      serial: 'SN-E1', platform: 'linux-x86_64', version: '0.13.0', system: 'HERA',
    });
    const drone = await check({
      serial: 'SN-E1', platform: 'linux-x86_64', version: '0.13.0', system: 'drone',
    });

    assert.notEqual(hera.headers.etag, drone.headers.etag);
  });

  test('a blank system parameter behaves as if it were absent', async () => {
    const res = await check({
      serial: 'SN-BLANK', platform: 'linux-x86_64', version: '0.15.0', system: '',
    });

    assert.equal(res.status, 200, 'an empty stamp says nothing; it is not a wrong claim');
  });

  // ── download names the product too ────────────────────────────────────────────────────

  const download = (query) => server.request(
    `/api/v1/update/download/${query.version}?${new URLSearchParams(
      Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'version')),
    )}`,
    { headers: fleetHeaders() },
  );

  test('the url the server hands out carries the system', async () => {
    // The node fetches this string verbatim, so putting the system in it makes every download
    // name its product without the client having to know the concept exists.
    const res = await check({
      serial: 'SN-DL1', platform: 'linux-x86_64', version: '0.13.0', system: 'HERA',
    });

    assert.equal(res.json().update_available, true);
    assert.match(res.json().url, /system=HERA/);
    assert.equal(res.json().system, 'HERA', 'and the body says it in its own right');
  });

  test('asking for another system\'s bytes is refused', async () => {
    // 0.15.0 belongs to HERA. A drone node with a valid fleet key must not be able to pull it
    // by knowing the number.
    const res = await download({
      version: '0.15.0', platform: 'linux-x86_64', system: 'drone', channel: 'stable',
    });

    assert.equal(res.status, 404);
    assert.match(res.json().message, /system drone/);
  });

  test('the matching system downloads normally', async () => {
    const res = await download({
      version: '0.15.0', platform: 'linux-x86_64', system: 'HERA', channel: 'stable',
    });
    assert.equal(res.status, 200);
  });

  test('a download that cannot name its product is refused', async () => {
    // The key, not a hint. A caller never composes this URL — the check response hands it over
    // complete — so a request without `system` is something that built the URL itself, and
    // these bytes are a firmware image for one product.
    const res = await download({ version: '0.15.0', platform: 'linux-x86_64' });

    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'missing_parameter');
  });

  test('the url the check handed out downloads as-is', async () => {
    // The end-to-end property: whatever /check returns in `url` must work verbatim, because
    // that is the only thing the node ever fetches.
    const offer = await check({
      serial: 'SN-URL', platform: 'linux-x86_64', version: '0.13.0', system: 'HERA',
    });
    assert.equal(offer.json().update_available, true);

    const res = await server.request(offer.json().url, { headers: fleetHeaders() });
    assert.equal(res.status, 200, offer.json().url);
  });

  test('a malformed system is refused before it reaches the catalog', async () => {
    const res = await download({
      version: '0.15.0', platform: 'linux-x86_64', system: 'a\nb',
    });
    assert.equal(res.status, 400);
  });

  // ── one release runs on one channel ─────────────────────────────────────────────────

  test('promoting takes the release off the channel that had it', async () => {
    // The whole point of staging: beta and stable serving the same version means every node
    // gets the same thing whichever channel it is on, so there is no canary at all.
    const put = (name, body) => session.api(`/admin/api/systems/HERA/channels/${name}`, {
      method: 'PUT', body: JSON.stringify(body),
    });

    await put('stable', { latest: '0.14.0', allow_rollback: true });
    await put('beta', { latest: '0.15.0' });

    const promoted = await put('stable', { latest: '0.15.0' });
    assert.equal(promoted.status, 200, promoted.text());
    assert.deepEqual(promoted.json().released, ['beta'], 'says what it took the version from');

    const { channels } = (await session.api('/admin/api/catalog')).json();
    const hera = Object.fromEntries(
      channels.filter((c) => c.system === 'HERA').map((c) => [c.name, c.latest]),
    );
    assert.equal(hera.stable, '0.15.0');
    assert.equal(hera.beta, null, 'beta let go of it rather than serving it too');
  });

  test('a node on the released channel is simply told it is current', async () => {
    // It already installed the version; nothing was taken away from it.
    const res = await check({
      serial: 'SN-BETA', platform: 'linux-x86_64', version: '0.15.0',
      system: 'HERA', channel: 'beta',
    });

    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);
  });

  test('the release is recorded in the audit trail, not done silently', async () => {
    const { entries } = (await session.api('/admin/api/audit')).json();
    const entry = entries.find((row) => row.detail?.released?.includes('beta'));

    assert.ok(entry, 'clearing another channel changes what a fleet is offered');
    assert.equal(entry.subject, 'HERA/stable');
  });

  test('a channel in another system is left alone', async () => {
    // Version numbers belong to a system. drone/stable being on 2.1.0 says nothing about HERA.
    const before = (await session.api('/admin/api/catalog')).json()
      .channels.find((c) => c.system === 'drone' && c.name === 'stable');

    await session.api('/admin/api/systems/HERA/channels/beta', {
      method: 'PUT', body: JSON.stringify({ latest: '0.14.0' }),
    });

    const after = (await session.api('/admin/api/catalog')).json()
      .channels.find((c) => c.system === 'drone' && c.name === 'stable');
    assert.equal(after.latest, before.latest);
  });

  test('moving forward again needs no flag', async () => {
    const res = await session.api('/admin/api/systems/HERA/channels/stable', {
      method: 'PUT', body: JSON.stringify({ latest: '0.15.0' }),
    });
    assert.equal(res.status, 200);
  });
});
