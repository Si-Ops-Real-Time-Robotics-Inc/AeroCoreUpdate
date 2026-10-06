import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_MESSAGE, bundle, fleetHeaders, hasDatabase, sha256Hex, signIn, startServer,
} from './helpers/harness.js';

/**
 * AeroCore runs on different kinds of device that need different plugin sets and config, even
 * on the same platform. A bundle declares its system, and a node says which one it is with the
 * `system` it sends on every check — the version cannot, since two systems may publish the
 * same number (migration 012).
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

  const check = (serial, platform, version, system, channel = 'stable') => server.request(
    `/api/v1/update/check?${new URLSearchParams({ serial, platform, version, system, channel })}`,
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

  test('a node is offered only its own system, decided by the system it reports', async () => {
    await publishTo('drone', '1.0.0', 'android-aarch64', null);
    await publishTo('drone', '1.1.0', 'android-aarch64', 'stable');
    await publishTo('gcs', '2.0.0', 'android-aarch64', null);
    await publishTo('gcs', '2.1.0', 'android-aarch64', 'stable');

    // Same platform, same channel name, different version lines.
    const drone = await check('SN-DRONE', 'android-aarch64', '1.0.0', 'drone');
    assert.equal(drone.status, 200);
    assert.equal(drone.json().version, '1.1.0', 'a drone gets the drone line');

    const gcs = await check('SN-GCS', 'android-aarch64', '2.0.0', 'gcs');
    assert.equal(gcs.status, 200);
    assert.equal(gcs.json().version, '2.1.0', 'a GCS gets the GCS line');
  });

  test('a factory-fresh node on a version never published here follows its own line', async () => {
    // Its version names no release anywhere. That no longer matters: it said what it is.
    const res = await check('SN-FRESH', 'android-aarch64', '0.0.1', 'gcs');
    assert.equal(res.status, 200);
    assert.equal(res.json().version, '2.1.0');
  });

  test('a node claiming a system this server does not have is parked for review', async () => {
    // Guessing would mean pushing one system's firmware to another.
    const res = await check('SN-FACTORY', 'android-aarch64', '9.9.9', 'factory-default');
    assert.equal(res.status, 200);
    assert.equal(res.json().update_available, false);

    const pending = await session.api('/admin/api/unclassified?filter=pending');
    const row = pending.json().nodes.find((node) => node.serial === 'SN-FACTORY');
    assert.ok(row, 'the node must be recorded');
    assert.equal(row.version, '9.9.9');
    assert.equal(row.reported_system, 'factory-default');
    assert.equal(row.assigned_system, null);
  });

  test('an admin assignment places a node its own claim could not', async () => {
    const assign = await session.api('/admin/api/unclassified/SN-FACTORY', {
      method: 'PUT', body: JSON.stringify({ system: 'drone' }),
    });
    assert.equal(assign.status, 200);

    const res = await check('SN-FACTORY', 'android-aarch64', '9.9.9', 'factory-default');
    assert.equal(res.status, 200);
    // 9.9.9 is above the drone line, so there is still nothing newer to offer — but it is now
    // resolved to a system rather than refused outright.
    assert.equal(res.json().update_available, false);

    const again = await check('SN-FACTORY', 'android-aarch64', '0.1.0', 'factory-default');
    assert.equal(again.json().version, '1.1.0', 'now it follows the drone line');
  });

  // ── the catalog must never mix systems ───────────────────────────────────────────────────

  test('a channel cannot point at another system release', async () => {
    const res = await session.api('/admin/api/systems/drone/channels/stable', {
      method: 'PUT', body: JSON.stringify({ latest: '2.1.0' }),
    });

    // 2.1.0 is a gcs release. From drone it simply does not exist.
    assert.equal(res.status, 400);
    assert.match(res.json().message, /No release 2\.1\.0 in system "drone"/);
  });

  /**
   * Reading a channel back. Trivial, and untested until it 500'd in production: the handler
   * still served `pins` and `denies` from a per-serial pin feature whose tables no longer
   * exist, so `Object.fromEntries(undefined)` threw on every GET — the one call the operator
   * makes before deciding whether to promote.
   */
  test('a channel can be read back', async () => {
    const res = await session.api('/admin/api/systems/gcs/channels/stable');

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.system, 'gcs');
    assert.equal(body.name, 'stable');
    assert.equal(body.latest, '2.1.0');
  });

  test('reading a channel that does not exist is a 404, not a 500', async () => {
    const res = await session.api('/admin/api/systems/drone/channels/nonesuch');
    assert.equal(res.status, 404);
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

  // ── a version number is per system (migration 012) ─────────────────────────────────────

  test('two systems may publish the same version number', async () => {
    // HERA could not ship 0.2.0 because HERAHUB already had. Nothing about either product
    // made that a conflict; only the old global key did.
    const drone = await publishTo('drone', '5.0.0', 'android-aarch64', 'stable');
    const gcs = await publishTo('gcs', '5.0.0', 'android-aarch64', 'stable');

    assert.notEqual(drone.sha256, gcs.sha256, 'two different builds');

    const { releases } = (await session.api('/admin/api/catalog')).json();
    const fives = releases.filter((r) => r.version === '5.0.0').map((r) => r.system).sort();
    assert.deepEqual(fives, ['drone', 'gcs']);
  });

  test('each node is offered its own system\'s build of that number, bytes and all', async () => {
    const { releases } = (await session.api('/admin/api/catalog')).json();
    const shaOf = (system) => releases
      .find((r) => r.system === system && r.version === '5.0.0').artifacts[0].sha256;

    for (const system of ['drone', 'gcs']) {
      const offer = await check(`SN-5-${system}`, 'android-aarch64', '1.0.0', system);
      assert.equal(offer.json().version, '5.0.0');
      assert.equal(offer.json().sha256, shaOf(system), `${system} is promised its own bytes`);

      // And handed them: under the old <version>/ directory one upload overwrote the other.
      const bytes = await server.request(offer.json().url, { headers: fleetHeaders() });
      assert.equal(bytes.status, 200);
      assert.equal(sha256Hex(bytes.buffer), shaOf(system), `${system} downloads its own bytes`);
    }
  });

  test('the same artifact twice in one system is still refused', async () => {
    const res = await upload(bundle({
      version: '5.0.0', cores: [{ platform: 'android-aarch64' }], release: { system: 'gcs' },
    }));
    assert.equal(res.status, 409);
  });

  test('removing one system\'s release leaves the other system\'s release of that number', async () => {
    await publishTo('drone', '6.0.0', 'android-aarch64', null);
    await publishTo('gcs', '6.0.0', 'android-aarch64', null);

    const res = await session.api('/admin/api/systems/drone/releases/6.0.0', { method: 'DELETE' });
    assert.equal(res.status, 200, res.text());
    assert.equal(res.json().system, 'drone');

    const { releases } = (await session.api('/admin/api/catalog')).json();
    assert.ok(!releases.some((r) => r.system === 'drone' && r.version === '6.0.0'));
    const kept = releases.find((r) => r.system === 'gcs' && r.version === '6.0.0');
    assert.ok(kept, 'the gcs release is untouched');
    assert.equal(kept.artifacts[0].readable, true, 'and so are its bytes');
  });

  test('a release route names its system, and another system\'s number is not found there', async () => {
    // gcs has 2.1.0; drone does not.
    const res = await session.api('/admin/api/systems/drone/releases/2.1.0', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('an upload sent to one system carrying a bundle for another is refused', async () => {
    const body = bundle({
      version: '7.0.0', cores: [{ platform: 'android-aarch64' }], release: { system: 'drone' },
    });
    const res = await session.api('/admin/api/systems/gcs/releases/7.0.0/artifacts', {
      method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body,
    });

    assert.equal(res.status, 400);
    assert.ok(res.json().details.some((finding) => finding.rule === 'system_mismatch'));
  });

  test('a channel can only point at a release of its own system', async () => {
    // Held by the database too: channel(system, latest) references release(system, version).
    const res = await session.api('/admin/api/systems/drone/channels/beta', {
      method: 'PUT', body: JSON.stringify({ latest: '2.1.0' }),
    });
    assert.equal(res.status, 400);
  });
});
