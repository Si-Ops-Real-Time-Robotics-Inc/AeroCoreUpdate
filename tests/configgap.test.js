import test from 'node:test';
import assert from 'node:assert/strict';


/**
 * A bundle carries only its own release's config payload, so a node that jumps several
 * versions never receives what the releases it skipped would have set — and it reports
 * success either way. These tests pin the detection down.
 */

const artifact = ({ platforms, config = {} }) => ({
  platforms,
  plugins: new Map(),
  config: new Map(Object.entries(config)),
});

const node = (over = {}) => ({
  serial: 'SN-1',
  platform: 'linux-x86_64',
  version: '0.13.0',
  role: 'GCS',
  plugins: null,
  lockedParams: new Set(),
  params: null,
  ...over,
});

test('offeredConfigFrom spreads a config component across every platform it covers', async () => {
  const { offeredConfigFrom } = await import('../src/services/configGap.service.js');

  // A config component is platform-independent: the node applies it whatever platform it is.
  const map = offeredConfigFrom(
    {
      configs: [
        { target: 'core', params: [{ param: 'web.port', value: 9090 }] },
        { target: 'Cam', params: [{ param: 'general.fps', value: 60 }] },
      ],
    },
    ['linux-x86_64', 'android-aarch64'],
  );

  assert.deepEqual([...map.keys()].sort(), ['android-aarch64', 'linux-x86_64']);
  assert.deepEqual(map.get('linux-x86_64'), [
    { target: 'core', param: 'web.port', to: 9090 },
    { target: 'Cam', param: 'general.fps', to: 60 },
  ]);
});

test('a bundle with no config components produces an empty map', async () => {
  const { offeredConfigFrom } = await import('../src/services/configGap.service.js');
  assert.equal(offeredConfigFrom({ configs: [] }, ['linux-x86_64']).size, 0);
});

// ── the two config mechanisms must not be confused ────────────────────────────────────────

test('the shipped-config warning states the mechanism without telling anyone to ship less', async () => {
  // The two paths behave completely differently on the node:
  //   config COMPONENT -> merge_slim_values: writes only the params its payload names, skips
  //                       locked ones
  //   core's config/   -> reconcile_config: package is the base, EVERY unlocked param on the
  //                       node takes the package value
  //
  // The policy here is that every build ships config and the params that matter are locked
  // from the start. So the warning's job is to state what a slice's config/ does — never to
  // suggest -NoConfig, which reads as "do not push config" and is the opposite of the policy.
  const { readTar } = await import('../src/core/tar.js');
  const { inspectBundle, isInspectableMember } = await import('../src/domain/bundle.js');
  const { bundle } = await import('./helpers/bundles.js');
  const zlib = await import('node:zlib');
  const { Readable } = await import('node:stream');

  const gz = bundle({
    version: '0.15.0',
    cores: [{ platform: 'linux-x86_64' }],
    extraFiles: [{
      name: 'core/linux-x86_64/config/core.json',
      body: JSON.stringify({
        web: { type: 'group', params: { port: { type: 'number', value: 8080 } } },
      }),
    }],
  });

  const scan = await readTar(Readable.from([zlib.gunzipSync(gz)]), { select: isInspectableMember });
  const json = new Map(); const unparseable = new Set(); const sizes = new Map();
  for (const [name, body] of scan.files) {
    sizes.set(name, body.length);
    try { json.set(name, JSON.parse(body.toString('utf8'))); } catch { unparseable.add(name); }
  }
  const result = inspectBundle({ names: scan.names, json, unparseable, sizes });

  const message = result.warnings.find((w) => w.rule === 'core_ships_config')?.message ?? '';
  assert.match(message, /replaces every param the node has not locked/,
    'must state what actually happens on the device');
  assert.match(message, /not just the ones you name/,
    'the difference from a config component, which is the whole point');
  assert.doesNotMatch(message, /-NoConfig/,
    'never advise shipping less config: the policy is that every build ships it');
});
