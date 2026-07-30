import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDiff, isNoOp } from '../src/services/diff.service.js';

/** Shape an artifact the way catalog.repository.hydrate() does. */
function artifact({ version, kind = 'fleet', platform = null, platforms, plugins = {}, config = {} }) {
  return {
    version,
    kind,
    platform,
    platforms,
    plugins: new Map(Object.entries(plugins).map(([p, entries]) => [
      p,
      new Map(Object.entries(entries).map(([name, value]) => [
        name,
        typeof value === 'string' ? { version: value, known: true } : value,
      ])),
    ])),
    config: new Map(Object.entries(config)),
  };
}

const find = (list, predicate) => list.find(predicate);

test('a plugin whose version rises is reported as an upgrade', () => {
  const diff = computeDiff(
    artifact({
      version: '0.14.0',
      platforms: ['linux-x86_64'],
      plugins: { 'linux-x86_64': { SRTunnel_Plugin: '1.2.0' } },
    }),
    artifact({
      version: '0.15.0',
      platforms: ['linux-x86_64'],
      plugins: { 'linux-x86_64': { SRTunnel_Plugin: '1.3.0' } },
    }),
  );

  assert.deepEqual(diff.plugins, [{
    platform: 'linux-x86_64',
    name: 'SRTunnel_Plugin',
    change: 'upgraded',
    from: '1.2.0',
    to: '1.3.0',
    ordered: true,
  }]);
});

test('version ordering uses numbers, so 1.9.0 -> 1.10.0 is an upgrade', () => {
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '1.9.0' } } }),
    artifact({ version: '0.15.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '1.10.0' } } }),
  );

  assert.equal(diff.plugins[0].change, 'upgraded', 'a string compare would call this a downgrade');
});

test('a plugin that goes backwards is flagged as a downgrade', () => {
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '2.0.0' } } }),
    artifact({ version: '0.15.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '1.9.0' } } }),
  );

  assert.equal(diff.plugins[0].change, 'downgraded');
});

test('an unorderable version is "changed", never compared', () => {
  // isNewer('unknown', x) throws; the diff must report the difference without ordering it.
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '1.0.0' } } }),
    artifact({
      version: '0.15.0',
      platforms: ['linux-x86_64'],
      plugins: { 'linux-x86_64': { P: { version: 'unknown', known: false } } },
    }),
  );

  assert.equal(diff.plugins[0].change, 'changed');
  assert.equal(diff.plugins[0].ordered, false);
});

test('added and removed plugins are both reported', () => {
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { Old: '1.0.0' } } }),
    artifact({ version: '0.15.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { New: '2.0.0' } } }),
  );

  assert.equal(find(diff.plugins, (p) => p.name === 'New').change, 'added');
  assert.equal(find(diff.plugins, (p) => p.name === 'Old').change, 'removed');
});

test('an unchanged plugin is kept in the list, because "does not move" is the point', () => {
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '1.0.0' } } }),
    artifact({ version: '0.15.0', platforms: ['linux-x86_64'], plugins: { 'linux-x86_64': { P: '1.0.0' } } }),
  );

  assert.equal(diff.plugins[0].change, 'unchanged');
});

test('platform additions and removals are reported', () => {
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64', 'macos-aarch64'] }),
    artifact({ version: '0.15.0', platforms: ['linux-x86_64', 'android-aarch64'] }),
  );

  assert.deepEqual(diff.platforms, { added: ['android-aarch64'], removed: ['macos-aarch64'] });
});

test('cores move from the previous release version, and a new platform has no from', () => {
  const diff = computeDiff(
    artifact({ version: '0.14.0', platforms: ['linux-x86_64'] }),
    artifact({ version: '0.15.0', platforms: ['linux-x86_64', 'android-aarch64'] }),
  );

  assert.deepEqual(diff.cores, [
    { platform: 'android-aarch64', from: null, to: '0.15.0', change: 'added' },
    { platform: 'linux-x86_64', from: '0.14.0', to: '0.15.0', change: 'updated' },
  ]);
});

test('config params are compared by value, including non-scalars', () => {
  const diff = computeDiff(
    artifact({
      version: '0.14.0',
      platforms: ['linux-x86_64'],
      config: {
        'linux-x86_64': [
          { target: 'core', param: 'web.port', to: 8080 },
          { target: 'core', param: 'gone', to: 1 },
          { target: 'core', param: 'net.peers', to: ['a'] },
        ],
      },
    }),
    artifact({
      version: '0.15.0',
      platforms: ['linux-x86_64'],
      config: {
        'linux-x86_64': [
          { target: 'core', param: 'web.port', to: 9090 },
          { target: 'core', param: 'fresh', to: true },
          { target: 'core', param: 'net.peers', to: ['a'] },
        ],
      },
    }),
  );

  const by = (param) => find(diff.config, (c) => c.param === param);
  assert.equal(by('web.port').change, 'changed');
  assert.deepEqual([by('web.port').from, by('web.port').to], [8080, 9090]);
  assert.equal(by('gone').change, 'removed');
  assert.equal(by('fresh').change, 'added');
  assert.equal(by('net.peers').change, 'unchanged', 'arrays compare by value');
});

test('a plugin name containing a space does not corrupt the config key', () => {
  const diff = computeDiff(
    artifact({
      version: '0.14.0',
      platforms: ['linux-x86_64'],
      config: { 'linux-x86_64': [{ target: 'My Plugin', param: 'a.b', to: 1 }] },
    }),
    artifact({
      version: '0.15.0',
      platforms: ['linux-x86_64'],
      config: { 'linux-x86_64': [{ target: 'My Plugin', param: 'a.b', to: 2 }] },
    }),
  );

  assert.deepEqual(
    [diff.config[0].target, diff.config[0].param, diff.config[0].change],
    ['My Plugin', 'a.b', 'changed'],
  );
});

test('a release that ships a core is never a no-op', () => {
  const diff = {
    isFirst: false,
    cores: [{ platform: 'linux-x86_64', from: '0.14.0', to: '0.15.0', change: 'updated' }],
    plugins: [], config: [],
  };
  assert.equal(isNoOp(diff), false);
});

test('a plugin-only bundle where nothing moves is a no-op', () => {
  // This is the case worth catching: every node downloads it and reports skipped/same_version.
  const diff = {
    isFirst: false,
    cores: [],
    plugins: [{ name: 'P', platform: 'linux-x86_64', change: 'unchanged' }],
    config: [{ target: 'core', param: 'web.port', change: 'unchanged' }],
  };
  assert.equal(isNoOp(diff), true);
});

test('a first release is not reported as a no-op', () => {
  assert.equal(isNoOp({ isFirst: true, cores: [], plugins: [], config: [] }), false);
});
