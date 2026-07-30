import { isValidVersion } from './version.js';
import { isAndroid, isValidPlatform } from './platform.js';

/**
 * What a valid AeroCore update bundle looks like. Pure: given a set of member names and
 * already-parsed manifests, decide what is wrong with it.
 *
 * Like the rest of domain/, this never imports core/errors.js and never throws for a
 * validation problem — it returns findings and lets the service decide the HTTP shape.
 *
 * The rules exist because the node tolerates almost everything silently. Its apply path sets
 * ok = true unconditionally and reports per-component skips with no top-level error, so a
 * malformed bundle reaches the whole fleet looking like a success. Publish time is the only
 * place these mistakes are cheap.
 */

export const BUNDLE_PACKAGE = 'AeroCoreUpdate';
export const CORE_PACKAGE = 'AeroCoreEngine';
export const UNKNOWN_VERSION = 'unknown';
export const PLACEHOLDER_VERSION = '0.0.0';

/**
 * Which members the tar reader should retain: every manifest, the optional release.json, and
 * the slim config payloads — everything the server needs so an operator types nothing.
 */
export function isInspectableMember(name) {
  return name === 'manifest.json'
    || name.endsWith('/manifest.json')
    || name === 'release.json'
    || name.endsWith('/release.json')
    || /(^|\/)config\/[^/]+\.json$/.test(name);
}

/** Kept for callers that only want manifests. */
export function isManifestMember(name) {
  return name === 'manifest.json' || name.endsWith('/manifest.json');
}

/**
 * Flatten a slim config payload into the dotted keys the node uses.
 *   {"web": {"port": 9090}}  ->  [{ param: 'web.port', value: 9090 }]
 *
 * The node accepts both {"group": {"param": v}} and a flat {"param": v}, and a param that
 * does not exist on the node is silently ignored — so this describes what the release intends
 * to set, which is exactly what the advisory plan is for.
 */
export function flattenConfigPayload(payload, prefix = '', depth = 0) {
  const out = [];
  if (depth > 4 || !payload || typeof payload !== 'object' || Array.isArray(payload)) return out;

  for (const [key, value] of Object.entries(payload)) {
    const param = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flattenConfigPayload(value, param, depth + 1));
    } else {
      out.push({ param, value });
    }
  }
  return out;
}

/**
 * @typedef {object} BundleIndex
 * @property {Set<string>} names        every member, './'-stripped, dirs keep a trailing '/'
 * @property {Map<string, unknown>} json  parsed manifests, keyed by member name
 * @property {Set<string>} unparseable  manifests that were present but not valid JSON
 * @property {Map<string, number>} sizes byte length of each retained manifest
 * @property {string[]} [oversize]      manifests too large to inspect
 */

/** @typedef {{rule: string, message: string}} Finding */

/**
 * @param {BundleIndex} index
 * @returns {{format, version, platforms, cores, plugins, configs, errors: Finding[], warnings: Finding[]}}
 */
export function inspectBundle(index) {
  const errors = [];
  const warnings = [];
  const result = {
    format: 'bundle',
    version: null,
    platforms: [],
    cores: [],
    plugins: [],
    configs: [],
    // Every system name any manifest in this bundle stamped. The build writes it into each
    // slice, so the bundle names its own kind of device without a separate file. An array
    // rather than a Set because this whole object is stored as JSONB — a Set serialises to {}.
    declaredSystems: [],
    // From an optional release.json at the archive root: the only release metadata the bundle
    // manifest cannot carry.
    release: {
      system: null, minVersion: null, mandatory: false, notes: null, configDropped: [],
    },
    errors,
    warnings,
  };

  for (const name of index.oversize ?? []) {
    warnings.push(finding('member_oversize_skipped',
      `${name} is too large to inspect; its contents were not checked.`));
  }

  const root = locateRoot(index, errors);
  if (!root) return result;

  const { prefix, manifestName } = root;

  if (index.unparseable.has(manifestName)) {
    errors.push(finding('manifest_not_json',
      `${manifestName} is not valid JSON (${index.sizes.get(manifestName) ?? 0} bytes).`));
    return result;
  }

  const manifest = index.json.get(manifestName);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push(finding('manifest_not_object', `${manifestName} must be a JSON object.`));
    return result;
  }

  readReleaseMetadata(index, prefix, result);

  return Array.isArray(manifest.components)
    ? inspectModern(index, manifest, prefix, manifestName, result)
    : inspectLegacy(index, manifest, prefix, manifestName, result);
}

/**
 * Optional release.json at the archive root. It carries the three things the bundle manifest
 * has no place for, so a pipeline can emit it once and nobody types release metadata again.
 * Absent is normal; malformed is a warning, never a reason to refuse a good bundle.
 */
function readReleaseMetadata(index, prefix, result) {
  const name = `${prefix}release.json`;

  if (index.unparseable.has(name)) {
    result.warnings.push(finding('release_json_unreadable',
      'release.json is not valid JSON; release metadata was left empty.'));
    return;
  }
  if (!index.json.has(name)) return;

  const meta = index.json.get(name);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    result.warnings.push(finding('release_json_unreadable',
      'release.json must be a JSON object; release metadata was left empty.'));
    return;
  }

  if (meta.min_version !== undefined && meta.min_version !== null) {
    if (isValidVersion(meta.min_version)) {
      result.release.minVersion = meta.min_version;
    } else {
      result.warnings.push(finding('release_json_min_version_invalid',
        `release.json min_version "${meta.min_version}" is not a dotted numeric version; `
        + 'it was ignored.'));
    }
  }

  // Which kind of device this bundle is for. The node cannot tell the server what it is —
  // its update client sends no such field — so the bundle declaring it is what makes systems
  // work at all.
  if (typeof meta.system === 'string' && meta.system.trim()) {
    result.release.system = meta.system.trim();
  }

  if (typeof meta.notes === 'string' && meta.notes) result.release.notes = meta.notes;
  if (meta.mandatory !== undefined) result.release.mandatory = Boolean(meta.mandatory);

  // Params this release deliberately stops setting, as "<target>.<param>". Config payloads are
  // meant to be cumulative, so dropping one is normally a mistake — this is how an operator
  // says it was not.
  if (Array.isArray(meta.config_dropped)) {
    result.release.configDropped = meta.config_dropped.filter((k) => typeof k === 'string');
  }
}

/**
 * The root manifest is at the archive root, or — matching the node's own descent — inside a
 * single top-level directory.
 */
function locateRoot(index, errors) {
  if (index.json.has('manifest.json') || index.unparseable.has('manifest.json')) {
    return { prefix: '', manifestName: 'manifest.json' };
  }

  const nested = [...new Set([...index.json.keys(), ...index.unparseable])]
    .filter((name) => name.split('/').length === 2 && name.endsWith('/manifest.json'));

  if (nested.length === 0) {
    errors.push(finding('no_manifest',
      'The bundle has no manifest.json at its root, and no single top-level directory '
      + 'containing one.'));
    return null;
  }
  if (nested.length > 1) {
    // The node picks the first directory in unspecified filesystem order, so such an archive
    // would behave differently on different machines.
    errors.push(finding('ambiguous_root',
      `No root manifest.json, and ${nested.length} top-level directories contain one `
      + `(${nested.sort().join(', ')}). The node picks one in unspecified filesystem order.`));
    return null;
  }

  return { prefix: `${nested[0].split('/')[0]}/`, manifestName: nested[0] };
}

// ── the modern bundle produced by package_update_bundle.sh ────────────────────────────────

function inspectModern(index, manifest, prefix, manifestName, result) {
  const { errors, warnings } = result;

  if (manifest.package !== BUNDLE_PACKAGE) {
    warnings.push(finding('core_slice_package_mismatch',
      `${manifestName} declares package "${manifest.package ?? '(none)'}"; expected `
      + `"${BUNDLE_PACKAGE}".`));
  }

  result.version = checkVersion(manifest.version, errors);

  const components = manifest.components;
  if (components.length === 0) {
    errors.push(finding('no_components',
      `${manifestName} declares no components; there is nothing to install.`));
    return result;
  }

  const coreIndex = components.findIndex((c) => c && c.type === 'core');
  const platforms = new Set();

  components.forEach((component, i) => {
    if (!component || typeof component !== 'object') {
      errors.push(finding('component_not_object', `components[${i}] is not an object.`));
      return;
    }

    switch (component.type) {
      case 'core':
        readCore(component, i, index, prefix, result, platforms);
        break;
      case 'plugin':
        readPlugin(component, i, index, prefix, result, platforms);
        break;
      case 'config':
        readConfig(component, i, index, prefix, coreIndex, result);
        break;
      default:
        // Skipped rather than rejected, so a newer packaging script can add a type without
        // this server refusing every bundle it produces.
        warnings.push(finding('unknown_component_type',
          `components[${i}] has type "${component.type}", which this server does not `
          + 'recognise. The node ignores it.'));
    }
  });

  settleSystem(result);
  checkPluginSystems(result);

  if (coreIndex === -1) {
    warnings.push(finding('no_core_component',
      'The bundle has no core component. Nodes will receive plugin and config updates only, '
      + "and no node's reported version will change."));
  }

  result.platforms = [...platforms].sort();
  return result;
}

function readCore(component, i, index, prefix, result, platforms) {
  const { errors, warnings } = result;
  const variants = Array.isArray(component.variants) ? component.variants : [];

  if (variants.length === 0) {
    errors.push(finding('core_no_variants',
      'The core component declares no variants; no node would ever match it.'));
    return;
  }

  const seen = new Set();

  variants.forEach((variant, v) => {
    const platform = variant?.platform;
    const relative = variant?.path;

    if (typeof platform !== 'string' || typeof relative !== 'string') {
      errors.push(finding('variant_malformed',
        `core variant #${v} needs both a platform and a path.`));
      return;
    }

    if (!isValidPlatform(platform)) {
      // The node matches variants by exact string, so an unrecognised platform is dead weight.
      errors.push(finding('variant_platform_unknown',
        `core variant #${v}: platform "${platform}" is not one this fleet uses. The node `
        + 'matches by exact string, so nothing would select it.'));
      return;
    }

    if (seen.has(platform)) {
      errors.push(finding('duplicate_platform',
        `The core declares ${platform} twice. The node takes the first and ignores the rest.`));
      return;
    }
    seen.add(platform);
    platforms.add(platform);

    const dir = `${prefix}${relative}`;
    if (!hasAnythingUnder(index.names, dir)) {
      errors.push(finding('core_variant_path_missing',
        `The core variant for ${platform} points at "${relative}", which is not in the archive.`));
      return;
    }

    const sliceName = `${dir}/manifest.json`;
    const slice = readSlice(index, sliceName, errors, warnings, {
      missing: finding('core_slice_manifest_missing',
        `${relative}/manifest.json is missing. The node reads the version from there and `
        + 'would skip the core with core_manifest_invalid.'),
      unreadable: finding('core_slice_manifest_unreadable',
        `${relative}/manifest.json is not valid JSON (${index.sizes.get(sliceName) ?? 0} `
        + 'bytes). The node would skip the core with core_manifest_invalid.'),
    });

    const sliceVersion = typeof slice?.version === 'string' ? slice.version : null;
    const sliceSystem = systemName(slice?.system);
    noteSystem(result, sliceSystem);

    // THE rule this whole feature exists for. PackageApply.cpp compares this slice version
    // against what the node is running, and never looks at the bundle version.
    if (sliceVersion && result.version && sliceVersion !== result.version) {
      errors.push(finding('core_slice_version_mismatch',
        `${relative}/manifest.json says ${sliceVersion}, the bundle says ${result.version}. `
        + 'The node compares the slice version, so every node would download this and reply '
        + 'skipped/same_version. Re-stamp the slice, or fix --version.'));
    }

    if (slice && slice.package !== undefined && slice.package !== CORE_PACKAGE) {
      warnings.push(finding('core_slice_package_mismatch',
        `${relative}/manifest.json declares package "${slice.package}"; expected `
        + `"${CORE_PACKAGE}".`));
    }

    if (!hasAnythingUnder(index.names, `${dir}/bin`)) {
      const message = `${relative} has no bin/ entry. It stages successfully, then fails to `
        + 'start on the next boot.';
      // On Android the binary lives in nativeLibraryDir and the launcher skips bin/ by
      // design, so its absence there is expected rather than broken.
      if (isAndroid(platform)) warnings.push(finding('core_slice_no_bin', message));
      else errors.push(finding('core_slice_no_bin', message));
    }

    // A runtime slice records the plugins it was built with. They are NOT plugin components:
    // they ride along inside the core and are not independently versioned or updatable — but
    // they do overwrite whatever is on the node, so an operator has to be able to see them.
    const bundled = bundledPlugins(index, slice, index.names, dir);

    // Deliberately not a warning: every runtime slice carries its plugins, so this would fire
    // on every upload ever made. The panel lists them with versions, which says the same thing
    // without spending a warning line on it. Only a manifest that disagrees is worth flagging.
    if (bundled.length) {
      checkBundledManifests(bundled, platform, relative, warnings, sliceSystem);
    }

    const shipped = shippedConfig(index, dir);
    checkShippedConfig(shipped, platform, result, index.refuseConfigLifeline);

    result.cores.push({
      platform,
      path: relative,
      sliceVersion,
      system: sliceSystem,
      bundledPlugins: bundled,
      shippedConfig: shipped,
    });
  });
}

/**
 * Plugins a runtime slice carries, from its manifest's `plugins.dlls[]`
 * ("plugins/<Name>/lib<Name>.so"), falling back to the directory listing.
 *
 * The version comes from each plugin's own manifest.json inside the slice. Older runtime
 * builds copy only the shared library and leave that manifest out, so it is reported as
 * unknown when absent — never guessed, because a wrong version in the plan is worse than a
 * missing one.
 */
function bundledPlugins(index, slice, names, dir) {
  const found = new Set();

  for (const entry of slice?.plugins?.dlls ?? []) {
    if (typeof entry !== 'string') continue;
    const parts = entry.split('/');
    if (parts[0] === 'plugins' && parts[1]) found.add(parts[1]);
  }

  if (!found.size) {
    const prefix = `${dir}/plugins/`;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length).split('/')[0];
      if (rest) found.add(rest.replace(/\/$/, ''));
    }
  }

  return [...found].sort().map((name) => {
    const manifest = index.json.get(`${dir}/plugins/${name}/manifest.json`);
    const version = typeof manifest?.version === 'string' ? manifest.version : null;
    const declaredName = typeof manifest?.plugin === 'string' ? manifest.plugin : null;
    const declaredPlatform = typeof manifest?.platform === 'string' ? manifest.platform : null;
    const declaredSystems = systemList(manifest?.system);

    return {
      name,
      version,
      versionKnown: Boolean(version) && version !== UNKNOWN_VERSION && isValidVersion(version),
      declaredName,
      declaredPlatform,
      declaredSystems,
    };
  });
}

function readPlugin(component, i, index, prefix, result, platforms) {
  const { errors, warnings } = result;
  const name = component.name;

  if (typeof name !== 'string' || !name) {
    errors.push(finding('plugin_no_name', `components[${i}] is a plugin with no name.`));
    return;
  }

  const variants = Array.isArray(component.variants) ? component.variants : [];
  if (variants.length === 0) {
    errors.push(finding('plugin_no_variants',
      `Plugin "${name}" declares no variants; no node would ever match it.`));
    return;
  }

  const seen = new Set();

  variants.forEach((variant, v) => {
    const platform = variant?.platform;
    const relative = variant?.path;

    if (typeof platform !== 'string' || typeof relative !== 'string') {
      errors.push(finding('variant_malformed',
        `plugin "${name}" variant #${v} needs both a platform and a path.`));
      return;
    }

    if (!isValidPlatform(platform)) {
      errors.push(finding('variant_platform_unknown',
        `${name} variant #${v}: platform "${platform}" is not one this fleet uses. The node `
        + 'matches by exact string, so nothing would select it.'));
      return;
    }

    if (seen.has(platform)) {
      errors.push(finding('duplicate_platform',
        `${name} declares ${platform} twice. The node takes the first and ignores the rest.`));
      return;
    }
    seen.add(platform);
    platforms.add(platform);

    const dir = `${prefix}${relative}`;
    if (!hasAnythingUnder(index.names, dir)) {
      errors.push(finding('plugin_variant_path_missing',
        `The ${name} variant for ${platform} points at "${relative}", which is not in the `
        + 'archive.'));
      return;
    }

    const sliceName = `${dir}/manifest.json`;
    let version = null;
    let versionKnown = false;
    let pluginSystems = [];

    if (index.unparseable.has(sliceName)) {
      warnings.push(finding('plugin_slice_manifest_unreadable',
        `${name} for ${platform} has a manifest.json that is not valid JSON `
        + `(${index.sizes.get(sliceName) ?? 0} bytes), so its version could not be recorded.`));
    } else if (!index.json.has(sliceName)) {
      warnings.push(finding('plugin_slice_manifest_missing',
        `${name} for ${platform} has no manifest.json, so its version could not be recorded.`));
    } else {
      const slice = index.json.get(sliceName);
      const raw = typeof slice?.version === 'string' ? slice.version : null;

      if (raw === null) {
        warnings.push(finding('plugin_slice_manifest_missing',
          `${name} for ${platform} has a manifest.json with no version, so its version could `
          + 'not be recorded.'));
      } else if (raw === UNKNOWN_VERSION) {
        // The packaging scripts write this literal when the plugin has no version define.
        version = raw;
        warnings.push(finding('plugin_version_unknown',
          `${name} for ${platform} reports version "unknown" — no version define at build `
          + 'time, so it cannot be ordered against a node\'s.'));
      } else if (!isValidVersion(raw)) {
        version = raw;
        warnings.push(finding('plugin_version_not_numeric',
          `${name} for ${platform} reports version "${raw}", which is not dotted numeric.`));
      } else {
        version = raw;
        versionKnown = true;
      }

      // Deliberately NOT noteSystem(): a plugin's system is the list of products it is valid
      // on, not the system this bundle is for. Only a core slice names that. Checked against
      // the bundle's system after settleSystem(), which has not run yet here.
      pluginSystems = systemList(slice?.system);

      // A copy-pasted manifest with the wrong name inside the right folder is otherwise
      // invisible, and the name is what the plan and every node report is keyed on.
      const declaredName = typeof slice?.plugin === 'string' ? slice.plugin : null;
      if (declaredName && declaredName !== name) {
        warnings.push(finding('plugin_slice_name_mismatch',
          `${relative}/manifest.json says plugin "${declaredName}", but the component is `
          + `"${name}". The bundle manifest wins; check the build.`));
      }

      const declared = typeof slice?.platform === 'string' ? slice.platform : null;
      // The Windows build writes a bare "windows" with no arch, so a prefix match is a
      // genuine agreement rather than a mismatch.
      if (declared && declared !== platform && !platform.startsWith(declared)) {
        warnings.push(finding('plugin_slice_platform_mismatch',
          `${name} is declared for ${platform}, but its manifest.json says platform `
          + `"${declared}".`));
      }
    }

    // A plugin ships its own config/ too, and apply_plugin sends it through the same
    // reconcile_config_file as the core's — package as the base, so every param the node has
    // not locked takes the package's value.
    const shipped = shippedConfig(index, dir);
    if (shipped.length) {
      warnings.push(finding('plugin_ships_config',
        `${name} for ${platform} ships ${shipped.map((f) => f.file).join(', ')} — it replaces `
        + 'every param the node has not locked, not just the ones you name.'));
    }

    result.plugins.push({
      name,
      platform,
      path: relative,
      version,
      versionKnown,
      declaredSystems: pluginSystems,
      shippedConfig: shipped,
    });
  });
}

function readConfig(component, i, index, prefix, coreIndex, result) {
  const { errors, warnings } = result;
  const target = component.target;
  const relative = component.path;

  if (typeof target !== 'string' || typeof relative !== 'string') {
    errors.push(finding('config_malformed',
      `components[${i}] is a config component and needs both a target and a path.`));
    return;
  }

  const payloadName = `${prefix}${relative}`;
  if (!index.names.has(payloadName)) {
    errors.push(finding('config_path_missing',
      `The config component for target "${target}" points at "${relative}", which is not in `
      + 'the archive.'));
    return;
  }

  // The node applies components in array order and only redirects config into the staged tree
  // AFTER a core has staged, so a config listed first lands in the live tree and is then
  // overwritten by the staged copy on restart.
  if (coreIndex !== -1 && i < coreIndex) {
    errors.push(finding('config_before_core',
      `Config component "${target}" is at index ${i}, before the core at index ${coreIndex}. `
      + 'It would be written to the live tree, then overwritten on restart. Put the core '
      + 'first.'));
  }

  // Read the params this component sets, so nobody has to retype them. The payload is the
  // node's slim value form, which flattens straight onto the dotted keys the plan uses.
  let params = [];
  if (index.unparseable.has(payloadName)) {
    warnings.push(finding('config_payload_unreadable',
      `${relative} is not valid JSON, so the params it sets could not be recorded. The node `
      + 'would skip this component with reason config_payload_invalid.'));
  } else if (index.json.has(payloadName)) {
    params = flattenConfigPayload(index.json.get(payloadName));
    if (!params.length) {
      warnings.push(finding('config_payload_empty',
        `${relative} sets no params.`));
    }
  }

  result.configs.push({ target, path: relative, params });
}

// ── the legacy single-directory package ───────────────────────────────────────────────────

function inspectLegacy(index, manifest, prefix, manifestName, result) {
  const { errors, warnings } = result;
  result.format = 'legacy';

  // A plugin slice also has version/platform and no components. Staging one as the core would
  // replace the runtime with a plugin folder.
  if (typeof manifest.plugin === 'string') {
    errors.push(finding('legacy_is_plugin_slice',
      `manifest.json is a plugin slice (${manifest.plugin}), not a runtime slice. The node `
      + 'would stage a plugin folder as the core.'));
    return result;
  }

  if (manifest.package !== undefined && manifest.package !== CORE_PACKAGE) {
    errors.push(finding('unknown_package',
      `${manifestName} declares package "${manifest.package}", which is neither an `
      + `${BUNDLE_PACKAGE} bundle nor an ${CORE_PACKAGE} runtime slice.`));
    return result;
  }

  result.version = checkVersion(manifest.version, errors);

  const platform = typeof manifest.platform === 'string' ? manifest.platform : null;
  if (!platform) {
    errors.push(finding('legacy_no_platform',
      'This is a legacy single-directory package, but its manifest.json has no "platform" '
      + 'field, so the server cannot tell which platform it is for.'));
    return result;
  }
  if (!isValidPlatform(platform)) {
    errors.push(finding('variant_platform_unknown',
      `The package declares platform "${platform}", which is not a platform this fleet uses.`));
    return result;
  }

  const root = prefix.replace(/\/$/, '');
  if (!hasAnythingUnder(index.names, `${root}/bin`) && !isAndroid(platform)) {
    errors.push(finding('core_slice_no_bin',
      `The package has no bin/ entry. A runtime slice with no executable stages successfully `
      + 'and then fails to start on the next boot.'));
  }

  const legacySystem = systemName(manifest.system);
  noteSystem(result, legacySystem);

  // Same read as the modern path: the package carries plugins inside the core even though it
  // declares no plugin components, and they still overwrite what is on the node.
  const bundled = bundledPlugins(index, manifest, index.names, root);

  warnings.push(finding('legacy_format',
    `Legacy single-directory package: applied as a bare core for ${platform}`
    + `${bundled.length ? ` with ${bundled.length} plugin(s) inside it` : ''}, with no plugin `
    + 'or config components. New builds should use package_update_bundle.sh.'));

  if (bundled.length) checkBundledManifests(bundled, platform, root, warnings, legacySystem);

  // The case that makes this visible: a legacy runtime package carries the runtime's own
  // config/ directory, and saying nothing about it hides that it overwrites the node's.
  const shipped = shippedConfig(index, root);
  checkShippedConfig(shipped, platform, result, index.refuseConfigLifeline);

  settleSystem(result);

  result.platforms = [platform];
  result.cores.push({
    platform,
    path: root,
    sliceVersion: typeof manifest.version === 'string' ? manifest.version : null,
    system: legacySystem,
    bundledPlugins: bundled,
    shippedConfig: shipped,
  });
  return result;
}

// ── shared ────────────────────────────────────────────────────────────────────────────────

/**
 * Read a slice manifest, recording the right finding when it is absent or unreadable.
 * Returns the parsed object, or null when there is nothing usable.
 */
function readSlice(index, name, errors, warnings, messages) {
  if (index.unparseable.has(name)) {
    errors.push(messages.unreadable);
    return null;
  }
  if (!index.json.has(name)) {
    errors.push(messages.missing);
    return null;
  }
  const slice = index.json.get(name);
  if (!slice || typeof slice !== 'object' || Array.isArray(slice)) {
    errors.push(messages.unreadable);
    return null;
  }
  return slice;
}


/**
 * Params a runtime slice ships in its own config/ directory.
 *
 * These are NOT config components. A core slice carries the full "fat" config
 * ({"group":{"type":"group","params":{...}}}), and applying a core replaces the whole runtime
 * directory — reconcile_config then merges the live file over it with the PACKAGE as the base:
 *
 *     if (is_frozen_param(live)) { out["value"] = live["value"]; return; }  // locked wins
 *     // otherwise the package value stays
 *
 * So every param the package ships and the node has not locked takes the package's value.
 * That is how a stock -Config build silently blanks update.server_url on a whole fleet.
 */
function shippedConfig(index, dir) {
  // EVERY config/ under this directory, not just the one at its root. A runtime slice built
  // from a full dist directory carries its plugins too, each with its own
  // plugins/<Name>/config/<Name>.json — and those are replaced along with the core.
  const prefix = `${dir}/`;
  const files = [];

  for (const name of [...index.json.keys()].sort()) {
    if (!name.startsWith(prefix)) continue;

    const relative = name.slice(prefix.length);
    if (!/(^|\/)config\/[^/]+\.json$/.test(relative)) continue;

    const parsed = index.json.get(name);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const params = [];
    for (const [group, node] of Object.entries(parsed)) {
      if (!node || typeof node !== 'object' || node.type !== 'group' || !node.params) continue;
      for (const [key, param] of Object.entries(node.params)) {
        if (!param || typeof param !== 'object') continue;
        params.push({
          param: `${group}.${key}`,
          value: param.value,
          locked: Boolean(param.locked),
          readonly: Boolean(param.readonly),
        });
      }
    }

    // A file with no params is not a config file — ota_keys.json, for instance. It is still
    // shipped and still replaces whatever the node has, so record it rather than drop it.
    const plugin = relative.match(/^plugins\/([^/]+)\//)?.[1] ?? null;
    files.push({ file: relative, plugin, params });
  }
  return files;
}

/**
 * Params whose shipped value would cut a node off from this server. A node that applies them
 * cannot be reached again — there is no remote path back.
 */
const LIFELINE = {
  'update.enabled': (value) => value === false,
  'update.server_url': (value) => value === '' || value === null,
  'update.api_key': (value) => value === '' || value === null,
};

/** A bundled plugin's manifest must agree with the folder it sits in and the slice it rides. */
/**
 * Which system this bundle is for.
 *
 * The build stamps it into every slice manifest, so that is the source of truth. release.json
 * may still name one — it is honoured when the slices are silent, and flagged when the two
 * disagree, because a bundle that claims two systems would be filed under the wrong one.
 */
/**
 * The system field, in either shape the node accepts.
 *
 * `system_covers()` in the node's PackageApply.cpp reads a string as one product and an array
 * as a list of products a plugin is valid on. Absent or empty means "compatible with
 * everything", which is what keeps unstamped builds installable.
 *
 * @returns {string[]} the names declared, empty when the field says nothing
 */
function systemList(value) {
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? [name] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/** The one system a core slice names. A list here would not identify a version line. */
function systemName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function noteSystem(result, name) {
  if (name && !result.declaredSystems.includes(name)) result.declaredSystems.push(name);
}

function settleSystem(result) {
  const declared = result.declaredSystems.sort();

  if (declared.length > 1) {
    result.errors.push(finding('conflicting_systems',
      `Slices in this bundle name different systems: ${declared.join(', ')}. A bundle `
      + 'belongs to exactly one.'));
    return;
  }

  const stamped = declared[0] ?? null;
  if (!stamped) return;

  if (result.release.system && result.release.system !== stamped) {
    result.warnings.push(finding('release_json_system_mismatch',
      `release.json says system "${result.release.system}" but the slices say "${stamped}". `
      + 'The slices win.'));
  }

  result.release.system = stamped;
}

/**
 * Every plugin component must be valid on the system this bundle is for.
 *
 * A plugin declaring ["HERA", "drone"] covers a HERA bundle; one declaring ["drone"] does not,
 * and on a HERA node the whole plugin is skipped at apply time with `system_mismatch` — a
 * non-fatal skip, so the update reports success and the plugin simply never arrives.
 *
 * Runs after settleSystem() because it needs the answer that produces.
 */
function checkPluginSystems(result) {
  const system = result.release.system;
  if (!system) return;

  for (const plugin of result.plugins) {
    const declared = plugin.declaredSystems ?? [];
    if (!declared.length || declared.includes(system)) continue;

    result.warnings.push(finding('plugin_slice_system_mismatch',
      `${plugin.name} for ${plugin.platform} is built for ${declared.join(', ')}, but this `
      + `bundle is for ${system}.${caseHint(declared, system)} The node will skip it.`));
  }
}

/**
 * Say it out loud when the only difference is capitalisation.
 *
 * `system_covers()` compares with `==` on std::string, so "Hera" and "HERA" are simply two
 * different systems to the node. On the page the two read as the same word, and an operator
 * scanning a warning list will skip right past it — which is how a plugin ends up never
 * installing on any device while every release reports success.
 */
function caseHint(declared, system) {
  const near = declared.find((name) => name.toLowerCase() === system.toLowerCase());
  return near
    ? ` "${near}" and "${system}" differ only in case, and the node compares exactly.`
    : '';
}

function checkBundledManifests(bundled, platform, where, warnings, coreSystem) {
  for (const plugin of bundled) {
    // A plugin riding inside a core slice was built for whatever that core was built for.
    // Disagreement means the two came off different builds, and the plugin is the odd one
    // out — not grounds to refuse the release, but the operator has to see it.
    const declared = plugin.declaredSystems ?? [];
    if (coreSystem && declared.length && !declared.includes(coreSystem)) {
      warnings.push(finding('plugin_slice_system_mismatch',
        `${plugin.name} rides in a ${coreSystem} core but is built for `
        + `${declared.join(', ')}.${caseHint(declared, coreSystem)} The node will skip it.`));
    }

    if (plugin.declaredName && plugin.declaredName !== plugin.name) {
      warnings.push(finding('plugin_slice_name_mismatch',
        `${where}/plugins/${plugin.name}/manifest.json says plugin `
        + `"${plugin.declaredName}". The folder name is what the node loads; check the build.`));
    }

    // The Windows build writes a bare "windows" with no arch, so a prefix match agrees.
    if (plugin.declaredPlatform && plugin.declaredPlatform !== platform
        && !platform.startsWith(plugin.declaredPlatform)) {
      warnings.push(finding('plugin_slice_platform_mismatch',
        `${plugin.name} rides in a ${platform} core but its manifest says `
        + `"${plugin.declaredPlatform}".`));
    }
  }
}

function checkShippedConfig(files, platform, result, refuseLifeline = false) {
  const { errors, warnings } = result;
  if (!files.length) return;

  // One finding, not one per param. Every real build ships these files, so a rule that fires
  // per param produces the same four lines on every upload — and a screen of warnings that
  // never changes is one nobody reads, including the line that matters.
  const risky = [];

  for (const file of files) {
    for (const entry of file.params) {
      const test = LIFELINE[entry.param];
      const dangerous = (test && test(entry.value))
        || (entry.param === 'link.serial' && (entry.value === '' || entry.value === null))
        || entry.param === 'link.role'
        // Any value, like link.role: the hazard is not what it holds but that shipping it
        // unlocked overwrites a choice the operator made on the device. A machine moved to
        // `beta` for testing is put back on `stable` by the first beta build it installs —
        // which is to say, the cohort dissolves exactly when the test starts.
        || entry.param === 'update.channel';
      if (!dangerous) continue;

      // The package's lock flag is not what protects a node that already has the param —
      // reconcile_param takes the lock state from the live config. It IS what a factory-fresh
      // node and any newly added param get, so shipping these unlocked is wrong in every case,
      // while shipping them locked is only unverifiable.
      risky.push({
        param: entry.param,
        value: entry.value,
        frozen: Boolean(entry.locked || entry.readonly),
      });
    }
  }

  const unlocked = risky.filter((entry) => !entry.frozen);

  if (unlocked.length) {
    const named = unlocked
      .map((entry) => `${entry.param}=${JSON.stringify(entry.value)}`)
      .join(', ');
    const message = `Shipped config for ${platform} ships ${named} unlocked. A slice's config/ `
      + 'replaces the node\'s, and an unlocked param takes the package value — on a fresh node '
      + 'these stay unlocked. Lock them in the build.';

    (refuseLifeline ? errors : warnings).push(finding('core_config_lifeline_unlocked', message));
    return;
  }

  if (risky.length) {
    // Locked in the package: a fresh node is safe. Whether an existing node is depends on how
    // it was provisioned, which this server cannot see.
    warnings.push(finding('core_config_lifeline_locked',
      `Shipped config for ${platform} carries ${risky.map((e) => e.param).join(', ')}, locked. `
      + 'Nodes provisioned without those locks still take the package value.'));
    return;
  }

  // Nothing dangerous, but the mechanism is still worth stating once.
  const nested = [...new Set(files.map((f) => f.plugin).filter(Boolean))];
  warnings.push(finding('core_ships_config',
    `The core for ${platform} ships ${files.length} config file(s)`
    + `${nested.length ? ` (incl. ${nested.join(', ')})` : ''} — it replaces every param the `
    + 'node has not locked, not just the ones you name.'));
}

function checkVersion(raw, errors) {
  if (typeof raw !== 'string' || raw === '') {
    errors.push(finding('version_missing', 'manifest.json has no "version" string.'));
    return null;
  }
  if (raw === PLACEHOLDER_VERSION) {
    errors.push(finding('version_placeholder',
      `Version is ${PLACEHOLDER_VERSION} — the packaging script's fallback when --version was `
      + 'omitted. Re-run it with an explicit --version.'));
    return null;
  }
  if (!isValidVersion(raw)) {
    errors.push(finding('version_invalid',
      `The bundle version "${raw}" is not a dotted numeric version (e.g. 0.15.0).`));
    return null;
  }
  return raw;
}

/**
 * Compare what the operator asserted against what the bundle actually says.
 * @returns {Finding[]}
 */
export function crossCheck(inspection, { version = null, platforms = null, kind = null } = {}) {
  const findings = [];

  if (version && inspection.version && version !== inspection.version) {
    findings.push(finding('cross_check_version',
      `The URL says version ${version}, but the bundle's manifest.json says `
      + `${inspection.version}. The bundle is the source of truth — drop the version from the `
      + 'URL, or fix the bundle.'));
  }

  if (platforms && platforms.length && inspection.platforms.length) {
    const asserted = [...new Set(platforms)].sort().join(',');
    const actual = inspection.platforms.join(',');
    if (asserted !== actual) {
      findings.push(finding('cross_check_platforms',
        `?platforms= says ${asserted}, but the bundle covers ${actual}. The bundle is the `
        + 'source of truth — drop the parameter, or fix the bundle.'));
    }
  }

  if (kind === 'slim' && inspection.platforms.length > 1) {
    findings.push(finding('kind_slim_multi_platform',
      `kind=slim needs exactly one platform, but the bundle covers `
      + `${inspection.platforms.length}: ${inspection.platforms.join(', ')}.`));
  }

  // Only a config-only bundle leaves the server unable to work out what it applies to.
  if (inspection.platforms.length === 0 && (!platforms || platforms.length === 0)
      && inspection.errors.length === 0) {
    findings.push(finding('config_only_needs_platforms',
      'This bundle contains only config components, so the server cannot derive which '
      + 'platforms it applies to. Re-send with ?platforms=<comma-separated>.'));
  }

  return findings;
}

/** fleet vs slim, derived from the platform count unless the operator says otherwise. */
export function resolveKind(platforms, asserted = null) {
  if (asserted) return asserted;
  return platforms.length === 1 ? 'slim' : 'fleet';
}

function hasAnythingUnder(names, dir) {
  const prefix = `${dir}/`;
  if (names.has(prefix)) return true;
  for (const name of names) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

const finding = (rule, message) => ({ rule, message });
