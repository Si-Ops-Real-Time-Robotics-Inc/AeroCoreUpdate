import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { readTar } from '../src/core/tar.js';
import {
  crossCheck, flattenConfigPayload, inspectBundle, isInspectableMember, resolveKind,
} from '../src/domain/bundle.js';
import { bundle, legacyBundle, targz } from './helpers/bundles.js';

/** Run a fixture through the real reader, then build the index the domain expects. */
async function inspect(gz) {
  const scan = await readTar(Readable.from([zlib.gunzipSync(gz)]), {
    select: isInspectableMember,
  });

  const json = new Map();
  const unparseable = new Set();
  const sizes = new Map();

  for (const [name, body] of scan.files) {
    sizes.set(name, body.length);
    try {
      json.set(name, JSON.parse(body.toString('utf8')));
    } catch {
      unparseable.add(name);
    }
  }

  return inspectBundle({ names: scan.names, json, unparseable, sizes, oversize: scan.oversize });
}

const rules = (findings) => findings.map((f) => f.rule);
const messageFor = (findings, rule) => findings.find((f) => f.rule === rule)?.message ?? '';

// ── the happy path ────────────────────────────────────────────────────────────────────────

test('a well-formed two-platform bundle passes with no errors', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
    plugins: [
      { name: 'SRTunnel_Plugin', platform: 'linux-x86_64', version: '1.3.0' },
      { name: 'Camera_Argus_Plugin', platform: 'android-aarch64', version: '2.1.0' },
    ],
    configs: [{ target: 'core' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.format, 'bundle');
  assert.equal(result.version, '0.15.0');
  assert.deepEqual(result.platforms, ['android-aarch64', 'linux-x86_64']);
  assert.equal(result.cores.length, 2);
  assert.deepEqual(result.cores.map((c) => c.sliceVersion), ['0.15.0', '0.15.0']);
  assert.deepEqual(
    result.plugins.map((p) => [p.name, p.platform, p.version, p.versionKnown]),
    [
      ['SRTunnel_Plugin', 'linux-x86_64', '1.3.0', true],
      ['Camera_Argus_Plugin', 'android-aarch64', '2.1.0', true],
    ],
  );
  assert.deepEqual(result.configs, [{
    target: 'core',
    path: 'config/core-values.json',
    params: [{ param: 'web.port', value: 9090 }],
  }]);
});

test('the .components build leftover produces no finding at all', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

// ── the rule this whole feature exists for ────────────────────────────────────────────────

test('a core slice stamped with a different version is an error', async () => {
  const result = await inspect(bundle({
    version: '0.16.0',
    cores: [{ platform: 'linux-x86_64', version: '0.15.0' }],
  }));

  assert.ok(rules(result.errors).includes('core_slice_version_mismatch'));

  const message = messageFor(result.errors, 'core_slice_version_mismatch');
  assert.match(message, /core\/linux-x86_64\/manifest\.json says 0\.15\.0/);
  assert.match(message, /bundle says 0\.16\.0/);
  assert.match(message, /same_version/, 'the message must name the node-side symptom');
});

test('a matching slice version is fine', async () => {
  const result = await inspect(bundle({
    version: '0.16.0', cores: [{ platform: 'linux-x86_64', version: '0.16.0' }],
  }));
  assert.deepEqual(result.errors, []);
});

// ── version rules ─────────────────────────────────────────────────────────────────────────

test('0.0.0 is refused because it is the --version-omitted fallback', async () => {
  const result = await inspect(bundle({
    version: '0.0.0', cores: [{ platform: 'linux-x86_64', version: '0.0.0' }],
  }));

  assert.ok(rules(result.errors).includes('version_placeholder'));
  assert.match(messageFor(result.errors, 'version_placeholder'), /--version/);
});

test('a non-numeric version is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0-rc1', cores: [{ platform: 'linux-x86_64', version: '0.15.0-rc1' }],
  }));
  assert.ok(rules(result.errors).includes('version_invalid'));
});

test('a missing version is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    patch: (m) => { delete m.version; return m; },
  }));
  assert.ok(rules(result.errors).includes('version_missing'));
});

// ── structure rules ───────────────────────────────────────────────────────────────────────

test('a root manifest that is not JSON is refused', async () => {
  const gz = targz([
    { name: 'manifest.json', body: 'this is not json' },
    { name: 'core/linux-x86_64/bin/AeroCoreEngine', body: 'ELF' },
  ]);

  const result = await inspect(gz);
  assert.deepEqual(rules(result.errors), ['manifest_not_json']);
});

test('an archive with no manifest at all is refused', async () => {
  const result = await inspect(targz([{ name: 'random/file.txt', body: 'x' }]));
  assert.deepEqual(rules(result.errors), ['no_manifest']);
});

test('two top-level directories with manifests are refused as ambiguous', async () => {
  const gz = targz([
    { name: 'a/manifest.json', body: '{"version":"1.0.0","platform":"linux-x86_64"}' },
    { name: 'b/manifest.json', body: '{"version":"1.0.0","platform":"linux-x86_64"}' },
  ]);

  const result = await inspect(gz);
  assert.deepEqual(rules(result.errors), ['ambiguous_root']);
  assert.match(messageFor(result.errors, 'ambiguous_root'), /unspecified\s+filesystem order/);
});

test('a core slice with an unparseable manifest is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', manifest: '' }],   // the real 0-byte case on disk
  }));
  assert.ok(rules(result.errors).includes('core_slice_manifest_unreadable'));
});

test('an unknown platform in a variant is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'plan9-vax' }],
  }));

  assert.ok(rules(result.errors).includes('variant_platform_unknown'));
  assert.match(messageFor(result.errors, 'variant_platform_unknown'), /exact string/);
});

test('a core variant whose path is not in the archive is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    patch: (m) => {
      m.components[0].variants[0].path = 'core/does-not-exist';
      return m;
    },
  }));
  assert.ok(rules(result.errors).includes('core_variant_path_missing'));
});

test('a duplicated platform is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    patch: (m) => {
      m.components[0].variants.push({ platform: 'linux-x86_64', path: 'core/linux-x86_64' });
      return m;
    },
  }));
  assert.ok(rules(result.errors).includes('duplicate_platform'));
});

test('a core slice with no bin/ is refused, except on Android', async () => {
  const linux = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64', bin: false }],
  }));
  assert.ok(rules(linux.errors).includes('core_slice_no_bin'));

  // On Android the binary lives in nativeLibraryDir and the launcher skips bin/ by design.
  const android = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'android-aarch64', bin: false }],
  }));
  assert.deepEqual(android.errors, []);
  assert.ok(rules(android.warnings).includes('core_slice_no_bin'));
});

test('a config component listed before the core is refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    configs: [{ target: 'core' }],
    patch: (m) => { m.components.reverse(); return m; },
  }));

  assert.ok(rules(result.errors).includes('config_before_core'));
  assert.match(messageFor(result.errors, 'config_before_core'), /overwritten on restart/);
});

test('an empty components array is refused', async () => {
  const result = await inspect(bundle({ version: '0.15.0' }));
  assert.ok(rules(result.errors).includes('no_components'));
});

// ── warnings, never errors ────────────────────────────────────────────────────────────────

test('a plugin reporting version "unknown" is a warning, never an error', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    plugins: [{ name: 'Odd_Plugin', platform: 'linux-x86_64', version: 'unknown' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(rules(result.warnings).includes('plugin_version_unknown'));
  assert.deepEqual(
    result.plugins.map((p) => [p.version, p.versionKnown]),
    [['unknown', false]],
  );
});

test('a plugin with a 0-byte manifest is a warning', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    plugins: [{ name: 'Stub_Plugin', platform: 'linux-x86_64', manifest: '' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(rules(result.warnings).includes('plugin_slice_manifest_unreadable'));
  assert.equal(result.plugins[0].versionKnown, false);
});

test('a Windows plugin slice saying bare "windows" is not a mismatch', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'windows-x86_64' }],
    plugins: [{
      name: 'Win_Plugin',
      platform: 'windows-x86_64',
      manifest: JSON.stringify({ plugin: 'Win_Plugin', version: '1.0.0', platform: 'windows' }),
    }],
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(!rules(result.warnings).includes('plugin_slice_platform_mismatch'),
    'a bare "windows" is what the Windows build actually writes');
});

test('a core slice shipping plugins/ is only a warning', async () => {
  // A real runtime slice legitimately contains plugins; rejecting it would reject every
  // genuine bundle.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', plugins: ['Example_Plugin/libExample.so'] }],
  }));

  assert.deepEqual(result.errors, []);
  // Recorded, not warned about: every runtime slice carries plugins, so a warning here would
  // fire on every upload ever made. The panel lists them instead.
  assert.deepEqual(result.cores[0].bundledPlugins.map((p) => p.name), ['Example_Plugin']);
});

test('an unrecognised component type is skipped, not fatal', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    patch: (m) => { m.components.push({ type: 'firmware', path: 'x' }); return m; },
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(rules(result.warnings).includes('unknown_component_type'));
});

test('a plugin-only bundle warns that no version will change', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    plugins: [{ name: 'Solo_Plugin', platform: 'linux-x86_64', version: '1.0.0' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(rules(result.warnings).includes('no_core_component'));
  assert.deepEqual(result.platforms, ['linux-x86_64']);
});

// ── legacy ────────────────────────────────────────────────────────────────────────────────

test('a legacy single-directory package is accepted as a bare core', async () => {
  const result = await inspect(legacyBundle({ version: '0.13.3', platform: 'linux-x86_64' }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.format, 'legacy');
  assert.equal(result.version, '0.13.3');
  assert.deepEqual(result.platforms, ['linux-x86_64']);
  assert.ok(rules(result.warnings).includes('legacy_format'));
});

test('a legacy package that is really a plugin slice is refused', async () => {
  const result = await inspect(legacyBundle({
    manifest: JSON.stringify({ plugin: 'SRTunnel_Plugin', version: '1.3.0', platform: 'linux-x86_64' }),
  }));

  assert.ok(rules(result.errors).includes('legacy_is_plugin_slice'));
  assert.match(messageFor(result.errors, 'legacy_is_plugin_slice'), /stage a plugin folder as the core/);
});

test('a legacy package with no platform is refused', async () => {
  const result = await inspect(legacyBundle({
    manifest: JSON.stringify({ package: 'AeroCoreEngine', version: '0.13.3' }),
  }));
  assert.ok(rules(result.errors).includes('legacy_no_platform'));
});

// ── cross-checks and kind ─────────────────────────────────────────────────────────────────

test('crossCheck catches a version the caller asserted wrongly', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }],
  }));

  assert.deepEqual(rules(crossCheck(result, { version: '0.15.0' })), []);
  assert.deepEqual(rules(crossCheck(result, { version: '0.16.0' })), ['cross_check_version']);
});

test('crossCheck catches a platform set the caller asserted wrongly', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
  }));

  assert.deepEqual(
    rules(crossCheck(result, { platforms: ['android-aarch64', 'linux-x86_64'] })), [],
  );
  // Order must not matter.
  assert.deepEqual(
    rules(crossCheck(result, { platforms: ['linux-x86_64', 'android-aarch64'] })), [],
  );
  assert.deepEqual(rules(crossCheck(result, { platforms: ['linux-x86_64'] })),
    ['cross_check_platforms']);
});

test('kind=slim is refused for a multi-platform bundle', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }, { platform: 'android-aarch64' }],
  }));

  assert.deepEqual(rules(crossCheck(result, { kind: 'slim' })), ['kind_slim_multi_platform']);
  assert.deepEqual(rules(crossCheck(result, { kind: 'fleet' })), []);
});

test('a config-only bundle needs ?platforms= because nothing else can supply it', async () => {
  const result = await inspect(bundle({
    version: '0.15.1', configs: [{ target: 'Camera_Argus_Plugin' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.platforms, []);
  assert.deepEqual(rules(crossCheck(result, {})), ['config_only_needs_platforms']);
  assert.deepEqual(rules(crossCheck(result, { platforms: ['linux-x86_64'] })), []);
});

test('kind is derived from the platform count, and an explicit value wins', () => {
  assert.equal(resolveKind(['linux-x86_64']), 'slim');
  assert.equal(resolveKind(['linux-x86_64', 'android-aarch64']), 'fleet');
  // A one-platform fleet catalog is legitimate: the POST check form prefers fleet artifacts.
  assert.equal(resolveKind(['linux-x86_64'], 'fleet'), 'fleet');
});

// ── everything the server reads so an operator types nothing ──────────────────────────────

test('release.json supplies the metadata the bundle manifest cannot carry', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { min_version: '0.13.0', mandatory: true, notes: 'Adds ZMQ bus self-description.' },
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.release, {
    system: null,
    minVersion: '0.13.0',
    mandatory: true,
    notes: 'Adds ZMQ bus self-description.',
    configDropped: [],
  });
});

test('a missing release.json is normal, not a finding', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.release,
    { system: null, minVersion: null, mandatory: false, notes: null, configDropped: [] });
});

// ── which kind of device the bundle is for ────────────────────────────────────────────────
//
// The node cannot tell the server its system: its update client sends only serial, platform,
// version, role and channel. So the bundle declaring it is what makes systems possible at
// all — the server records it on the release, and every node reporting that version is
// classified by it from then on.

test('release.json declares the system', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { system: 'drone' },
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'drone');
});

test('a system name is trimmed, and blank is the same as absent', async () => {
  const padded = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }], release: { system: '  gcs  ' },
  }));
  assert.equal(padded.release.system, 'gcs');

  const blank = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }], release: { system: '   ' },
  }));
  assert.equal(blank.release.system, null, 'falls back to the default system at publish time');
});

test('a non-string system is ignored rather than refused', async () => {
  // Whether the name exists is the publish step's call, not the domain's: this layer never
  // reaches a database. A bad type here must not block an otherwise sound bundle.
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }], release: { system: 42 },
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, null);
});

// The build stamps "system" into every slice manifest, which makes it a stronger source than
// release.json: it cannot drift from the binaries it was built alongside, and it needs nothing
// added to the packaging pipeline.

test('the system comes from the core slice manifest', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'HERA');
  assert.deepEqual(result.cores[0].system, 'HERA');
});

test('a plugin does not name the bundle\'s system — only the core does', async () => {
  // system_covers() reads a plugin's system as the list of products it is VALID ON, and a
  // plugin is often fine on several. Treating that as the bundle's own system would file a
  // release under whatever its first plugin happened to support.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    plugins: [{ name: 'Camera', platform: 'linux-x86_64', system: 'drone' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, null, 'the core named none, so the bundle names none');
  assert.deepEqual(result.declaredSystems, []);
});

test('a plugin may declare a list of systems it works on', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
    plugins: [{ name: 'Camera', platform: 'linux-x86_64', system: ['HERA', 'drone'] }],
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'HERA', 'still one system: the core names it');
  assert.deepEqual(result.plugins[0].declaredSystems, ['HERA', 'drone']);
  assert.ok(!rules(result.warnings).includes('plugin_slice_system_mismatch'),
    'HERA is covered, so there is nothing to say');
});

test('a plugin whose list excludes the bundle\'s system is flagged', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
    plugins: [{ name: 'Camera', platform: 'linux-x86_64', system: ['drone', 'rover'] }],
  }));

  // A warning, not an error: the bundle's system is unambiguous. What is wrong is that this
  // plugin will be skipped on every node that installs it — silently, as a non-fatal skip.
  assert.deepEqual(result.errors, []);
  const message = messageFor(result.warnings, 'plugin_slice_system_mismatch');
  assert.match(message, /drone, rover/);
  assert.match(message, /HERA/);
  assert.match(message, /skip it/);
});

test('the slice manifest outranks release.json, and the disagreement is reported', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
    release: { system: 'drone' },
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'HERA', 'the binaries win over the side-car file');
  const warning = result.warnings.find((w) => w.rule === 'release_json_system_mismatch');
  assert.ok(warning, 'the operator has to be told which one was used');
  assert.match(warning.message, /drone/);
  assert.match(warning.message, /HERA/);
});

test('release.json still names the system when no slice does', async () => {
  // Bundles from a build that predates the stamped field.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { system: 'gcs' },
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'gcs');
});

test('slices naming different systems are refused', async () => {
  // A bundle belongs to exactly one version line. Picking either name would file half the
  // payload under a system it was not built for.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [
      { platform: 'linux-x86_64', system: 'drone' },
      { platform: 'linux-aarch64', system: 'gcs' },
    ],
  }));

  const error = result.errors.find((e) => e.rule === 'conflicting_systems');
  assert.ok(error, 'must not be a warning: there is no correct system to record');
  assert.match(error.message, /drone, gcs/);
});

test('a case-only difference is called out, because the node compares exactly', async () => {
  // Taken from a real build: the core stamped "HERA" and a plugin stamped ["Hera","HeraHub"].
  // system_covers() compares with == on std::string, so the node skips the plugin on every
  // HERA device — silently, as a non-fatal skip. On the page the two words look identical.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{
      platform: 'linux-x86_64',
      system: 'HERA',
      plugins: [{ name: 'Example_Publisher_Plugin', version: '0.1.0', system: ['Hera', 'HeraHub'] }],
    }],
  }));

  const message = messageFor(result.warnings, 'plugin_slice_system_mismatch');
  assert.match(message, /differ only in case/);
  assert.match(message, /compares exactly/);
});

test('a genuinely different system says nothing about case', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
    plugins: [{ name: 'Camera', platform: 'linux-x86_64', system: ['drone'] }],
  }));

  const message = messageFor(result.warnings, 'plugin_slice_system_mismatch');
  assert.doesNotMatch(message, /case/, 'drone and HERA are not a typo');
});

test('a plugin disagreeing with the core is a warning, not a refusal', async () => {
  // It was an error while a plugin could set the bundle's system, because then the two really
  // did conflict. Now the core alone decides, so there is nothing ambiguous to refuse.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', system: 'HERA' }],
    plugins: [{ name: 'Camera', platform: 'linux-x86_64', system: 'drone' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'HERA');
  assert.ok(rules(result.warnings).includes('plugin_slice_system_mismatch'));
});

test('every slice naming the same system is not a conflict', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [
      { platform: 'linux-x86_64', system: 'HERA' },
      { platform: 'linux-aarch64', system: 'HERA' },
    ],
    plugins: [{ name: 'Camera', platform: 'linux-x86_64', system: 'HERA' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'HERA');
  assert.deepEqual(result.declaredSystems, ['HERA'], 'recorded once, not once per slice');
});

test('a legacy runtime package carries the system too', async () => {
  const result = await inspect(legacyBundle({ version: '0.15.0', system: 'HERA' }));

  assert.equal(result.format, 'legacy');
  assert.equal(result.release.system, 'HERA');
});

test('a legacy package with both plugins and a system still inspects', async () => {
  // Both at once is the combination that reaches the bundled-plugin check while a system is
  // in play; either alone skips it.
  const result = await inspect(legacyBundle({
    version: '0.15.0', system: 'HERA', plugins: ['Camera'],
  }));

  assert.equal(result.release.system, 'HERA');
  assert.match(messageFor(result.warnings, 'legacy_format'), /1 plugin\(s\) inside it/);
});

test('a plugin inside a core slice built for another system is flagged', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{
      platform: 'linux-x86_64',
      system: 'HERA',
      plugins: [{ name: 'Camera', version: '2.0.0', system: 'drone' }],
    }],
  }));

  // A warning, not an error: the core is unambiguous, so there is a system to record. What is
  // in doubt is whether that one plugin came off the same build.
  assert.deepEqual(result.errors, []);
  const warning = result.warnings.find((w) => w.rule === 'plugin_slice_system_mismatch');
  assert.ok(warning);
  assert.match(warning.message, /Camera/);
  assert.match(warning.message, /drone/);
});

test('a plugin inside a core slice agreeing on the system is silent', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{
      platform: 'linux-x86_64',
      system: 'HERA',
      plugins: [{ name: 'Camera', version: '2.0.0', system: 'HERA' }],
    }],
  }));

  assert.ok(!result.warnings.some((w) => w.rule === 'plugin_slice_system_mismatch'));
  assert.equal(result.release.system, 'HERA');
});

test('a blank or non-string slice system is ignored', async () => {
  for (const value of ['   ', 42, null]) {
    const result = await inspect(bundle({
      version: '0.15.0', cores: [{ platform: 'linux-x86_64', system: value }],
    }));
    assert.deepEqual(result.errors, [], `system ${JSON.stringify(value)} must not block`);
    assert.equal(result.release.system, null);
  }
});

test('a broken release.json warns and leaves the metadata empty', async () => {
  const unparseable = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }], release: 'not json',
  }));
  assert.deepEqual(unparseable.errors, []);
  assert.ok(rules(unparseable.warnings).includes('release_json_unreadable'));

  const badMin = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { min_version: 'not-a-version', notes: 'kept' },
  }));
  assert.deepEqual(badMin.errors, []);
  assert.ok(rules(badMin.warnings).includes('release_json_min_version_invalid'));
  assert.equal(badMin.release.minVersion, null);
  assert.equal(badMin.release.notes, 'kept', 'one bad field must not discard the rest');
});

test('config params are read out of the slim payload, not typed in', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    configs: [
      { target: 'core', values: { web: { port: 9090 } } },
      { target: 'Camera_Argus_Plugin', values: { general: { fps: 60, tick_ms: 500 } } },
    ],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.configs.map((c) => [c.target, c.params]), [
    ['core', [{ param: 'web.port', value: 9090 }]],
    ['Camera_Argus_Plugin', [
      { param: 'general.fps', value: 60 },
      { param: 'general.tick_ms', value: 500 },
    ]],
  ]);
});

test('flattenConfigPayload handles the flat form and non-scalar values', () => {
  // The node accepts both {"group":{"param":v}} and a flat {"param":v}.
  assert.deepEqual(flattenConfigPayload({ port: 8080 }), [{ param: 'port', value: 8080 }]);

  // An array is a value, not a level to descend into.
  assert.deepEqual(flattenConfigPayload({ net: { peers: ['a', 'b'] } }),
    [{ param: 'net.peers', value: ['a', 'b'] }]);

  assert.deepEqual(flattenConfigPayload({ a: { b: { c: true } } }),
    [{ param: 'a.b.c', value: true }]);

  assert.deepEqual(flattenConfigPayload({}), []);
  assert.deepEqual(flattenConfigPayload(null), []);
});

test('an unreadable config payload warns but does not refuse the bundle', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    configs: [{ target: 'core', body: 'not json' }],
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(rules(result.warnings).includes('config_payload_unreadable'));
  assert.deepEqual(result.configs[0].params, []);
});

// ── plugins that ride inside the core ─────────────────────────────────────────────────────

test('plugins shipped inside a core slice are named, not just counted', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', plugins: ['Example_Plugin/libExample_Plugin.so'] }],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cores[0].bundledPlugins,
    [{ name: 'Example_Plugin', version: null, versionKnown: false,
      declaredName: null, declaredPlatform: null, declaredSystems: [] }]);

});

test('a legacy package also reports the plugins inside its core', async () => {
  // This is the case an operator hits when they upload a runtime tarball: the package really
  // does contain a plugin, and saying nothing about it hides that it overwrites the node's.
  const result = await inspect(legacyBundle({
    version: '0.13.3', platform: 'linux-x86_64', plugins: ['Example_Plugin'],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cores[0].bundledPlugins,
    [{ name: 'Example_Plugin', version: null, versionKnown: false,
      declaredName: null, declaredPlatform: null, declaredSystems: [] }]);
  // One finding, not two: the plugin count rides in the legacy message.
  assert.equal(rules(result.warnings).filter((r) => r === 'legacy_format').length, 1);
  assert.match(messageFor(result.warnings, 'legacy_format'), /1 plugin\(s\) inside it/);
  assert.match(messageFor(result.warnings, 'legacy_format'),
    /no plugin or config components/);
});

test('a core with no plugins reports an empty list, not a warning', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }],
  }));

  assert.deepEqual(result.cores[0].bundledPlugins, []);
  assert.deepEqual(result.warnings, []);
});

test('the directory listing is the fallback when the manifest does not list dlls', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{
      platform: 'linux-x86_64',
      plugins: ['Silent_Plugin/libSilent_Plugin.so'],
      // A slice manifest with no plugins block at all.
      manifest: JSON.stringify({
        package: 'AeroCoreEngine', version: '0.15.0', platform: 'linux-x86_64',
      }),
    }],
  }));

  assert.deepEqual(result.cores[0].bundledPlugins,
    [{ name: 'Silent_Plugin', version: null, versionKnown: false,
      declaredName: null, declaredPlatform: null, declaredSystems: [] }]);
});

test('release.json can acknowledge a param the release deliberately stops setting', async () => {
  // Config payloads are meant to be cumulative, so an omission is normally a mistake. This is
  // how an operator says it was not.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { config_dropped: ['core.web.port', 'Cam.general.fps'] },
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.release.configDropped, ['core.web.port', 'Cam.general.fps']);
});

test('a non-array config_dropped is ignored rather than trusted', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { config_dropped: 'core.web.port' },
  }));

  assert.deepEqual(result.release.configDropped, []);
});

// ── which kind of device this bundle is for ───────────────────────────────────────────────

test('release.json declares the system a bundle belongs to', async () => {
  // The node cannot tell the server what kind of device it is — its update client sends no
  // such field — so the bundle declaring it is what makes systems work at all.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'android-aarch64' }],
    release: { system: 'drone' },
  }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.release.system, 'drone');
});

test('a bundle naming no system leaves it null for the server to default', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }],
  }));
  assert.equal(result.release.system, null);
});

test('a blank or non-string system is ignored, not trusted', async () => {
  for (const value of ['', '   ', 42, null, {}]) {
    const result = await inspect(bundle({
      version: '0.15.0',
      cores: [{ platform: 'linux-x86_64' }],
      release: { system: value },
    }));
    assert.equal(result.release.system, null, `system: ${JSON.stringify(value)}`);
  }
});

test('a system name is trimmed', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    release: { system: '  gcs  ' },
  }));
  assert.equal(result.release.system, 'gcs');
});

// ── config the core slice ships in its own config/ directory ──────────────────────────────

/** A runtime slice's fat config, the shape build_dist_linux.sh produces. */
const fatConfig = (params) => JSON.stringify(Object.fromEntries(
  Object.entries(params).map(([group, entries]) => [group, {
    type: 'group',
    params: Object.fromEntries(Object.entries(entries).map(([key, value]) => [
      key,
      typeof value === 'object' && value !== null && 'value' in value
        ? { type: 'string', ...value }
        : { type: 'string', value, locked: false, readonly: false },
    ])),
  }]),
));

test('config shipped inside a core slice is read and reported', async () => {
  // This is the case an operator hits uploading a runtime tarball: the package really does
  // carry config, and saying "no config" hides that it overwrites the node's.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({ web: { port: 8080 }, update: { server_url: 'https://ota.example' } }),
    }],
  }));

  assert.deepEqual(result.cores[0].shippedConfig, [{
    file: 'config/core.json',
    plugin: null,
    params: [
      { param: 'web.port', value: 8080, locked: false, readonly: false },
      { param: 'update.server_url', value: 'https://ota.example', locked: false, readonly: false },
    ],
  }]);
  assert.ok(rules(result.warnings).includes('core_ships_config'));
});

test('a shipped config that could cut nodes off is warned about, not refused', async () => {
  // AeroCore protects these on the node — but only where the param is LOCKED. reconcile_param
  // keeps the live value for a frozen param and the package value for every other, so the
  // protection is exactly as good as the provisioning that locked them. Reporting it without
  // blocking leaves that judgement with the operator.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({ update: { enabled: false, server_url: '', api_key: '' } }),
    }],
  }));

  assert.deepEqual(result.errors, [], 'the node blocks this itself where the param is locked');
  assert.ok(rules(result.warnings).includes('core_config_lifeline_unlocked'));

  const message = messageFor(result.warnings, 'core_config_lifeline_unlocked');
  assert.match(message, /update\.enabled=false/);
  assert.match(message, /update\.server_url=""/);
  assert.match(message, /unlocked/, 'the condition, not just the symptom');
  assert.match(message, /Lock them in the build/, 'the fix, and it is not "ship less config"');

  // One finding for all three params, not one each: the same upload would otherwise produce
  // the same wall of text every time and train the operator to skip it.
  assert.equal(rules(result.warnings).filter((r) => r.startsWith('core_config')).length, 1);
});

test('shipping update.channel unlocked is flagged, whatever its value', async () => {
  // Not about the value: it is that shipping it unlocked overwrites a choice the operator made
  // on the device. A machine moved to `beta` for testing is put back on `stable` by the first
  // beta build it installs, so the test cohort dissolves exactly when the test begins.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({ update: { channel: 'stable' } }),
    }],
  }));

  assert.deepEqual(result.errors, []);
  const message = messageFor(result.warnings, 'core_config_lifeline_unlocked');
  assert.match(message, /update\.channel="stable"/);

  // Folded into the finding that already exists — no extra line on a screen that has to stay
  // short enough to read.
  assert.equal(rules(result.warnings).filter((r) => r.startsWith('core_config')).length, 1);
});

test('update.channel shipped locked is not the unlocked hazard', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({
        update: { channel: { value: 'stable', locked: true, readonly: false } },
      }),
    }],
  }));

  assert.ok(!rules(result.warnings).includes('core_config_lifeline_unlocked'));
});

test('lifeline params shipped locked get a milder finding', async () => {
  // reconcile_param takes the lock state from the LIVE config, so a locked param in the
  // package protects a fresh node and a newly added param — not one the device already has
  // unlocked. That is a real difference in risk, and the wording has to carry it.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({
        update: {
          enabled: { value: false, locked: true, readonly: false },
          server_url: { value: '', locked: true, readonly: false },
        },
      }),
    }],
  }));

  assert.deepEqual(result.errors, []);
  assert.ok(rules(result.warnings).includes('core_config_lifeline_locked'));
  assert.ok(!rules(result.warnings).includes('core_config_lifeline_unlocked'));
  assert.match(messageFor(result.warnings, 'core_config_lifeline_locked'),
    /provisioned without those locks/);
});

test('readonly counts as frozen, the same way the node counts it', async () => {
  // is_frozen_param() is `locked || readonly`; treating readonly as unlocked would report a
  // hazard the node does not have.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({
        update: { server_url: { value: '', locked: false, readonly: true } },
      }),
    }],
  }));

  assert.ok(!rules(result.warnings).includes('core_config_lifeline_unlocked'));
});

test('REFUSE_CONFIG_LIFELINE turns that warning back into a refusal', async () => {
  // For a fleet whose provisioning does not reliably lock those params, the node's protection
  // does not apply and the mistake is unrecoverable.
  const gz = bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({ update: { server_url: '' } }),
    }],
  });

  const scan = await readTar(Readable.from([zlib.gunzipSync(gz)]), { select: isInspectableMember });
  const json = new Map(); const unparseable = new Set(); const sizes = new Map();
  for (const [name, body] of scan.files) {
    sizes.set(name, body.length);
    try { json.set(name, JSON.parse(body.toString('utf8'))); } catch { unparseable.add(name); }
  }

  const result = inspectBundle({
    names: scan.names, json, unparseable, sizes, refuseConfigLifeline: true,
  });

  assert.ok(rules(result.errors).includes('core_config_lifeline_unlocked'));
});

test('a shipped config with a real server URL is not refused', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({ update: { enabled: true, server_url: 'https://ota.example' } }),
    }],
  }));

  assert.deepEqual(result.errors, [], 'only blank or disabled values are the hazard');
  assert.ok(rules(result.warnings).includes('core_ships_config'));
});

test('blanking the serial and shipping a role are warnings, not refusals', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({ link: { serial: '', role: 'GCS' } }),
    }],
  }));

  assert.deepEqual(result.errors, []);

  // Both hazards, one line. Separately they were two more warnings on a screen that already
  // had four, all of them present on every single build.
  const message = messageFor(result.warnings, 'core_config_lifeline_unlocked');
  assert.match(message, /link\.serial=""/);
  assert.match(message, /link\.role="GCS"/);
  assert.equal(rules(result.warnings).filter((r) => r.startsWith('core_config')).length, 1);
});

test('a -NoConfig core ships nothing and produces no config finding', async () => {
  const result = await inspect(bundle({
    version: '0.15.0', cores: [{ platform: 'linux-x86_64' }],
  }));

  assert.deepEqual(result.cores[0].shippedConfig, []);
  assert.deepEqual(result.warnings, []);
});

test('a plugin ships its own config, and it is listed too', async () => {
  // apply_plugin wipes the plugin folder and reconciles its config the same way the core does
  // (PackageApply.cpp:547), so a plugin's config/ overwrites unlocked params exactly as the
  // core's does. Listing only the core's would hide half the risk.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    plugins: [{ name: 'AeroTunnel_Plugin', platform: 'linux-x86_64', version: '1.0.0' }],
    extraFiles: [{
      name: 'plugins/AeroTunnel_Plugin/linux-x86_64/config/AeroTunnel_Plugin.json',
      body: fatConfig({ network: { host: '127.0.0.1', http_port: 8080 } }),
    }],
  }));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.plugins[0].shippedConfig, [{
    file: 'config/AeroTunnel_Plugin.json',
    plugin: null,
    params: [
      { param: 'network.host', value: '127.0.0.1', locked: false, readonly: false },
      { param: 'network.http_port', value: 8080, locked: false, readonly: false },
    ],
  }]);

  const message = messageFor(result.warnings, 'plugin_ships_config');
  assert.match(message, /AeroTunnel_Plugin for linux-x86_64/);
  assert.match(message, /replaces every param the node has not locked/,
    'must state what apply_plugin actually does, which is the same reconcile the core gets');
  assert.doesNotMatch(message, /-NoConfig/, 'never advise shipping less config');
});

test('a plugin built with -NoConfig reports nothing and warns about nothing', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    plugins: [{ name: 'Quiet_Plugin', platform: 'linux-x86_64', version: '1.0.0' }],
  }));

  assert.deepEqual(result.plugins[0].shippedConfig, []);
  assert.deepEqual(result.warnings, []);
});

test('a locked param is marked, because it is the one the package cannot overwrite', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: fatConfig({
        update: {
          server_url: { value: 'https://ota.example', locked: true },
          channel: { value: 'stable', readonly: true },
          api_key: { value: 'k', locked: false },
        },
      }),
    }],
  }));

  assert.deepEqual(
    result.cores[0].shippedConfig[0].params.map((p) => [p.param, p.locked, p.readonly]),
    [
      ['update.server_url', true, false],
      ['update.channel', false, true],
      ['update.api_key', false, false],
    ],
  );
});

test('config of a plugin that rides inside the core is found and attributed', async () => {
  // A runtime slice built from a full dist directory carries its plugins, each with its own
  // config/. Scanning only the slice's top-level config/ misses them entirely — and a core
  // update replaces them just the same.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [
      {
        name: 'core/linux-x86_64/config/core.json',
        body: fatConfig({ web: { port: 8080 } }),
      },
      {
        name: 'core/linux-x86_64/plugins/AeroTunnel_Plugin/config/AeroTunnel_Plugin.json',
        body: fatConfig({ network: { host: '127.0.0.1' } }),
      },
    ],
  }));

  const shipped = result.cores[0].shippedConfig;
  assert.deepEqual(shipped.map((f) => [f.plugin, f.file]), [
    [null, 'config/core.json'],
    ['AeroTunnel_Plugin', 'plugins/AeroTunnel_Plugin/config/AeroTunnel_Plugin.json'],
  ]);

  assert.match(messageFor(result.warnings, 'core_ships_config'), /AeroTunnel_Plugin/,
    'the warning must name which plugin config rides along');
});

test('a shipped file carrying no params is still listed, not dropped', async () => {
  // ota_keys.json is the trusted signing-key map. It has no params, but it is replaced with
  // the rest of config/ — dropping it from the report would hide that entirely.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/ota_keys.json',
      body: JSON.stringify({ 'rtr-ota-2026': 'AAAA' }),
    }],
  }));

  assert.deepEqual(result.cores[0].shippedConfig, [
    { file: 'config/ota_keys.json', plugin: null, params: [] },
  ]);
});

test('a bundled plugin with its own manifest reports its version', async () => {
  // The build is moving to writing a manifest.json into every plugin folder; when it is there,
  // the version is read rather than left blank.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{
      platform: 'linux-x86_64',
      plugins: [
        { name: 'SRTunnel_Plugin', version: '1.3.0' },
        { name: 'Camera_Argus_Plugin', version: '2.1.0' },
      ],
    }],
  }));

  assert.deepEqual(result.cores[0].bundledPlugins, [
    {
      name: 'Camera_Argus_Plugin', version: '2.1.0', versionKnown: true,
      declaredName: 'Camera_Argus_Plugin', declaredPlatform: 'linux-x86_64', declaredSystems: [],
    },
    {
      name: 'SRTunnel_Plugin', version: '1.3.0', versionKnown: true,
      declaredName: 'SRTunnel_Plugin', declaredPlatform: 'linux-x86_64', declaredSystems: [],
    },
  ]);
});

test('a bundled plugin without a manifest is listed with no version, never guessed', async () => {
  // Older runtime builds copy only the shared library. A wrong version in the plan is worse
  // than a missing one, so nothing is inferred.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', plugins: [{ name: 'Old_Plugin', version: null }] }],
  }));

  assert.deepEqual(result.cores[0].bundledPlugins,
    [{
      name: 'Old_Plugin', version: null, versionKnown: false,
      declaredName: null, declaredPlatform: null, declaredSystems: [],
    }]);
});

test('a bundled plugin reporting "unknown" is flagged, not treated as a version', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', plugins: [{ name: 'Odd_Plugin', version: 'unknown' }] }],
  }));

  assert.deepEqual(result.cores[0].bundledPlugins,
    [{
      name: 'Odd_Plugin', version: 'unknown', versionKnown: false,
      declaredName: 'Odd_Plugin', declaredPlatform: 'linux-x86_64', declaredSystems: [],
    }]);
});

test('many bundled plugins are all listed, not truncated', async () => {
  // The old display joined them into one table cell, which stopped being readable well before
  // a real runtime slice's plugin count.
  const many = Array.from({ length: 14 }, (_, i) => ({
    name: `Plugin_${String(i).padStart(2, '0')}`, version: `1.${i}.0`,
  }));

  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64', plugins: many }],
  }));

  assert.equal(result.cores[0].bundledPlugins.length, 14);
  assert.deepEqual(result.cores[0].bundledPlugins.map((p) => p.version).sort(),
    many.map((p) => p.version).sort());
});

test('a bundled manifest naming the wrong plugin is flagged', async () => {
  // A copy-pasted manifest in the right folder is otherwise invisible, and the folder name is
  // what the node actually loads.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [
      { name: 'core/linux-x86_64/plugins/Real_Plugin/libReal_Plugin.so', body: 'so' },
      {
        name: 'core/linux-x86_64/plugins/Real_Plugin/manifest.json',
        body: JSON.stringify({
          plugin: 'Copied_From_Elsewhere', version: '1.0.0', platform: 'linux-x86_64',
        }),
      },
    ],
  }));

  assert.deepEqual(result.errors, []);
  const message = messageFor(result.warnings, 'plugin_slice_name_mismatch');
  assert.match(message, /Copied_From_Elsewhere/);
  assert.match(message, /folder name is what the node loads/);
});

test('a bundled manifest naming the wrong platform is flagged', async () => {
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [
      { name: 'core/linux-x86_64/plugins/P/libP.so', body: 'so' },
      {
        name: 'core/linux-x86_64/plugins/P/manifest.json',
        body: JSON.stringify({ plugin: 'P', version: '1.0.0', platform: 'android-aarch64' }),
      },
    ],
  }));

  assert.ok(rules(result.warnings).includes('plugin_slice_platform_mismatch'));
});

test('a Windows manifest saying bare "windows" agrees with a windows-x86_64 core', async () => {
  // That is what the Windows packaging script actually writes.
  const result = await inspect(bundle({
    version: '0.15.0',
    cores: [{ platform: 'windows-x86_64' }],
    extraFiles: [
      { name: 'core/windows-x86_64/plugins/P/P.dll', body: 'dll' },
      {
        name: 'core/windows-x86_64/plugins/P/manifest.json',
        body: JSON.stringify({ plugin: 'P', version: '1.0.0', platform: 'windows' }),
      },
    ],
  }));

  assert.ok(!rules(result.warnings).includes('plugin_slice_platform_mismatch'));
});
