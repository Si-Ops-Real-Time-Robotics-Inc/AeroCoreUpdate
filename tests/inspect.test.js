import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  SKIP_MESSAGE, bundle, fakeArtifact, hasDatabase, legacyBundle, sha256Hex, signIn, startServer,
} from './helpers/harness.js';
import { targz } from './helpers/targz.js';

describe('bundle inspection on upload', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;
  let artifactsDir;

  before(async () => {
    // This suite is about what the inspector reads out of a bundle. The cumulative-config
    // rule is a publishing policy with its own suite (configgap.test.js), and leaving it on
    // here chains unrelated tests together: one fixture that sets a config param makes every
    // later upload in the file fail for omitting it.
    server = await startServer({ env: { REQUIRE_CUMULATIVE_CONFIG: '0' } });
    session = await signIn(server);
    artifactsDir = path.join(server.dir, 'artifacts');
  });

  after(async () => { await server?.close(); });

  /** Upload to the versionless route, so the bundle is the only source of the version. */
  const upload = (body, query = '') => session.api(
    `/admin/api/artifacts${query ? `?${query}` : ''}`,
    { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body },
  );

  const listVersionDir = async (version) => {
    try {
      return await fsp.readdir(path.join(artifactsDir, version));
    } catch {
      return [];
    }
  };

  const tempParts = async () => {
    const entries = await fsp.readdir(path.join(artifactsDir, '.tmp')).catch(() => []);
    return entries.filter((f) => f.endsWith('.part'));
  };

  // ── the rule this whole feature exists for ──────────────────────────────────────────────

  test('a core slice stamped with a different version is refused', async () => {
    const body = bundle({
      version: '0.16.0',
      cores: [{ platform: 'linux-x86_64', version: '0.15.0' }], // deliberately stale
    });

    const res = await upload(body);

    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'invalid_parameter');
    assert.match(res.json().message, /core\/linux-x86_64\/manifest\.json says 0\.15\.0/,
      'names the file and the version stamped in it');
    assert.match(res.json().message, /the bundle says 0\.16\.0/, 'and what it disagrees with');
    assert.match(res.json().message, /same_version/,
      'the message must name the symptom the fleet would otherwise report');

    assert.deepEqual(await listVersionDir('0.16.0'), [], 'nothing may be stored');
    assert.deepEqual(await tempParts(), [], 'the temp file must be cleaned up');
  });

  // ── container-level rejections ──────────────────────────────────────────────────────────

  test('a body that is not a gzip is refused', async () => {
    const res = await upload(fakeArtifact(2048, 5));

    assert.equal(res.status, 400);
    assert.match(res.json().message, /not a gzip archive/);
    assert.deepEqual(await tempParts(), []);
  });

  test('a gzip that is not a tar is refused', async () => {
    const res = await upload(zlib.gzipSync(fakeArtifact(2048, 7)));

    assert.equal(res.status, 400);
    assert.match(res.json().message, /does not contain a tar archive/);
  });

  test('an archive with no manifest is refused', async () => {
    const res = await upload(targz([{ name: 'random.txt', body: 'nothing useful' }]));

    assert.equal(res.status, 400);
    assert.match(res.json().message, /no manifest\.json/);
  });

  // ── content rules, with every finding returned at once ──────────────────────────────────

  test('every finding is returned, not just the first', async () => {
    const body = bundle({
      version: '0.17.0',
      cores: [
        { platform: 'linux-x86_64', version: '0.16.0', bin: false },
        { platform: 'linux-aarch64', version: '0.16.0' },
      ],
    });

    const res = await upload(body);
    assert.equal(res.status, 400);

    const rules = res.json().details.map((finding) => finding.rule);
    assert.ok(rules.includes('core_slice_version_mismatch'));
    assert.ok(rules.includes('core_slice_no_bin'));
    assert.ok(rules.length >= 3, `expected several findings, got ${rules.join(', ')}`);
  });

  test('version 0.0.0 is refused because it means --version was omitted', async () => {
    const body = bundle({
      version: '0.0.0', cores: [{ platform: 'linux-x86_64', version: '0.0.0' }],
    });

    const res = await upload(body);
    assert.equal(res.status, 400);
    assert.match(res.json().message, /--version/);
  });

  test('a core variant path missing from the archive is refused', async () => {
    const body = bundle({
      version: '0.18.0',
      cores: [{ platform: 'linux-x86_64' }],
      patch: (m) => {
        m.components[0].variants[0].path = 'core/nowhere';
        return m;
      },
    });

    const res = await upload(body);
    assert.equal(res.status, 400);
    assert.match(res.json().message, /not in the archive/);
  });

  test('a config component before the core is refused', async () => {
    const body = bundle({
      version: '0.19.0',
      cores: [{ platform: 'linux-x86_64' }],
      configs: [{ target: 'core' }],
      patch: (m) => { m.components.reverse(); return m; },
    });

    const res = await upload(body);
    assert.equal(res.status, 400);
    assert.match(res.json().message, /overwritten on restart/);
  });

  // ── cross-checks ────────────────────────────────────────────────────────────────────────

  test('a version asserted in the URL must match the bundle', async () => {
    const body = bundle({ version: '0.20.0', cores: [{ platform: 'linux-x86_64' }] });

    const res = await session.api('/admin/api/releases/0.21.0/artifacts', {
      method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body,
    });

    assert.equal(res.status, 400);
    assert.match(res.json().message, /URL says version 0\.21\.0.*bundle.*0\.20\.0/s);
  });

  test('a platform set asserted in the query must match the bundle', async () => {
    const body = bundle({
      version: '0.22.0',
      cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
    });

    const res = await upload(body, 'platforms=linux-x86_64');
    assert.equal(res.status, 400);
    assert.match(res.json().message, /source of truth/);
  });

  test('kind=slim is refused for a multi-platform bundle', async () => {
    const body = bundle({
      version: '0.23.0',
      cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
    });

    const res = await upload(body, 'kind=slim');
    assert.equal(res.status, 400);
    assert.match(res.json().message, /kind=slim needs exactly one platform/);
  });

  // ── accepted, with what the bundle told us ──────────────────────────────────────────────

  test('plugin versions are read out of the bundle, not typed in', async () => {
    const body = bundle({
      version: '0.24.0',
      cores: [{ platform: 'linux-x86_64' }],
      plugins: [{ name: 'SRTunnel_Plugin', platform: 'linux-x86_64', version: '1.3.0' }],
    });

    const res = await upload(body);
    assert.equal(res.status, 201, res.text());
    assert.deepEqual(res.json().plugins, { 'linux-x86_64': { SRTunnel_Plugin: '1.3.0' } });
    assert.deepEqual(res.json().plugins_unknown, []);
  });

  test('a plugin reporting "unknown" is stored and flagged, never rejected', async () => {
    const body = bundle({
      version: '0.25.0',
      cores: [{ platform: 'linux-x86_64' }],
      plugins: [{ name: 'Odd_Plugin', platform: 'linux-x86_64', version: 'unknown' }],
    });

    const res = await upload(body);
    assert.equal(res.status, 201, res.text());
    assert.deepEqual(res.json().plugins_unknown, ['linux-x86_64/Odd_Plugin']);
    assert.ok(res.json().inspection.warnings.some((w) => w.rule === 'plugin_version_unknown'));

    // And the check endpoint must survive it — isNewer('unknown', x) throws.
    await session.api('/admin/api/systems/default/channels/stable', {
      method: 'PUT', body: JSON.stringify({ latest: '0.25.0' }),
    });
    const check = await server.request(
      '/api/v1/update/check?serial=SN-U&platform=linux-x86_64&version=0.13.0'
      + '&system=default&channel=stable',
      { headers: { 'X-API-Key': 'test-fleet-key-0123456789' } },
    );

    assert.equal(check.status, 200, 'an unorderable plugin version must not 500 the fleet');
  });

  test('the .components build leftover does not trip anything', async () => {
    const body = bundle({ version: '0.26.0', cores: [{ platform: 'linux-x86_64' }] });
    // bundle() always includes it, exactly as package_update_bundle.sh does.
    assert.equal((await upload(body)).status, 201);
  });

  test('a legacy single-directory package is accepted with a warning', async () => {
    const body = legacyBundle({ version: '0.27.0', platform: 'linux-x86_64' });

    const res = await upload(body);
    assert.equal(res.status, 201, res.text());
    assert.equal(res.json().bundle_format, 'legacy');
    assert.deepEqual(res.json().platforms, ['linux-x86_64']);
    assert.ok(res.json().inspection.warnings.some((w) => w.rule === 'legacy_format'));
  });

  test('a config-only bundle needs the platforms it cannot derive', async () => {
    const body = bundle({ version: '0.28.0', configs: [{ target: 'Camera_Argus_Plugin' }] });

    const refused = await upload(body);
    assert.equal(refused.status, 400);
    assert.match(refused.json().message, /only config components/);

    const accepted = await upload(body, 'platforms=linux-x86_64');
    assert.equal(accepted.status, 201, accepted.text());
    assert.deepEqual(accepted.json().platforms, ['linux-x86_64']);
  });

  test('the stored report can be fetched again', async () => {
    const body = bundle({
      version: '0.29.0',
      cores: [{ platform: 'linux-x86_64', plugins: ['Example/libExample.so'] }],
    });

    const created = await upload(body);
    assert.equal(created.status, 201, created.text());

    const fetched = await session.api(`/admin/api/artifacts/${created.json().id}`);
    assert.equal(fetched.status, 200);

    // The report survives the round trip through JSONB, structure and all. Plugins riding
    // inside a core slice are recorded rather than warned about — every runtime slice carries
    // some, so a warning would fire on every upload ever made and mean nothing.
    const report = fetched.json().inspection;
    assert.equal(report.format, 'bundle');
    assert.deepEqual(report.cores[0].bundled_plugins.map((p) => p.name), ['Example']);
    assert.equal(report.cores[0].platform, 'linux-x86_64');
  });

  test('two concurrent fleet uploads of one version yield exactly one artifact', async () => {
    const body = bundle({
      version: '0.30.0',
      cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
    });

    const [a, b] = await Promise.all([upload(body), upload(body)]);
    const statuses = [a.status, b.status].sort();

    assert.deepEqual(statuses, [201, 409],
      'the partial unique index must stop the second one; NULL platforms are distinct to a '
      + 'plain UNIQUE constraint');
    assert.deepEqual(await listVersionDir('0.30.0'), ['fleet.tar.gz']);
  });

  test('a good upload leaves no temp files behind at all', async () => {
    const body = bundle({ version: '0.31.0', cores: [{ platform: 'linux-x86_64' }] });
    assert.equal((await upload(body, `kind=fleet`)).status, 201);

    assert.deepEqual(await tempParts(), []);
    // A one-platform fleet artifact is legitimate: the POST check form prefers fleet.
    assert.deepEqual(await listVersionDir('0.31.0'), ['fleet.tar.gz']);
  });

  test('the stored bytes are exactly what was sent', async () => {
    const body = bundle({ version: '0.32.0', cores: [{ platform: 'linux-x86_64' }] });
    const res = await upload(body);
    assert.equal(res.status, 201, res.text());

    const onDisk = await fsp.readFile(path.join(artifactsDir, '0.32.0', 'linux-x86_64.tar.gz'));
    assert.ok(onDisk.equals(body));
    assert.equal(res.json().sha256, sha256Hex(body));
  });
});
