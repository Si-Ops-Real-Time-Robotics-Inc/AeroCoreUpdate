import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_MESSAGE, bundle, fleetHeaders, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * AeroCore runs on different kinds of device that need different plugin sets and config, even
 * on the same platform. The node cannot say which it is — its update client sends only serial,
 * platform, version, role and channel, `role` is a hardcoded literal, and `serial` is blanked
 * by any OTA that carries config. So a bundle declares its system, and a node is placed by the
 * version it reports.
 */
describe('systems', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;

  before(async () => {
    server = await startServer();
    session = await signIn(server);

    for (const name of ['drone', 'gcs']) {
      const res = await session.api('/admin/api/systems', {
        method: 'POST', body: JSON.stringify({ name }),
      });
      assert.equal(res.status, 201, `create ${name}: ${res.text()}`);
    }
  });

  after(async () => { await server?.close(); });

  const upload = (body, query = '') => session.api(
    `/admin/api/artifacts${query ? `?${query}` : ''}`,
    { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body },
  );

  const check = (serial, platform, version, channel = 'stable') => server.request(
    `/api/v1/update/check?serial=${serial}&platform=${platform}&version=${version}`
    + `&channel=${channel}`,
    { headers: fleetHeaders() },
  );

  const publishTo = async (system, version, platform, channel) => {
    const res = await upload(bundle({
      version, cores: [{ platform }], release: { system },
    }));
    assert.equal(res.status, 201, `publish ${version}: ${res.text()}`);
    assert.equal(res.json().system, system);

    if (channel) {
      const promote = await session.api(`/admin/api/systems/${system}/channels/${channel}`, {
        method: 'PUT', body: JSON.stringify({ latest: version }),
      });
      assert.equal(promote.status, 200, promote.text());
    }
    return res.json();
  };

  // ── the rule that keeps firmware where it belongs ────────────────────────────────────────

  test('a node is offered only its own system, decided by the version it reports', async () => {
    await publishTo('drone', '1.0.0', 'android-aarch64', null);
    await publishTo('drone', '1.1.0', 'android-aarch64', 'stable');
    await publishTo('gcs', '2.0.0', 'android-aarch64', null);
    await publishTo('gcs', '2.1.0', 'android-aarch64', 'stable');

    // Same platform, same channel name, different version lines.
    const drone = await check('SN-DRONE', 'android-aarch64', '1.0.0');
    assert.equal(drone.status, 200);
    assert.equal(drone.json().version, '1.1.0', 'a drone gets the drone line');

    const gcs = await check('SN-GCS', 'android-aarch64', '2.0.0');
    assert.equal(gcs.status, 200);
    assert.equal(gcs.json().version, '2.1.0', 'a GCS gets the GCS line');
  });

  test('a version this server never published gets nothing and is parked for review', async () => {
    // Guessing would mean pushing one system's firmware to another.
    const res = await check('SN-FACTORY', 'android-aarch64', '9.9.9');
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);

    const pending = await session.api('/admin/api/unclassified?filter=pending');
    const row = pending.json().nodes.find((node) => node.serial === 'SN-FACTORY');
    assert.ok(row, 'the node must be recorded');
    assert.equal(row.version, '9.9.9');
    assert.equal(row.assigned_system, null);
  });

  test('an admin assignment places a node the version lookup could not', async () => {
    const assign = await session.api('/admin/api/unclassified/SN-FACTORY', {
      method: 'PUT', body: JSON.stringify({ system: 'drone' }),
    });
    assert.equal(assign.status, 200);

    const res = await check('SN-FACTORY', 'android-aarch64', '9.9.9');
    assert.equal(res.status, 200);
    // 9.9.9 is above the drone line, so there is still nothing newer to offer — but it is now
    // resolved to a system rather than refused outright.
    assert.equal(res.json().update_available, false);

    const again = await check('SN-FACTORY', 'android-aarch64', '0.1.0');
    assert.equal(again.json().version, '1.1.0', 'now it follows the drone line');
  });

  // ── the catalog must never mix systems ───────────────────────────────────────────────────

  test('a channel cannot point at another system release', async () => {
    const res = await session.api('/admin/api/systems/drone/channels/stable', {
      method: 'PUT', body: JSON.stringify({ latest: '2.1.0' }),
    });

    assert.equal(res.status, 400);
    assert.match(res.json().message, /belongs to system "gcs", not "drone"/);
  });

  test('a bundle naming a system that does not exist is refused', async () => {
    const res = await upload(bundle({
      version: '3.0.0',
      cores: [{ platform: 'linux-x86_64' }],
      release: { system: 'submarine' },
    }));

    assert.equal(res.status, 400);
    assert.match(res.json().message, /submarine/, 'names the system it could not find');
    assert.match(res.json().message, /Create it/, 'and what to do about it');

    // The refusal is the point: auto-creating would turn one typo in a build script into a
    // second version line that nothing is ever published to.
    const { systems } = (await session.api('/admin/api/catalog')).json();
    assert.ok(!systems.some((system) => system.name === 'submarine'));
  });

  test('every system has exactly beta and stable, and they are its own', async () => {
    // The set is closed: a system is created with both and there is no way to add a third.
    // `stable` therefore means nothing without a system beside it — the two here hand out
    // different versions under the same name.
    const catalog = (await session.api('/admin/api/catalog')).json();

    for (const system of ['drone', 'gcs']) {
      const names = catalog.channels
        .filter((channel) => channel.system === system)
        .map((channel) => channel.name)
        .sort();
      assert.deepEqual(names, ['beta', 'stable'], `${system} has both and only both`);
    }

    const stableOf = (system) => catalog.channels
      .find((c) => c.system === system && c.name === 'stable').latest;
    assert.equal(stableOf('drone'), '1.1.0');
    assert.equal(stableOf('gcs'), '2.1.0');
  });

  test('a system with releases cannot be deleted', async () => {
    const res = await session.api('/admin/api/systems/drone', { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.match(res.json().message, /still has \d+ release/);
  });

  // ── the baseline for a diff must stay inside one system ──────────────────────────────────

  test('a diff never uses another system release as its baseline', async () => {
    // The drone line is 1.x and the GCS line is 2.x, so an unscoped "previous release" query
    // would pick 1.1.0 as the baseline for 2.0.0 and describe a device that does not exist.
    const res = await upload(bundle({
      version: '2.2.0', cores: [{ platform: 'android-aarch64' }], release: { system: 'gcs' },
    }));

    assert.equal(res.status, 201);
    assert.equal(res.json().diff.previousVersion, '2.1.0',
      'the baseline must be the previous GCS release, not the newest drone one');
  });
});
