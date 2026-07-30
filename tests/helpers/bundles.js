import { tar, targz } from './targz.js';

/**
 * Fixtures shaped like what package_update_bundle.sh actually produces, including the
 * ./.components build leftover that every real bundle carries.
 *
 * Every knob here exists to reproduce a specific failure the node tolerates silently — above
 * all `cores[].version`, which is how you build the stale-slice bundle that reports
 * same_version on the whole fleet.
 */

/**
 * @param {object} spec
 * @param {string}  spec.version
 * @param {Array<{platform: string, version?: string, bin?: boolean, plugins?: string[],
 *                manifest?: string, system?: string}>} [spec.cores]
 * @param {Array<{name: string, platform: string, version?: string|null,
 *                manifest?: string, system?: string}>} [spec.plugins]
 * @param {Array<{target: string, file?: string, body?: string, values?: object}>} [spec.configs]
 * @param {object|string} [spec.release]  the optional release.json at the archive root
 * @param {Array<{name: string, body: string}>} [spec.extraFiles]  arbitrary extra members
 * @param {(manifest: object) => object} [spec.patch]  mutate the manifest before serialising
 * @param {Buffer} [spec.filler]  incompressible padding, to hit a target .tar.gz size
 * @param {boolean} [spec.omitComponents]  drop the components array entirely
 * @returns {Buffer} .tar.gz bytes
 */
export function bundle(spec) {
  const {
    version, cores = [], plugins = [], configs = [], patch, filler, omitComponents = false,
    release, extraFiles = [],
  } = spec;

  const entries = [];
  const components = [];
  const componentLines = [];

  const core = { type: 'core', variants: [] };

  for (const item of cores) {
    const dir = `core/${item.platform}`;
    core.variants.push({ platform: item.platform, path: dir });
    componentLines.push(`core|${item.platform}|${dir}`);

    if (item.bin !== false) {
      const body = filler
        ? Buffer.concat([Buffer.from('ELF placeholder'), filler])
        : 'ELF placeholder';
      entries.push({ name: `${dir}/bin/AeroCoreEngine`, body });
    }
    // A plugin riding inside the core: `"Name/libName.so"` ships only the library, while
    // `{ name, version }` also writes the manifest.json the new build emits.
    const shipped = (item.plugins ?? []).map((entry) =>
      (typeof entry === 'string' ? { path: entry } : entry));

    for (const plugin of shipped) {
      if (plugin.path) {
        entries.push({ name: `${dir}/plugins/${plugin.path}`, body: 'so' });
        continue;
      }
      entries.push({ name: `${dir}/plugins/${plugin.name}/lib${plugin.name}.so`, body: 'so' });
      if (plugin.version !== null) {
        entries.push({
          name: `${dir}/plugins/${plugin.name}/manifest.json`,
          body: JSON.stringify({
            plugin: plugin.name,
            version: plugin.version ?? '1.0.0',
            platform: item.platform,
            ...(plugin.system === undefined ? {} : { system: plugin.system }),
          }),
        });
      }
    }

    entries.push({
      name: `${dir}/manifest.json`,
      body: item.manifest !== undefined ? item.manifest : JSON.stringify({
        package: 'AeroCoreEngine',
        version: item.version ?? version,
        platform: item.platform,
        // The build stamps the system into every slice; the server reads it from here.
        ...(item.system === undefined ? {} : { system: item.system }),
        build_type: 'Release',
        packaged_at_utc: '2026-07-28T00:00:00Z',
        app: { executable: 'bin/AeroCoreEngine' },
        plugins: {
          dll_count: shipped.length,
          dlls: shipped.map((plugin) => (plugin.path
            ? `plugins/${plugin.path}`
            : `plugins/${plugin.name}/lib${plugin.name}.so`)),
        },
        files: [],
      }),
    });
  }
  if (core.variants.length) components.push(core);

  const byName = new Map();
  for (const item of plugins) {
    const dir = `plugins/${item.name}/${item.platform}`;
    if (!byName.has(item.name)) {
      byName.set(item.name, { type: 'plugin', name: item.name, variants: [] });
    }
    byName.get(item.name).variants.push({ platform: item.platform, path: dir });
    componentLines.push(`plugin|${item.name}|${item.platform}|${dir}`);

    entries.push({ name: `${dir}/bin/lib${item.name}.so`, body: 'so' });

    if (item.manifest !== undefined) {
      if (item.manifest !== null) entries.push({ name: `${dir}/manifest.json`, body: item.manifest });
    } else {
      const slice = {
        plugin: item.name,
        platform: item.platform,
        ...(item.system === undefined ? {} : { system: item.system }),
        build_type: 'Release',
        packaged_at_utc: '2026-07-28T00:00:00Z',
        so_count: 1,
        files: [`bin/lib${item.name}.so`],
      };
      if (item.version !== null) slice.version = item.version ?? '1.0.0';
      entries.push({ name: `${dir}/manifest.json`, body: JSON.stringify(slice) });
    }
  }
  components.push(...byName.values());

  for (const item of configs) {
    const file = item.file ?? `${item.target}-values.json`;
    const path = `config/${file}`;
    components.push({ type: 'config', target: item.target, path });
    componentLines.push(`config|${item.target}|${path}`);
    const payload = item.body !== undefined
      ? item.body
      : JSON.stringify(item.values ?? { web: { port: 9090 } });
    entries.push({ name: path, body: payload });
  }

  let manifest = { package: 'AeroCoreUpdate', version, components };
  if (omitComponents) delete manifest.components;
  if (patch) manifest = patch(manifest);

  // Real bundles always carry this: the script writes it into the staging dir and never
  // deletes it before taring. Nothing may treat it as an error.
  entries.unshift({ name: '.components', body: `${componentLines.join('\n')}\n` });
  entries.unshift({ name: 'manifest.json', body: JSON.stringify(manifest, null, 2) });

  // Optional: the only release metadata the bundle manifest has no place for.
  if (release !== undefined) {
    entries.push({
      name: 'release.json',
      body: typeof release === 'string' ? release : JSON.stringify(release),
    });
  }

  entries.push(...extraFiles);

  return targz(entries);
}

/**
 * The legacy `tar -czf out <dir>` shape: one wrapper directory, no './' prefix, and a
 * runtime-slice manifest with no components array.
 */
export function legacyBundle({
  dir = 'runtime_Release', version = '0.15.0', platform = 'linux-x86_64', bin = true,
  plugins = [], manifest, system,
} = {}) {
  const entries = [{ name: `${dir}/`, type: '5', raw: true }];
  if (bin) entries.push({ name: `${dir}/bin/AeroCoreEngine`, body: 'ELF', raw: true });

  // A runtime slice built from a full dist directory carries its plugins, and records them in
  // plugins.dlls[].
  const dlls = plugins.map((name) => `plugins/${name}/lib${name}.so`);
  for (const dll of dlls) entries.push({ name: `${dir}/${dll}`, body: 'so', raw: true });

  entries.push({
    name: `${dir}/manifest.json`,
    raw: true,
    body: manifest !== undefined ? manifest : JSON.stringify({
      package: 'AeroCoreEngine',
      version,
      platform,
      ...(system === undefined ? {} : { system }),
      build_type: 'Release',
      app: { executable: 'bin/AeroCoreEngine' },
      plugins: { dll_count: dlls.length, dlls },
      files: [],
    }),
  });

  return targz(entries);
}

/** Raw (uncompressed) tar, for the not_gzip path. */
export { tar, targz };
