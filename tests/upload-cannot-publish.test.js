import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  OIDC_AUDIENCE_ADMIN, SKIP_MESSAGE, bundle, hasDatabase, signIn, startServer,
} from './helpers/harness.js';

/**
 * The guarantee the constitution states in its own words: a leaked credential belonging to
 * someone who may only upload stages a file — it does not ship firmware.
 *
 * It was not true. The one-shot upload takes ?channel= and was gated only on artifact:write,
 * so one request could put a build in front of the whole fleet. These tests are the guarantee,
 * written down in a form that fails if it stops being true.
 */

const PUBLISHER_ROLE = 'aeroserver-publisher';

describe('an upload cannot ship', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let admin;
  let publisher;

  before(async () => {
    server = await startServer({
      env: { AUTO_PROMOTE_CHANNEL: 'beta', REQUIRE_CUMULATIVE_CONFIG: '0' },
    });
    admin = await signIn(server);
    publisher = await signIn(server, 'engineer', [PUBLISHER_ROLE]);
  });

  after(async () => { await server?.close(); });

  const post = (session, pathname, body) => session.api(pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body,
  });

  const channels = async () => (await admin.api('/admin/api/catalog')).json().channels;
  const latest = async (name) => (await channels()).find((c) => c.name === name)?.latest ?? null;

  const build = (version) => bundle({ version, cores: [{ platform: 'linux-x86_64' }] });

  // ── US1: an upload cannot reach the fleet ────────────────────────────────

  test('a publisher asking for stable is refused, and stable does not move', async () => {
    const before = await latest('stable');

    const res = await post(publisher, '/admin/api/artifacts?channel=stable', build('4.0.0'));

    assert.equal(res.status, 403, res.text());
    assert.equal(await latest('stable'), before, 'the fleet channel must not have moved');
  });

  test('the same is true of the per-release route, which shares the handler', async () => {
    // Sharing a handler is exactly what makes the second route easy to forget. One fix covers
    // both; only a test that names both proves it.
    const before = await latest('stable');

    const res = await post(
      publisher, '/admin/api/systems/default/releases/4.0.1/artifacts?channel=stable', build('4.0.1'),
    );

    assert.equal(res.status, 403, res.text());
    assert.equal(await latest('stable'), before);
  });

  /**
   * The regression test for the original finding.
   *
   * The defect was never the status code — it was the ORDER. A publisher naming `stable` got
   * past authorisation and was refused later by the archive reader, so asserting "this request
   * fails" would have passed on the broken code. The payload here is gzip but not a tar, so on
   * the old code the answer was 400 "The gzip stream does not contain a tar archive."
   */
  test('the refusal comes from the permission check, not from the bundle reader', async () => {
    const notABundle = zlib.gzipSync(Buffer.from('deliberately not a bundle'));

    const res = await post(publisher, '/admin/api/artifacts?channel=stable', notABundle);

    assert.equal(res.status, 403, res.text());
    assert.doesNotMatch(res.text(), /gzip stream/,
      'the permission answer must come before a byte of the body is read');
  });

  test('an ordinary upload still lands where ordinary uploads land', async () => {
    const res = await post(publisher, '/admin/api/artifacts', build('4.1.0'));

    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, 'beta');
    assert.equal(await latest('beta'), '4.1.0');
  });

  test('naming beta explicitly asks for nothing extra', async () => {
    // The channel it would have landed on anyway. Requiring a permission for this would stop a
    // publisher getting a build in front of the test group, which is most of the role's job.
    const res = await post(publisher, '/admin/api/artifacts?channel=beta', build('4.2.0'));

    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, 'beta');
    assert.equal(await latest('beta'), '4.2.0');
  });

  test('asking to land nowhere is allowed — nowhere reaches nobody', async () => {
    const beta = await latest('beta');

    const res = await post(publisher, '/admin/api/artifacts?channel=', build('4.3.0'));

    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, null);
    assert.equal(await latest('beta'), beta, 'nothing moved');
  });

  // ── US2: publishing still works for those who may ────────────────────────

  test('an admin naming a channel still lands there, exactly as before', async () => {
    const res = await post(admin, '/admin/api/artifacts?channel=stable', build('4.4.0'));

    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().promoted_to, 'stable');
    assert.equal(await latest('stable'), '4.4.0');
  });

  // ── US4: every path that reaches the fleet gets the same care ────────────

  test('an upload pointing a channel backwards is identified, not applied silently', async () => {
    // How beta went from 0.13.5 to 0.13.4 during an ordinary upload: store() wrote the channel
    // directly and never saw the guard that the promote endpoint has always had.
    await post(admin, '/admin/api/artifacts?channel=beta', build('5.2.0'));

    const res = await post(admin, '/admin/api/artifacts?channel=beta', build('5.1.0'));

    assert.equal(res.status, 400, res.text());
    const finding = (res.json().details ?? []).find((f) => f.rule === 'channel_rollback');
    assert.ok(finding, 'carried as a finding so a caller can offer the confirmation');
    assert.equal(finding.from, '5.2.0');
    assert.equal(finding.to, '5.1.0');
    assert.equal(await latest('beta'), '5.2.0', 'refused means nothing moved');
  });

  test('the artifact is not stored either — a refused move leaves no half-done release', async () => {
    // The guard runs inside store()'s transaction, so the artifact write rolls back with it.
    const { releases } = (await admin.api('/admin/api/catalog')).json();
    assert.ok(!releases.some((r) => r.version === '5.1.0'),
      'a release stored for a channel move that was then refused is a half-done release');
  });

  test('the same upload with the override proceeds', async () => {
    const res = await post(
      admin, '/admin/api/artifacts?channel=beta&allow_rollback=true', build('5.1.0'),
    );

    assert.equal(res.status, 201, res.text());
    assert.equal(await latest('beta'), '5.1.0');
  });

  test('the promote path refuses a backward move identically', async () => {
    // One rule, one shape. A scripted caller handles one refusal, not two that drifted apart.
    await post(admin, '/admin/api/artifacts?channel=beta', build('5.3.0'));

    const res = await admin.api('/admin/api/systems/default/channels/beta', {
      method: 'PUT', body: JSON.stringify({ latest: '5.1.0' }),
    });

    assert.equal(res.status, 400, res.text());
    const finding = (res.json().details ?? []).find((f) => f.rule === 'channel_rollback');
    assert.ok(finding);
    assert.equal(finding.from, '5.3.0');
    assert.equal(finding.to, '5.1.0');
  });

  test('a publisher cannot use the override to reach a channel it may not move', async () => {
    // The override is not a second way in: it is meaningless without the right it overrides.
    const res = await post(
      publisher, '/admin/api/artifacts?channel=stable&allow_rollback=true', build('5.4.0'),
    );

    assert.equal(res.status, 403, res.text());
  });

  // ── US3: a refusal explains itself ───────────────────────────────────────

  test('the refusal names the missing permission and says the upload was fine', async () => {
    // An engineer whose upload suddenly fails will otherwise assume the build is at fault and
    // go looking through the bundle for a problem that is not there.
    const res = await post(publisher, '/admin/api/artifacts?channel=stable', build('4.6.0'));

    assert.equal(res.status, 403);
    const { message } = res.json();
    assert.match(message, /channel:write/, 'name the permission that is missing');
    assert.match(message, /stable/, 'name what was asked for');
    assert.match(message, /upload itself is allowed/i, 'say the upload was not the problem');
    assert.match(message, /beta/, 'say where it would land instead');
  });

  test('the error code stays inside the closed enum', async () => {
    // 403 reuses `invalid_api_key` because the enum under /api/v1 is closed and a node
    // branches on it (constitution III). It reads oddly and is deliberate; without a test
    // someone eventually "fixes" it into a new code the node cannot handle.
    const res = await post(publisher, '/admin/api/artifacts?channel=stable', build('4.7.0'));

    assert.equal(res.json().error, 'invalid_api_key');
  });

  test('the attempt is recorded — a credential asking for more than it holds is worth knowing', async () => {
    await post(publisher, '/admin/api/artifacts?channel=stable', build('4.8.0'));

    const { entries } = (await admin.api('/admin/api/audit')).json();
    const entry = entries.find((row) => row.action === 'channel.denied');

    assert.ok(entry, 'a refusal nobody can find afterwards is not accountable');
    assert.equal(entry.actor, 'engineer');
    assert.equal(entry.subject, 'stable');
    assert.equal(entry.detail.missing, 'channel:write');
  });

  test('the two-step publish is untouched: it names no channel and needs none', async () => {
    // Deliberately a version ABOVE whatever beta holds by now: this test is about the permission
    // to name a channel, and the commit path acquired the rollback guard along with every other
    // path — see the test below, which is that consequence on purpose rather than by accident.
    const staged = await post(publisher, '/admin/api/uploads', build('9.0.0'));
    assert.equal(staged.status, 200, staged.text());
    assert.equal(staged.json().stored, false);

    const committed = await publisher.api(`/admin/api/uploads/${staged.json().token}`, {
      method: 'POST',
    });

    assert.equal(committed.status, 201, committed.text());
    assert.equal(committed.json().promoted_to, 'beta');
    assert.equal(await latest('beta'), '9.0.0');
  });

  /**
   * The consequence of putting the guard where every path meets it.
   *
   * The two-step publish never names a channel and still needs no permission to use — but it
   * does write one, so it now meets the same backward-move guard as everything else. That is
   * what "every path that can do it" in the spec means, and it is why the Publish screen has
   * to be able to offer the confirmation.
   */
  test('the two-step commit meets the same guard, and the same override clears it', async () => {
    const staged = await post(publisher, '/admin/api/uploads', build('8.0.0'));
    const token = staged.json().token;

    const refused = await publisher.api(`/admin/api/uploads/${token}`, { method: 'POST' });
    assert.equal(refused.status, 400, refused.text());
    const finding = (refused.json().details ?? []).find((f) => f.rule === 'channel_rollback');
    assert.ok(finding, 'the screen needs a finding to offer the confirmation from');
    assert.equal(finding.from, '9.0.0');
    assert.equal(finding.to, '8.0.0');

    const confirmed = await publisher.api(
      `/admin/api/uploads/${token}?allow_rollback=true`, { method: 'POST' },
    );
    assert.equal(confirmed.status, 201, confirmed.text());
    assert.equal(await latest('beta'), '8.0.0');
  });
});
