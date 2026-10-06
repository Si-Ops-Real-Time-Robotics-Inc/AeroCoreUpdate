import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  SKIP_MESSAGE, fleetHeaders, hasDatabase, publish, setChannel, signIn, startServer,
} from './helpers/harness.js';

/**
 * Removing an uploaded build — and the property that makes it safe to offer: no removal can
 * silently stop the fleet updating.
 *
 * A channel pointing at a release with nothing to download for a platform answers every device
 * on it "no update", with no error — a fleet that has stopped looks exactly like one that is up
 * to date. So a build a channel serves cannot be removed, in whole or in part, and the refusal
 * holds under a race, not just when nobody else is working.
 */
describe('removing a build', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let admin;
  let getPool;
  let artifactPath;
  let second;

  before(async () => {
    // The harness pins AUTO_PROMOTE_CHANNEL to empty, so every publish() lands nowhere and a
    // release is served only where a test points a channel at it.
    server = await startServer();
    admin = await signIn(server);
    // Imported after startServer(): the same configured modules the server is using.
    ({ getPool } = await import('../src/db/pool.js'));
    ({ artifactPath } = await import('../src/repositories/catalog.repository.js'));
    // Dynamic, like the two above: domain/platform.js imports config/index.js, and a static
    // import evaluates it before startServer() has set the environment — the pool then points
    // somewhere else entirely and before() never returns.
    const { KNOWN_PLATFORMS } = await import('../src/domain/platform.js');
    second = KNOWN_PLATFORMS.find((p) => p !== 'linux-x86_64' && !p.startsWith('android'));

    await publish(admin, { version: '7.0.0' });
    await setChannel(admin, 'stable', { latest: '7.0.0' });

    await publish(admin, { version: '7.1.0', platform: 'linux-x86_64' });
    await publish(admin, { version: '7.1.0', platform: second });

    await publish(admin, { version: '7.2.0' });
    await publish(admin, { version: '7.3.0' });
  });

  after(async () => { await server?.close(); });

  const catalog = async () => (await admin.api('/admin/api/catalog')).json();
  const release = async (version) => (await catalog()).releases.find((r) => r.version === version);
  const remove = (pathname) => admin.api(pathname, { method: 'DELETE' });
  const exists = (file) => fsp.access(file).then(() => true, () => false);
  const finding = (res) => (res.json().details ?? []).find((f) => f.rule === 'release_in_use');

  // ── a served build cannot be removed ─────────────────────────────────────

  test('a release a channel serves is refused, naming the channel', async () => {
    const res = await remove('/admin/api/systems/default/releases/7.0.0');

    assert.equal(res.status, 409, res.text());
    assert.ok(finding(res), 'carried as a finding, so a caller need not parse the message');
    assert.ok(finding(res).channels.includes('default/stable'));
    assert.ok(await release('7.0.0'), 'refused means nothing was removed');
  });

  test('an artifact of a release a channel serves is refused the same way', async () => {
    const [artifact] = (await release('7.0.0')).artifacts;

    const res = await remove(`/admin/api/artifacts/${artifact.id}`);

    assert.equal(res.status, 409, res.text());
    assert.ok(finding(res)?.channels.includes('default/stable'));
    assert.ok(await exists(artifactPath('default', '7.0.0', artifact.file)), 'the file must still be there');
    assert.ok((await release('7.0.0')).artifacts.some((a) => a.id === artifact.id));
  });

  test('after both refusals, a device on stable is still offered the release', async () => {
    // What the refusals are FOR. Without the artifact check the previous request succeeds, and
    // this answer turns into "no update" with nothing anywhere saying why.
    const res = await server.request(
      '/api/v1/update/check?system=default&serial=SN-1&platform=linux-x86_64&version=0.1.0&channel=stable',
      { headers: fleetHeaders() },
    );

    assert.equal(res.status, 200, res.text());
    assert.equal(res.json().update_available, true);
    assert.equal(res.json().version, '7.0.0');
  });

  test('once the channel points elsewhere, the release can go', async () => {
    await setChannel(admin, 'stable', { latest: '7.2.0' });

    const res = await remove('/admin/api/systems/default/releases/7.0.0');

    assert.equal(res.status, 200, res.text());
  });

  // ── the schema refuses too ───────────────────────────────────────────────

  test('channel.latest restricts deleting the release it points at', async () => {
    const { rows } = await getPool().query(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'channel'::regclass AND conname = 'channel_latest_fkey'`,
    );
    // 'r' is RESTRICT. It was 'n' — SET NULL — which emptied the channel instead of refusing.
    assert.equal(rows[0]?.confdeltype, 'r');
  });

  test('a served release cannot be deleted on any path, including one not written yet', async () => {
    await assert.rejects(
      getPool().query("DELETE FROM release WHERE version = '7.2.0'"),
      (err) => err.code === '23503',
    );
    const stable = (await catalog()).channels.find((c) => c.name === 'stable');
    assert.equal(stable.latest, '7.2.0', 'the channel must still point where it did');
  });

  // ── the race ─────────────────────────────────────────────────────────────

  test('a promote in flight holds the removal until it commits, and it is then refused', async () => {
    // A promote that has not committed yet. Its foreign-key check holds FOR KEY SHARE on 7.3.0,
    // which is exactly what the removal's FOR UPDATE has to wait for.
    const raw = await getPool().connect();
    try {
      await raw.query('BEGIN');
      await raw.query("UPDATE channel SET latest = '7.3.0' WHERE system = 'default' AND name = 'beta'");

      let settled = false;
      const pending = remove('/admin/api/systems/default/releases/7.3.0').then((res) => { settled = true; return res; });

      await new Promise((resolve) => { setTimeout(resolve, 300); });
      assert.equal(settled, false, 'the removal must wait for the promote holding the release');

      await raw.query('COMMIT');
      const res = await pending;

      assert.equal(res.status, 409, res.text());
      assert.ok(finding(res)?.channels.includes('default/beta'));
      assert.ok(await release('7.3.0'), 'the release a channel just started serving is still there');
    } finally {
      await raw.query('ROLLBACK').catch(() => {});
      raw.release();
    }
  });

  // ── an unserved build can go ─────────────────────────────────────────────

  test('an artifact of an unserved release is removed with its file, and audited', async () => {
    const artifacts = (await release('7.1.0')).artifacts;
    const target = artifacts.find((a) => a.platform === second);
    const other = artifacts.find((a) => a.id !== target.id);

    const res = await remove(`/admin/api/artifacts/${target.id}`);

    assert.equal(res.status, 200, res.text());
    assert.deepEqual(res.json(), { id: target.id });
    assert.equal(await exists(artifactPath('default', '7.1.0', target.file)), false, 'the file goes with the row');
    assert.deepEqual((await release('7.1.0')).artifacts.map((a) => a.id), [other.id]);

    const { entries } = (await admin.api('/admin/api/audit')).json();
    assert.ok(entries.some((e) => e.action === 'artifact.delete' && e.subject === `default/7.1.0/${target.file}`));
  });

  test('an unserved release is removed with every artifact and its directory, and audited', async () => {
    const res = await remove('/admin/api/systems/default/releases/7.1.0');

    assert.equal(res.status, 200, res.text());
    assert.deepEqual(res.json(), { system: 'default', version: '7.1.0', artifacts: 1 });
    assert.equal(await exists(path.dirname(artifactPath('default', '7.1.0', 'x'))), false);
    assert.equal(await release('7.1.0'), undefined);

    const { entries } = (await admin.api('/admin/api/audit')).json();
    assert.ok(entries.some((e) => e.action === 'release.delete' && e.subject === 'default/7.1.0'));
  });

  test('removing something already gone says so, rather than failing', async () => {
    assert.equal((await remove('/admin/api/systems/default/releases/7.1.0')).status, 404);
    assert.equal((await remove('/admin/api/artifacts/999999')).status, 404);
  });

  // ── only an administrator ────────────────────────────────────────────────

  test('an account without catalog:delete is refused both operations', async () => {
    // Existing behaviour, through requireScope. Pinned here because removing is permanent, and
    // a route that quietly lost its scope would let every signed-in account empty the catalog.
    const publisher = await signIn(server, 'engineer', ['aeroserver-publisher']);
    const viewer = await signIn(server, 'viewer', ['aeroserver-viewer']);
    const [{ id }] = (await release('7.2.0')).artifacts;

    for (const session of [publisher, viewer]) {
      assert.equal((await session.api('/admin/api/systems/default/releases/7.2.0', { method: 'DELETE' })).status, 403);
      assert.equal((await session.api(`/admin/api/artifacts/${id}`, { method: 'DELETE' })).status, 403);
    }
    assert.ok(await release('7.2.0'), 'refused means nothing was removed');
  });
});
