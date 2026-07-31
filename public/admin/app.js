import {
  ApiError, clearSession, getUser, logout, refresh, request, sha256, upload,
} from './api.js';

const KNOWN_PLATFORMS = [
  'linux-x86_64', 'linux-aarch64', 'linux-arm', 'linux-x86',
  'windows-x86_64', 'windows-aarch64', 'windows-x86',
  'android-aarch64', 'android-x86_64', 'android-arm', 'android-x86',
  'macos-x86_64', 'macos-aarch64',
];

const $ = (id) => document.getElementById(id);
let catalog = { channels: [], releases: [], revision: '0' };
let selectedFile = null;
// The last upload, kept so the panel can be redrawn after Publish — the standing it shows is
// wrong the moment a channel starts pointing at the release.
let lastUpload = null;

// ── shell ─────────────────────────────────────────────────────────────────────────────────

function showError(message, details = null) {
  const box = $('error');
  box.replaceChildren();

  if (message) {
    box.append(el('p', '', message));
    // Bundle inspection returns every finding at once; showing one at a time would make a
    // five-problem bundle take five uploads to fix.
    if (Array.isArray(details) && details.length > 1) {
      const list = el('ul', 'findings');
      for (const finding of details) list.append(el('li', '', finding.message));
      box.append(list);
    }
  }

  box.hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  if (message) setTimeout(() => { $('notice').hidden = true; }, 6000);
}

/** Any 401 that survives the silent refresh means the session is over. */
async function guard(action) {
  try {
    showError('');
    return await action();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return signOut();
    showError(err.message, err.details);
    return undefined;
  }
}

function signOut() {
  clearSession();
  window.location.replace('/admin/login.html');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const thead = el('thead');
  const tr = el('tr');
  headers.forEach((h) => tr.append(el('th', null, h)));
  thead.append(tr);
  t.append(thead);

  const tbody = el('tbody');
  if (!rows.length) {
    const empty = el('tr');
    const td = el('td', 'empty', 'Nothing yet.');
    td.colSpan = headers.length;
    empty.append(td);
    tbody.append(empty);
  }
  rows.forEach((cells) => {
    const row = el('tr');
    cells.forEach((cell) => {
      const td = el('td');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell ?? '';
      row.append(td);
    });
    tbody.append(row);
  });
  t.append(tbody);
  wrap.append(t);
  return wrap;
}

const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const when = (value) => (value ? new Date(value).toLocaleString() : '—');

// ── tabs ──────────────────────────────────────────────────────────────────────────────────

$('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;

  for (const other of $('tabs').querySelectorAll('button')) other.classList.remove('active');
  button.classList.add('active');

  for (const section of document.querySelectorAll('.tab')) section.hidden = true;
  $(`tab-${button.dataset.tab}`).hidden = false;

  const loaders = {
    systems: loadSystems, catalog: renderCatalog, fleet: loadFleet,
    rollout: loadRollout, security: loadSecurity,
  };
  loaders[button.dataset.tab]?.();
});

$('signout').addEventListener('click', async () => {
  await logout();
  signOut();
});

// ── catalog ───────────────────────────────────────────────────────────────────────────────

async function loadCatalog() {
  catalog = await request('/admin/api/catalog');

  const versions = catalog.releases.map((release) => release.version);
  fillSelect($('ro-version'), versions, 'All versions');
}

function fillSelect(select, values, emptyLabel) {
  const previous = select.value;
  select.replaceChildren();
  if (emptyLabel) select.append(new Option(emptyLabel, ''));
  values.forEach((value) => select.append(new Option(value, value)));
  if (values.includes(previous)) select.value = previous;
}

function renderCatalog() {
  $('catalog-rev').textContent = `revision ${catalog.revision}`;
  const container = $('catalog-list');
  container.replaceChildren();

  if (!catalog.releases.length) {
    container.append(el('p', 'empty', 'No releases yet. Upload a bundle on the Publish tab.'));
    return;
  }

  for (const release of catalog.releases) {
    const card = el('div', 'release');
    const head = el('div', 'release-head');
    head.append(el('strong', null, release.version));

    // Labelled, because unlabelled chips read as one undifferentiated row: "0.13.4 HERA
    // stable beta" gives no clue which word is the system and which are channels.
    const system = el('span', 'tag', release.system);
    system.title = 'The kind of device this release is for.';
    head.append(el('span', 'hint', 'system'), system);

    // Channel standing lives in the table below, as a column. It stays in the header only
    // when there is no table to put it in — a release whose artifact was deleted still has to
    // say whether a channel is pointing at a version that can no longer be downloaded.
    if (!release.artifacts.length) {
      head.append(el('span', 'hint', standingLabel(release)));
      for (const tag of channelStanding(release)) head.append(tag);
    }
    if (release.minVersion) head.append(el('span', 'tag', `min ${release.minVersion}`));
    if (release.mandatory) head.append(el('span', 'tag warn', 'mandatory'));
    head.append(el('span', 'hint', when(release.publishedAt)));

    const promote = el('button', 'ghost', 'Promote');
    promote.addEventListener('click', () => guard(() => showPromote(release)));
    head.append(promote);

    const remove = el('button', 'ghost danger', 'Delete release');
    remove.addEventListener('click', () => guard(async () => {
      if (!window.confirm(`Delete release ${release.version} and all its artifacts?`)) return;
      await request(`/admin/api/releases/${release.version}`, { method: 'DELETE' });
      showNotice(`Deleted ${release.version}`);
      await loadCatalog();
      renderCatalog();
    }));
    head.append(remove);
    card.append(head);

    if (release.notes) card.append(el('p', 'hint', release.notes));

    card.append(table(
      ['Kind', 'Channel', 'Platforms', 'Format', 'Size', 'SHA-256', 'Plugins', 'Config', ''],
      release.artifacts.map((artifact) => [
        kindCell(artifact),
        channelCell(release, artifact),
        artifact.platforms.join(', '),
        formatCell(artifact),
        bytes(artifact.size),
        artifact.sha256.slice(0, 12) + '…',
        String(Object.values(artifact.plugins).reduce((n, m) => n + Object.keys(m).length, 0)),
        String(Object.values(artifact.config).reduce((n, list) => n + list.length, 0)),
        artifactActions(artifact),
      ]),
    ));
    container.append(card);
  }
}

/**
 * Whether a node can actually be handed this version.
 *
 * Uploading puts a release in the catalog, but /check only ever offers a channel's latest or a
 * pinned version — so a release named by neither sits here unreachable. Without saying so, a
 * staged release and a live one look identical in this list.
 */
/**
 * Point a channel at a release, with what the fleet reported about it in view.
 *
 * The step this replaces was the generic "Create or update a channel" form, which lists every
 * release and knows nothing about any of them. Promoting from beta to stable is the moment the
 * decision actually gets made, and it was the one moment the evidence was on another tab.
 */
/**
 * Point a channel at a version, including the case where that means going backwards.
 *
 * The server refuses a backwards move unless told explicitly, which is right — but a refusal
 * that names a flag the UI cannot send is a dead end. It branches on the `channel_rollback`
 * finding rather than on the message text, so rewording the message cannot silently break the
 * only path out of it.
 *
 * @returns {Promise<boolean>} false when the operator declined the rollback
 */
async function setChannelLatest(system, name, version) {
  const url = `/admin/api/systems/${system}/channels/${name}`;

  // One release runs on one channel, so pointing this one at `version` takes it off whichever
  // channel has it now. That is a change to what another set of nodes is offered, and it must
  // not happen behind the operator's back.
  const losing = (catalog.channels ?? [])
    .filter((c) => c.system === system && c.name !== name && c.latest === version)
    .map((c) => c.name);

  if (losing.length && !window.confirm(
    `${version} is currently on ${losing.join(', ')}.\n\n`
    + `A release runs on one channel at a time, so pointing ${name} at it also clears `
    + `${losing.join(', ')}. Nodes there keep ${version} — they already have it — and are `
    + 'offered nothing new until that channel is pointed somewhere again.\n\nContinue?',
  )) return false;

  try {
    const result = await request(url, { method: 'PUT', body: { latest: version } });
    if (result?.released?.length) {
      showNotice(`${version} moved to ${name}; ${result.released.join(', ')} now points at nothing`);
    }
    return true;
  } catch (err) {
    const rollback = (err.details ?? []).find((finding) => finding.rule === 'channel_rollback');
    if (!rollback) throw err;

    if (!window.confirm(
      `${system}/${name} is on ${rollback.from}. Moving it to ${rollback.to} is a rollback.\n\n`
      + 'Nodes already updated will not go back — but any node provisioned from now on takes '
      + `${rollback.to}, so the fleet ends up on two versions.\n\nDo it anyway?`,
    )) return false;

    const result = await request(url, {
      method: 'PUT', body: { latest: version, allow_rollback: true },
    });
    if (result?.released?.length) {
      showNotice(`${version} moved to ${name}; ${result.released.join(', ')} now points at nothing`);
    }
    return true;
  }
}

async function showPromote(release) {
  const panel = $('promote-panel');
  panel.replaceChildren();
  panel.hidden = false;

  const card = el('div', 'card inset');
  const title = el('h3', '', `Promote ${release.version}`);
  const close = el('button', 'link', 'Close');
  close.addEventListener('click', () => { panel.hidden = true; });
  title.append(document.createTextNode(' '), close);
  card.append(title);

  // One target, always. Every system has `beta` and `stable`, an upload lands on beta, and
  // promoting means the one remaining step — so there is nothing to choose.
  const stable = (catalog.channels ?? [])
    .find((c) => c.system === release.system && c.name === 'stable');

  if (stable?.latest === release.version) {
    card.append(el('p', 'hint', `${release.version} is already what stable hands out.`));
    panel.append(card);
    return;
  }

  const report = await request(`/admin/api/reports?version=${encodeURIComponent(release.version)}`);
  card.append(rolloutEvidence(report.stats ?? []));

  const row = el('div', 'row');
  const go = el('button', '', `Promote to stable (now on ${stable?.latest ?? 'nothing'})`);
  go.addEventListener('click', () => guard(async () => {
    if (!await setChannelLatest(release.system, 'stable', release.version)) return;
    showNotice(`${release.system}/stable now hands out ${release.version}`);
    panel.hidden = true;
    await loadCatalog();
    renderCatalog();
  }));
  row.append(go);
  card.append(row);

  panel.append(card);
}

/**
 * What the fleet actually reported about this version.
 *
 * "No reports" is stated as its own case rather than shown as 0 of 0, which reads like a clean
 * pass. It means nobody has run this build, which is the opposite of evidence.
 */
function rolloutEvidence(stats) {
  const wrap = el('div');
  const total = stats.reduce((sum, row) => sum + row.count, 0);

  if (!total) {
    wrap.append(el('p', 'hint',
      'No node has reported this version yet — there is nothing here showing it works.'));
    return wrap;
  }

  const ok = stats.filter((row) => row.result === 'success')
    .reduce((sum, row) => sum + row.count, 0);
  const bad = total - ok;

  const line = el('p', bad ? 'error banner' : 'notice banner');
  line.textContent = bad
    ? `${total} report(s): ${ok} success, ${bad} failed — `
      + stats.filter((row) => row.result !== 'success')
        .map((row) => `${row.error} ×${row.count}`).join(', ')
    : `${total} report(s), all success.`;
  wrap.append(line);
  return wrap;
}

/**
 * The word in front of the chips, which is where the verb lives.
 *
 * A bare green `beta` chip does not say whether that channel is HANDING OUT this version or
 * merely exists. With two of them and nothing else on the row there is nothing to infer it
 * from either, so the label has to say it.
 */
/**
 * The Channel column: which channels hand this release out, and where the others are.
 *
 * A column rather than more chips in the header. The header had version, system, channels,
 * dates and two buttons on one line, and the answer to "which channel is this on" was a green
 * word in the middle of it. Down a column it reads at a glance, and it lines up with Kind and
 * Platforms — the other two facts that decide whether a given node gets this artifact.
 *
 * The value is per release, so every artifact row of one release repeats it. That is the
 * point: the question is asked while looking at a row.
 */
/**
 * Kind, and whether the bytes behind it still exist.
 *
 * A row whose file has gone looks completely healthy from this screen: the release is listed,
 * a channel points at it, and nodes are told there is no update. The only trace anywhere else
 * is one line in the server log.
 */
function kindCell(artifact) {
  const label = artifact.kind + (artifact.platform ? ` (${artifact.platform})` : '');
  if (artifact.readable !== false) return label;

  const wrap = el('span');
  wrap.append(document.createTextNode(`${label} `));
  const tag = el('span', 'tag warn', 'bytes missing');
  tag.title = 'The catalog row is here but the file is not. No node can be given this — the '
    + 'check path refuses to offer an artifact it cannot read. Re-upload it.';
  wrap.append(tag);
  return wrap;
}

function channelCell(release, artifact) {
  const wrap = el('div', 'chan-cell');

  // A channel pointing at bytes that are gone is not serving anything, whatever the row says.
  if (artifact?.readable === false) {
    const tag = el('span', 'tag warn', 'nothing served');
    tag.title = 'A channel points at this release, but its file is missing — nodes are being '
      + 'told there is no update.';
    wrap.append(tag);
    return wrap;
  }

  wrap.append(el('span', 'hint', standingLabel(release)));
  for (const tag of channelStanding(release)) wrap.append(tag);
  return wrap;
}

function standingLabel(release) {
  const serving = (catalog.channels ?? [])
    .some((c) => c.system === release.system && c.latest === release.version);

  return serving ? 'live on' : 'channels';
}

/**
 * Where this release stands in every channel of its system.
 *
 * The question an operator is actually asking on this screen is "is this on beta yet, and is
 * stable still behind?" — so a single "live: beta" tag answers half of it and leaves the half
 * that decides whether to promote. Every channel gets a chip: green when it hands out this
 * version, muted with an arrow when it is on something else.
 *
 * @returns {HTMLElement[]}
 */
function channelStanding(release) {
  const of = (name) => (catalog.channels ?? [])
    .find((c) => c.system === release.system && c.name === name);

  const beta = of('beta');
  const stable = of('stable');

  if (!beta && !stable) {
    const tag = el('span', 'tag warn', 'no channels');
    tag.title = `System ${release.system} has none, so nothing can be offered at all.`;
    return [tag];
  }

  // Fixed order, never alphabetical: beta then stable is the direction a release travels, and
  // reading the same two positions on every row is what makes a column scannable.
  const out = [];
  for (const [name, channel] of [['beta', beta], ['stable', stable]]) {
    if (!channel) continue;

    if (channel.latest === release.version) {
      const tag = el('span', 'tag ok', name);
      tag.title = `Nodes on ${name} are being offered this version.`;
      out.push(tag);
      continue;
    }

    // What that channel has instead. `none` rather than `nothing`: the column is narrow and
    // the word is doing a label's job, not a sentence's.
    const tag = el('span', 'tag dim', `${name}: ${channel.latest ?? 'none'}`);
    tag.title = channel.latest
      ? `${name} is on ${channel.latest}, not this one.`
      : `${name} is not handing anything out.`;
    out.push(tag);
  }

  // No channel serves it: no node can see this release at all, and that has to read as a
  // warning rather than as an absence of green.
  if (!out.some((tag) => tag.className.includes('ok'))) {
    const staged = el('span', 'tag warn', 'nobody sees this');
    staged.title = 'In the catalog, but neither channel points at it.';
    return [staged, ...out];
  }

  return out;
}


function artifactActions(artifact) {
  const wrap = el('div', 'row-actions');

  const details = el('button', 'ghost', 'Details');
  details.addEventListener('click', () => guard(() => showArtifactDetails(artifact)));

  const remove = el('button', 'ghost danger', 'Delete');
  remove.addEventListener('click', () => guard(async () => {
    if (!window.confirm(`Delete artifact ${artifact.file} of ${artifact.version}?`)) return;
    await request(`/admin/api/artifacts/${artifact.id}`, { method: 'DELETE' });
    showNotice('Artifact deleted');
    await loadCatalog();
    renderCatalog();
  }));

  wrap.append(details, remove);
  return wrap;
}

// ── publish ───────────────────────────────────────────────────────────────────────────────

/**
 * Show what the server actually found inside the bundle. This is the only place an operator
 * can see that the version and platforms were derived rather than declared, and it is where
 * non-blocking warnings surface — they never reach the error box.
 */
function renderInspection(result) {
  lastUpload = result;
  const panel = $('inspection');
  panel.replaceChildren();
  panel.hidden = false;

  const report = result.inspection;
  if (!report) return;

  const head = el('div', 'card');
  head.append(el('h2', '', 'What the bundle contains'));

  const summary = el('p', 'hint');
  summary.append(document.createTextNode(`version ${report.version} · `));
  if (report.format === 'legacy') summary.append(el('span', 'tag warn', 'legacy'));
  else summary.append(el('span', 'tag', 'bundle'));

  // Which version line this joined. Worth showing even when the bundle named it itself: this
  // is what every node reporting this version will be classified as from now on.
  if (result.system) {
    summary.append(document.createTextNode(' · '));
    const tag = el('span', 'tag', result.system);
    tag.title = report.declaredSystems?.length
      ? 'Stamped into the manifests by the build.'
      : report.release?.system
        ? 'Declared by release.json in the bundle.'
        : 'The bundle named no system, so it went to the default.';
    summary.append(tag);
  }

  summary.append(document.createTextNode(` · ${report.platforms.join(', ') || 'no platform'}`));
  head.append(summary);

  // Which channel is handing this out, right here — the Publish tab is where an operator is
  // standing when they ask, and a notice banner that fades answers it for four seconds.
  const release = { system: result.system, version: report.version };
  const standing = el('p', 'hint');
  standing.append(document.createTextNode(`${standingLabel(release)} `));
  for (const tag of channelStanding(release)) {
    standing.append(tag, document.createTextNode(' '));
  }
  head.append(standing);

  // From release.json, if the bundle carried one.
  const meta = report.release;
  if (meta && (meta.minVersion || meta.notes || meta.mandatory)) {
    const line = el('p', 'hint');
    const bits = [];
    if (meta.minVersion) bits.push(`min_version ${meta.minVersion}`);
    if (meta.mandatory) bits.push('mandatory');
    line.textContent = bits.join(' · ') + (meta.notes ? ` — ${meta.notes}` : '');
    head.append(line);
  }

  if (report.cores.length) {
    head.append(el('h3', '', 'Core'));
    head.append(table(
      ['Platform', 'Path', 'Slice version', 'Plugins inside'],
      report.cores.map((core) => [
        core.platform,
        core.path,
        core.slice_version ?? '—',
        String((core.bundled_plugins ?? []).length),
      ]),
    ));
  }

  const inside = bundledPluginRows(report);
  if (inside.length) {
    head.append(el('h3', '', `Plugins inside the core (${inside.length})`));
    head.append(el('p', 'hint',
      'Replaced along with the core, reverting anything installed by hand on the device.'));
    head.append(bundledPluginTable(inside));
  }

  head.append(el('h3', '', 'Plugins'));
  if (report.plugins.length) {
    head.append(table(
      ['Name', 'Platform', 'Version', 'Runs on'],
      report.plugins.map((plugin) => [
        plugin.name,
        plugin.platform,
        plugin.version_known ? plugin.version : unknownTag(plugin.version),
        systemScope(plugin.systems, result.system),
      ]),
    ));
  } else {
    // Saying "none" beats an absent section: an operator who expected plugin updates needs to
    // know the bundle declares none, not wonder whether the panel just did not render.
    const why = report.format === 'legacy'
      ? 'This package declares no plugin components — a legacy single-directory package cannot '
        + 'carry any. Only the plugins listed inside the core above are shipped, and they are '
        + 'not independently versioned.'
      : 'This bundle declares no plugin components, so no plugin is updated on its own.';
    head.append(el('p', 'hint', why));
  }

  head.append(el('h3', '', 'Config components'));
  head.append(configTable(report.configs));

  // Different thing, different risk: a directory replacement overwrites every unlocked param
  // on the device, not just the ones a component names. Core and plugins both do it.
  head.append(el('h3', '', 'Config shipped inside the core and plugins'));
  head.append(shippedConfigSection(report));

  if (report.warnings.length) {
    head.append(el('h3', '', `Warnings (${report.warnings.length})`));
    const list = el('ul', 'findings');
    for (const warning of report.warnings) list.append(el('li', '', warning.message));
    head.append(list);
  }

  panel.append(head);
  if (result.diff) panel.append(renderDiff(result.diff, report.version));
}

/**
 * Config rendered the way the engine's own System Config screen does it: one collapsible
 * section per group, with a count, then the params inside.
 *
 * A dotted param is "<group>.<key>" — the same shape the node stores — so the group is simply
 * everything before the first dot. A key with no dot is its own top-level param.
 */
function splitParam(param) {
  const dot = param.indexOf('.');
  return dot === -1 ? ['', param] : [param.slice(0, dot), param.slice(dot + 1)];
}

function groupParams(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const [group, key] = splitParam(entry.param);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ ...entry, key });
  }
  return groups;
}

/** One collapsible group, with its rows. `columns` names the extra cell each row carries. */
function configGroup(name, rows, extraHeader) {
  const section = el('div', 'cfg-psec');

  const header = el('div', 'cfg-sec-hdr');
  const arrow = el('span', 'cfg-sec-arr', '▾');
  header.append(arrow, el('span', 'cfg-sec-lbl', name || '(top level)'),
    el('span', 'cfg-sec-cnt', String(rows.length)), el('span', 'cfg-sec-line'));

  const body = el('div', 'cfg-param-rows');
  const head = el('div', 'cfg-prow cfg-prow-hdr');
  head.append(el('div', 'cfg-ph', 'Parameter'), el('div', 'cfg-ph', 'Value'),
    el('div', 'cfg-ph', extraHeader));
  body.append(head);

  for (const row of rows) {
    const line = el('div', 'cfg-prow');
    line.append(el('div', 'cfg-pr-key', row.key));

    const value = el('div', 'cfg-pr-val');
    value.append(formatValue(row.value));
    line.append(value);

    const extra = el('div', 'cfg-pr-lock');
    extra.append(row.extra);
    line.append(extra);

    body.append(line);
  }

  header.addEventListener('click', () => {
    const collapsed = body.hidden;
    body.hidden = !collapsed;
    arrow.classList.toggle('col', !collapsed);
  });

  section.append(header, body);
  return section;
}

/** A named owner — a config target, or the core / a plugin — and its groups beneath it. */
function configOwner(owner, entries, extraHeader) {
  const wrap = el('div', 'cfg-owner');
  wrap.append(el('h4', '', owner));
  for (const [group, rows] of groupParams(entries)) {
    wrap.append(configGroup(group, rows, extraHeader));
  }
  return wrap;
}

/**
 * Params the bundle's config components set. The node writes only these, and skips any the
 * device has locked.
 */
function configTable(configs) {
  const owners = new Map();
  for (const entry of configs ?? []) {
    if (!entry.params?.length) continue;
    if (!owners.has(entry.target)) owners.set(entry.target, []);
    owners.get(entry.target).push(...entry.params.map((change) => ({
      param: change.param, value: change.value, extra: el('span', 'tag ok', 'sets'),
    })));
  }

  if (!owners.size) return el('p', 'hint', 'This bundle sets no config params.');

  const wrap = el('div');
  for (const [target, entries] of owners) wrap.append(configOwner(target, entries, 'Effect'));
  return wrap;
}

/** The same, for an artifact already in the catalog. */
function storedConfigTable(config) {
  const owners = new Map();
  for (const [platform, changes] of Object.entries(config ?? {})) {
    for (const change of changes) {
      const owner = `${change.target} · ${platform}`;
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push({
        param: change.param, value: change.to, extra: el('span', 'tag ok', 'sets'),
      });
    }
  }

  if (!owners.size) return el('p', 'hint', 'No config params recorded for this artifact.');

  const wrap = el('div');
  for (const [owner, entries] of owners) wrap.append(configOwner(owner, entries, 'Effect'));
  return wrap;
}

/**
 * Config that rides inside a core or plugin slice, rather than being declared as a config
 * component.
 *
 * This is the more dangerous of the two and it is easy to miss, because nothing in the bundle
 * manifest mentions it. A component names the params it sets and the node writes only those;
 * a slice carries a whole config/ directory, and installing it replaces the file the device
 * has. Every param in it that the device has not locked takes the package value — including
 * ones nobody meant to change, like update.server_url on a stock build.
 *
 * Locked params survive: the node refuses to overwrite them (is_frozen_param). That is the
 * distinction the right-hand column draws, so an operator can see at a glance which of these
 * values will actually land.
 */
function shippedConfigSection(report) {
  if (!report) {
    return el('p', 'hint', 'This artifact was uploaded before the server inspected bundles, '
      + 'so there is no record of what it ships.');
  }

  const owners = new Map();
  const wholesale = [];

  const add = (owner, file) => {
    for (const entry of file.params ?? []) {
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push({
        param: entry.param,
        value: entry.value,
        extra: entry.locked
          ? el('span', 'tag ok', 'locked — kept')
          : el('span', 'tag warn', 'replaced'),
      });
    }
    // ota_keys.json and friends: shipped, no params, still replaces what is on the device.
    if (!file.params?.length) wholesale.push(`${owner} · ${file.file}`);
  };

  for (const core of report.cores ?? []) {
    for (const file of core.shipped_config ?? []) {
      // A plugin folder inside the core slice is replaced along with the core, so name it
      // rather than filing its config under "core".
      add(file.plugin ? `${file.plugin} · ${core.platform}` : `core · ${core.platform}`, file);
    }
  }

  for (const plugin of report.plugins ?? []) {
    for (const file of plugin.shipped_config ?? []) {
      add(`${plugin.name} · ${plugin.platform}`, file);
    }
  }

  if (!owners.size && !wholesale.length) {
    return el('p', 'hint', 'No config/ directory rides inside the core or any plugin. Only the '
      + 'config components above change anything on the device.');
  }

  const wrap = el('div');
  for (const [owner, entries] of owners) wrap.append(configOwner(owner, entries, 'On update'));

  if (wholesale.length) {
    wrap.append(el('p', 'hint',
      `Also replaced, with no params to show: ${wholesale.join(', ')}.`));
  }
  return wrap;
}

function formatValue(value) {
  return el('code', '', value === undefined ? '—' : JSON.stringify(value));
}

/**
 * Everything recorded about one artifact, on demand from the Catalog tab: the params it sets,
 * the plugins it carries, and the inspection report kept from the upload.
 */
async function showArtifactDetails(artifact) {
  const panel = $('artifact-details');
  panel.replaceChildren();
  panel.hidden = false;

  const full = await request(`/admin/api/artifacts/${artifact.id}`);

  const card = el('div', 'card');
  const title = el('h2', '', `${full.version} · ${full.kind}${full.platform ? ` (${full.platform})` : ''}`);
  card.append(title);

  const close = el('button', 'link', 'Close');
  close.addEventListener('click', () => { panel.hidden = true; });
  title.append(document.createTextNode(' '), close);

  card.append(el('p', 'hint',
    `${full.file} · ${bytes(full.size)} · sha256 ${full.sha256}`));

  // Two different things, and an operator needs both: what this release SETS, and what it
  // would overwrite wholesale.
  card.append(el('h3', '', 'Config params set by this release'));
  card.append(el('p', 'hint',
    'From the bundle\'s config components. The node writes only these, and skips any the '
    + 'device has locked.'));
  card.append(storedConfigTable(full.config));

  card.append(el('h3', '', 'Config shipped inside the core and plugins'));
  card.append(shippedConfigSection(full.inspection));

  card.append(el('h3', '', 'Plugins'));
  const pluginRows = [];
  for (const [platform, entries] of Object.entries(full.plugins ?? {})) {
    for (const [name, version] of Object.entries(entries)) {
      const unknown = (full.plugins_unknown ?? []).includes(`${platform}/${name}`);
      pluginRows.push([name, platform, unknown ? unknownTag(version) : version]);
    }
  }
  card.append(pluginRows.length
    ? table(['Name', 'Platform', 'Version'], pluginRows)
    : el('p', 'hint', 'No plugin components.'));

  if (full.inspection) {
    const report = full.inspection;
    if (report.cores?.length) {
      card.append(el('h3', '', 'Core'));
      card.append(table(
        ['Platform', 'Path', 'Slice version', 'Plugins inside'],
        report.cores.map((core) => [
          core.platform, core.path, core.slice_version ?? '—',
          String((core.bundled_plugins ?? []).length),
        ]),
      ));

      const inside = bundledPluginRows(report);
      if (inside.length) {
        card.append(el('h3', '', `Plugins inside the core (${inside.length})`));
        card.append(bundledPluginTable(inside));
      }
    }
    if (report.warnings?.length) {
      card.append(el('h3', '', `Warnings (${report.warnings.length})`));
      const list = el('ul', 'findings');
      for (const warning of report.warnings) list.append(el('li', '', warning.message));
      card.append(list);
    }
  } else {
    card.append(el('p', 'hint',
      'No inspection report: this artifact was uploaded before the server opened bundles.'));
  }

  panel.append(card);
  panel.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Render what promoting this artifact would change, compared with the release below it.
 * Unchanged rows are kept: "this plugin does NOT move" is exactly what someone reviewing a
 * release needs to see, and it is the only way to notice a release that changes nothing.
 */
function renderDiff(diff, version) {
  const card = el('div', 'card');
  card.append(el('h2', '', 'Changes'));

  if (diff.isFirst) {
    card.append(el('p', 'hint', `${version} is the first release; there is nothing to compare against.`));
    return card;
  }
  if (diff.noComparable) {
    card.append(el('p', 'hint',
      `The previous release ${diff.previousVersion} has no comparable artifact.`));
    return card;
  }

  const head = el('p', 'hint', `Against ${diff.previousVersion}`);
  if (diff.no_op) {
    head.append(document.createTextNode(' · '));
    const tag = el('span', 'tag warn', 'changes nothing');
    tag.title = 'Every node would download this and report skipped/same_version.';
    head.append(tag);
  }
  card.append(head);

  const platforms = [
    ...diff.platforms.added.map((p) => [p, 'added']),
    ...diff.platforms.removed.map((p) => [p, 'removed']),
  ];
  if (platforms.length) {
    card.append(el('h3', '', 'Platforms'));
    card.append(table(['Platform', ''], platforms.map(([p, c]) => [p, changeTag(c)])));
  }

  if (diff.cores.length) {
    card.append(el('h3', '', 'Core'));
    card.append(table(['Platform', 'From', 'To', ''], diff.cores.map((core) => [
      core.platform, core.from ?? '—', core.to, changeTag(core.change),
    ])));
  }

  if (diff.plugins.length) {
    card.append(el('h3', '', 'Plugins'));
    card.append(table(['Plugin', 'Platform', 'From', 'To', ''], diff.plugins.map((p) => [
      p.name, p.platform, p.from ?? '—', p.to ?? '—', changeTag(p.change),
    ])));
  }

  if (diff.config.length) {
    card.append(el('h3', '', 'Config'));
    card.append(table(['Target', 'Param', 'Platform', 'From', 'To', ''], diff.config.map((c) => [
      c.target, c.param, c.platform, format(c.from), format(c.to), changeTag(c.change),
    ])));
  }

  return card;
}

const CHANGE_CLASS = {
  added: 'tag ok', upgraded: 'tag ok', removed: 'tag warn',
  downgraded: 'tag warn', changed: 'tag warn', updated: 'tag ok', unchanged: 'tag',
};

function changeTag(change) {
  return el('span', CHANGE_CLASS[change] ?? 'tag', change);
}

const format = (value) => (value === null || value === undefined ? '—' : JSON.stringify(value));

/**
 * The bundle has been read and nothing has been written.
 *
 * This is the only screen in the app that describes something which does not exist yet, so it
 * has to say so plainly. It looks exactly like the panel that used to appear AFTER the write,
 * and an operator who reads it as "done" would walk away leaving the file in a temp directory
 * that gets swept within the hour.
 */
function showCommit(result) {
  const wrap = $('commit-wrap');
  wrap.hidden = false;
  wrap.dataset.token = result.token;

  $('commit-title').textContent = `Store ${result.version} and put it on beta?`;

  $('commit-hint').textContent = result.diff?.no_op
    ? `Nothing is stored yet. ${result.version} changes nothing compared with `
      + `${result.diff.previousVersion} — every node would download it and report `
      + 'skipped/same_version.'
    : 'Nothing is stored yet. Storing it puts it on beta, where only devices set to beta are '
      + 'offered it. The rest of the fleet is untouched until you promote it from the Catalog.';

  wrap.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Step two. Everything above this point was a preview: the bundle is open and described, and
 * nothing has been written. This is the click that stores it.
 */
$('commit-upload').addEventListener('click', () => guard(async () => {
  const token = $('commit-wrap').dataset.token;
  if (!token) return;

  const result = await request(`/admin/api/uploads/${token}`, { method: 'POST' });

  $('commit-wrap').hidden = true;
  showNotice(`${result.version} stored and live on ${result.promoted_to} — the test group only`);
  await loadCatalog();
  renderInspection(result);
  renderCatalog();
}));

$('commit-discard').addEventListener('click', () => {
  // Nothing to undo on the server: the staged file is never referenced again and the pruner
  // sweeps it within the hour.
  $('commit-wrap').hidden = true;
  $('inspection').hidden = true;
  showNotice('Discarded — nothing was stored');
});

/**
 * Plugins that ride inside a core slice, one row each.
 *
 * A comma-joined cell was unreadable past a handful, and a runtime slice routinely carries
 * several — so they get a table, with the version each one reports.
 */
function bundledPluginRows(report) {
  const rows = [];
  for (const core of report?.cores ?? []) {
    for (const plugin of core.bundled_plugins ?? []) {
      rows.push({ platform: core.platform, coreSystem: core.system, ...plugin });
    }
  }
  return rows;
}

/**
 * Which products a plugin declares it runs on.
 *
 * A plugin is often valid on several — the build writes a list, and the node reads it with
 * system_covers(). Printing that list on every row would be noise on a fleet with one system,
 * so this says something only when there is something to say: shared with other systems, valid
 * everywhere, or — the one that matters — not valid here at all.
 */
function systemScope(systems, bundleSystem) {
  const declared = systems ?? [];

  // Absent or empty is "compatible with everything", the same reading the node gives it.
  if (!declared.length) {
    const tag = el('span', 'hint', 'any');
    tag.title = 'This plugin declares no system, so it installs on every product.';
    return tag;
  }

  if (!bundleSystem) return el('span', '', declared.join(', '));

  if (!declared.includes(bundleSystem)) {
    const tag = el('span', 'tag warn', declared.join(', '));
    tag.title = `Does not cover ${bundleSystem}. The node will skip this plugin.`;
    return tag;
  }

  const others = declared.filter((name) => name !== bundleSystem);
  if (!others.length) return el('span', 'hint', '—');

  const tag = el('span', 'tag', `+ ${others.join(', ')}`);
  tag.title = `Also built for ${others.join(', ')}, and shipped again in those bundles.`;
  return tag;
}

function bundledPluginTable(rows) {
  const wrap = el('div');
  wrap.append(el('p', 'hint',
    'Replaced wholesale when the core updates, and not independently versioned — a plugin an '
    + 'operator installed by hand is reverted.'));
  wrap.append(table(
    ['Plugin', 'Platform', 'Version', 'Runs on'],
    rows.map((row) => [
      row.name,
      row.platform,
      row.version_known ? row.version : missingVersionTag(row.version),
      systemScope(row.systems, row.coreSystem),
    ]),
  ));
  return wrap;
}

/** No manifest.json in the plugin folder, so the slice does not record its version. */
function missingVersionTag(version) {
  const tag = el('span', 'tag warn', version ?? 'not recorded');
  tag.title = version
    ? 'Reported by the plugin but not a dotted numeric version, so it cannot be ordered.'
    : 'This plugin folder has no manifest.json, so the slice does not record its version.';
  return tag;
}

function unknownTag(version) {
  const span = el('span', 'tag warn', version ?? 'unknown');
  span.title = 'Built with no version define. It cannot be ordered against what a node is '
    + 'running; set it by hand from the artifact metadata form.';
  return span;
}

/**
 * A null bundle_format means the row predates inspection — which is NOT the same as legacy,
 * so it must not be labelled as one.
 */
function formatCell(artifact) {
  const wrap = el('span');

  if (!artifact.bundle_format) {
    const dash = el('span', 'hint', '—');
    dash.title = 'Uploaded before the server inspected bundles.';
    wrap.append(dash);
    return wrap;
  }

  wrap.append(el('span', artifact.bundle_format === 'legacy' ? 'tag warn' : 'tag',
    artifact.bundle_format));

  if (artifact.warning_count) {
    const button = el('button', 'link', `${artifact.warning_count} warning`
      + (artifact.warning_count === 1 ? '' : 's'));
    button.addEventListener('click', () => guard(async () => {
      renderInspection(await request(`/admin/api/artifacts/${artifact.id}`));
      $('inspection').scrollIntoView({ behavior: 'smooth' });
    }));
    wrap.append(document.createTextNode(' '), button);
  }

  return wrap;
}

function renderPlatformBoxes() {
  const container = $('platform-boxes');
  container.replaceChildren();

  for (const platform of KNOWN_PLATFORMS) {
    const label = el('label', 'platform');
    const input = document.createElement('input');
    // Always checkboxes: this is a cross-check against the bundle, not a choice.
    input.type = 'checkbox';
    input.name = 'platform';
    input.value = platform;
    label.append(input, document.createTextNode(` ${platform}`));
    container.append(label);
  }
}

$('browse').addEventListener('click', () => $('u-file').click());
$('u-file').addEventListener('change', () => pickFile($('u-file').files[0]));

const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('over');
  pickFile(event.dataTransfer.files[0]);
});

function pickFile(file) {
  selectedFile = file ?? null;
  $('filename').textContent = file ? `${file.name} — ${bytes(file.size)}` : '';
}

$('upload-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runUpload();
});

$('retry-upload').addEventListener('click', () => {
  const chosen = [...document.querySelectorAll('#platform-boxes input:checked')]
    .map((input) => input.value);
  if (!chosen.length) {
    showError('Select at least one platform.');
    return;
  }
  runUpload(chosen);
});

/**
 * The whole publish flow. Nothing is asked for: the bundle names its own version, platforms,
 * plugin versions and config params, and the server promotes it. `platforms` is passed only
 * on the retry after a config-only bundle turned out to name none.
 */
function runUpload(platforms = null) {
  guard(async () => {
    if (!selectedFile) throw new ApiError(400, 'missing_parameter', 'Choose a file first');

    const query = platforms ? `?platforms=${encodeURIComponent(platforms.join(','))}` : '';

    $('progress-wrap').hidden = false;
    $('progress-text').textContent = 'Hashing…';
    // Hashing locally lets the server reject a corrupted transfer before it is stored.
    const digest = await sha256(selectedFile);

    let result;
    try {
      result = await upload(`/admin/api/uploads${query}`, selectedFile, {
        expectedSha256: digest,
        onProgress: (loaded, total) => {
          const percent = Math.round((loaded / total) * 100);
          $('progress-bar').style.width = `${percent}%`;
          $('progress-text').textContent = `${percent}% — ${bytes(loaded)} / ${bytes(total)}`;
        },
      });
    } catch (err) {
      // The one case the bundle genuinely cannot answer for itself.
      if (err.details?.some((f) => f.rule === 'config_only_needs_platforms')) {
        $('platform-prompt').hidden = false;
        $('platform-prompt').scrollIntoView({ behavior: 'smooth' });
      }
      throw err;
    }

    $('platform-prompt').hidden = true;
    $('progress-text').textContent = `Read. sha256 ${result.sha256}`;
    $('progress-bar').style.width = '100%';
    renderInspection(result);
    pickFile(null);
    $('u-file').value = '';

    showCommit(result);
  }).finally(() => {
    setTimeout(() => { $('progress-wrap').hidden = true; $('progress-bar').style.width = '0%'; }, 4000);
  });
}

// ── systems ───────────────────────────────────────────────────────────────────────────────

let unclassified = [];

async function loadSystems() {
  const [list, pending] = await Promise.all([
    request('/admin/api/systems'),
    request('/admin/api/unclassified'),
  ]);
  catalog.systems = list.systems;
  unclassified = pending.nodes;
  renderSystems();
}

/**
 * What one of a system's two channels is handing out.
 *
 * Every system has exactly `beta` and `stable`, so there is nothing to list — only two values
 * to read. This replaces the Channels tab, which existed to manage a set that is now closed.
 */
function servedBy(system, name) {
  const channel = (catalog.channels ?? []).find((c) => c.system === system && c.name === name);
  if (!channel?.latest) return el('span', 'hint', '—');
  return el('span', name === 'stable' ? 'tag ok' : 'tag', channel.latest);
}

function renderSystems() {
  const container = $('system-list');
  container.replaceChildren();

  // Nodes asking for a channel their system does not have. They receive a valid 204 and show
  // no error, so this panel is the only place it surfaces. It lived on the Channels tab; that
  // tab is gone, and channels now live here.
  for (const stray of catalog.stray_channels ?? []) {
    const warn = el('p', 'error banner');
    warn.textContent = `${stray.nodes} node(s) are asking for channel "${stray.channel}" on `
      + `system ${stray.system}, which has no such channel. They are being told they are up `
      + `to date. Last seen ${when(stray.last_seen)}.`;
    container.append(warn);
  }

  container.append(table(
    ['System', 'Description', 'Releases', 'beta', 'stable', ''],
    (catalog.systems ?? []).map((system) => [
      system.name,
      system.description ?? el('span', 'hint', '—'),
      String(system.releases),
      servedBy(system.name, 'beta'),
      servedBy(system.name, 'stable'),
      systemActions(system),
    ]),
  ));

  renderUnclassified();
}

function systemActions(system) {
  const wrap = el('div', 'row-actions');
  const remove = el('button', 'ghost danger', 'Delete');

  // Refused server-side while releases remain; saying so here saves a round trip.
  if (system.releases > 0) {
    remove.disabled = true;
    remove.title = `${system.releases} release(s) still belong to this system.`;
  }

  remove.addEventListener('click', () => guard(async () => {
    if (!window.confirm(`Delete system ${system.name}?`)) return;
    await request(`/admin/api/systems/${system.name}`, { method: 'DELETE' });
    showNotice(`Deleted system ${system.name}`);
    await loadSystems();
  }));

  wrap.append(remove);
  return wrap;
}

/**
 * What the node claimed to be, which is usually why it could not be placed.
 *
 * A build stamps its system into the runtime manifest and the node sends it on every check.
 * When that name is one this server does not have, the claim IS the diagnosis — a typo in a
 * build script reads as "says it is HERA-2" and nothing else has to be worked out. A node that
 * sent nothing is a different situation: an older, unstamped build, not a wrong one.
 */
function claimedSystem(node) {
  if (!node.reported_system) return el('span', 'hint', 'did not say');

  const known = catalog.systems.some((system) => system.name === node.reported_system);
  const tag = el('span', known ? 'tag' : 'tag warn', node.reported_system);
  tag.title = known
    ? 'This system exists, so the node was parked for another reason — usually its version '
      + 'belongs to a different system.'
    : 'No system by that name here. Create it, or fix the build that stamped it.';
  return tag;
}

function renderUnclassified() {
  const pending = unclassified.filter((node) => !node.assigned_system);
  $('unclassified-count').textContent = pending.length
    ? `${pending.length} waiting` : 'none waiting';

  const container = $('unclassified-list');
  container.replaceChildren();
  container.append(table(
    ['Serial', 'Platform', 'Version', 'Says it is', 'Seen', 'Assigned to', ''],
    unclassified.map((node) => [
      node.serial,
      node.platform ?? '—',
      node.version ?? '—',
      claimedSystem(node),
      `${node.seen_count}× · ${when(node.last_seen)}`,
      node.assigned_system
        ? el('span', 'tag ok', node.assigned_system)
        : el('span', 'tag warn', 'unplaced'),
      assignActions(node),
    ]),
  ));
}

function assignActions(node) {
  const wrap = el('div', 'row-actions');

  const select = document.createElement('select');
  select.append(new Option('choose a system…', ''));
  for (const system of catalog.systems ?? []) {
    select.append(new Option(system.name, system.name));
  }
  if (node.assigned_system) select.value = node.assigned_system;

  const assign = el('button', 'ghost', 'Assign');
  assign.addEventListener('click', () => guard(async () => {
    if (!select.value) throw new ApiError(400, 'missing_parameter', 'Choose a system first');
    await request(`/admin/api/unclassified/${encodeURIComponent(node.serial)}`, {
      method: 'PUT', body: { system: select.value },
    });
    showNotice(`${node.serial} assigned to ${select.value}`);
    await loadSystems();
  }));

  const forget = el('button', 'ghost danger', 'Forget');
  forget.addEventListener('click', () => guard(async () => {
    await request(`/admin/api/unclassified/${encodeURIComponent(node.serial)}`, { method: 'DELETE' });
    await loadSystems();
  }));

  wrap.append(select, assign, forget);
  return wrap;
}

$('system-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(async () => {
    await request('/admin/api/systems', {
      method: 'POST',
      body: { name: $('s-name').value.trim(), description: $('s-desc').value.trim() || undefined },
    });
    showNotice(`Created system ${$('s-name').value.trim()}`);
    $('system-form').reset();
    await loadSystems();
  });
});

// ── channels ──────────────────────────────────────────────────────────────────────────────


// ── fleet, rollout, security ──────────────────────────────────────────────────────────────

function loadFleet() {
  guard(async () => {
    const { nodes } = await request('/admin/api/fleet');
    const container = $('fleet-list');
    container.replaceChildren();

    // "Behind" only means something within a node's own system: a drone is not out of date
    // because the GCS line has moved on. Compare against the latest of ITS system.
    const latestOf = new Map();
    for (const channel of catalog.channels ?? []) {
      if (!channel.latest) continue;
      if (!latestOf.has(channel.system)) latestOf.set(channel.system, new Set());
      latestOf.get(channel.system).add(channel.latest);
    }

    container.append(table(
      ['Serial', 'System', 'Platform', 'Running', 'Role', 'Channel', 'Last seen'],
      nodes.map((node) => {
        const live = latestOf.get(node.system);
        const behind = live && live.size && !live.has(node.version);
        const running = el('span', behind ? 'tag warn' : 'tag', node.version ?? '—');

        // No system means the version matched no release and no admin has placed this node,
        // so it is being answered "no update" every time it asks. That is the one state on
        // this screen an operator has to act on, so it links to where the action is.
        const system = node.system
          ? el('span', 'tag', node.system)
          : el('span', 'tag warn', 'unplaced');
        if (!node.system) {
          system.title = 'This node is offered nothing until it is assigned a system. '
            + 'Place it on the Systems tab.';
        }

        return [node.serial, system, node.platform, running, node.role, node.channel,
          when(node.at)];
      }),
    ));
  });
}

function loadRollout() {
  guard(async () => {
    const version = $('ro-version').value;
    const data = await request(`/admin/api/reports${version ? `?version=${version}` : ''}`);

    $('rollout-stats').replaceChildren(table(
      ['Result', 'Error', 'Count'],
      data.stats.map((row) => [
        el('span', row.result === 'success' ? 'tag ok' : 'tag warn', row.result ?? '—'),
        row.error,
        String(row.count),
      ]),
    ));

    $('rollout-recent').replaceChildren(table(
      ['Serial', 'Platform', 'From', 'To', 'Result', 'Error', 'When'],
      data.recent.map((row) => [
        row.serial, row.platform, row.from_version, row.to_version,
        el('span', row.result === 'success' ? 'tag ok' : 'tag warn', row.result ?? '—'),
        row.error, when(row.received_at),
      ]),
    ));
  });
}

$('rollout-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadRollout();
});

function definitions(target, pairs) {
  const dl = $(target);
  dl.replaceChildren();
  for (const [term, value] of pairs) {
    dl.append(el('dt', null, term));
    dl.append(el('dd', null, value ?? '—'));
  }
}

/**
 * The fleet keys, with a way to copy one without selecting it by hand.
 *
 * Shown in full rather than masked: the only reason to open this card is to put the value into
 * a device, and a mask that has to be revealed is a click that teaches nothing. The audit entry
 * is what makes the read accountable, not the UI hiding it.
 */
function renderApiKeys(fleet) {
  const container = $('api-keys');
  container.replaceChildren();

  if (!fleet.keys.length) {
    container.append(el('p', 'error banner',
      'No UPDATE_API_KEYS is configured, so no node can authenticate. Every fleet request '
      + 'answers 401 until one is set.'));
    return;
  }

  container.append(table(
    ['Fleet', 'X-API-Key', ''],
    fleet.keys.map((entry) => [
      entry.fleet,
      el('code', '', entry.key),
      copyButton(entry.key),
    ]),
  ));
}

function copyButton(value) {
  const button = el('button', 'ghost', 'Copy');
  button.addEventListener('click', () => {
    // clipboard.writeText needs a secure context, which this always is — the admin UI refuses
    // plaintext with 426 before any of this loads.
    navigator.clipboard.writeText(value).then(
      () => showNotice('Copied to the clipboard'),
      () => showError('Could not copy — select the value and copy it by hand'),
    );
  });
  return button;
}

/**
 * Accounts, when Keycloak is wired up. The panel stays hidden otherwise rather than
 * showing controls that cannot work — the endpoint says which case it is.
 */
function renderUsers(payload) {
  const card = $('users-card');
  if (!payload.configured) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('users-list').replaceChildren(table(
    ['Username', 'Email', 'Enabled', 'Created'],
    payload.users.map((u) => [u.username, u.email ?? '—', u.enabled ? 'yes' : 'no', when(u.created_at)]),
  ));
}

function loadSecurity() {
  guard(async () => {
    const [key, tls, audit, fleet, users] = await Promise.all([
      request('/admin/api/signing-key'),
      request('/admin/api/tls'),
      request('/admin/api/audit?limit=100'),
      request('/admin/api/api-keys'),
      request('/admin/api/users'),
    ]);

    renderApiKeys(fleet);
    renderUsers(users);

    definitions('signing-key', [
      ['key_id', key.key_id],
      ['Algorithm', key.algorithm],
      // Null once SIGNING_REQUIRE_PRESIGNED is on: the goal state is a server that holds
      // no private key at all, which is a fact worth stating rather than a blank.
      ['Public key (base64)', key.public_key_base64 ?? '— (no local key: artifacts are pre-signed)'],
      ['Holds a private key', key.holds_private_key ? 'yes' : 'no'],
      ['Private key file', key.key_file ?? '—'],
    ]);

    definitions('tls-info', [
      ['Subject', tls.subject],
      ['Issuer', tls.issuer],
      ['Self-signed', tls.selfSigned ? 'yes — nodes and browsers must trust it explicitly' : 'no'],
      ['Subject alternative names', tls.subjectAltName],
      ['SHA-256 fingerprint', tls.fingerprint256],
      ['Valid until', `${tls.validTo ?? '—'} (${tls.daysRemaining ?? '?'} days)`],
    ]);

    $('audit-list').replaceChildren(table(
      ['When', 'Actor', 'Action', 'Subject'],
      audit.entries.map((entry) => [when(entry.at), entry.actor, entry.action, entry.subject]),
    ));
  });
}

$('new-user-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(async () => {
    const created = await request('/admin/api/users', {
      method: 'POST',
      body: {
        username: $('u-name').value.trim(),
        email: $('u-email').value.trim(),
        password: $('u-pass').value,
      },
    });
    // Clear the password field first — it is a live credential until it is used once.
    $('u-pass').value = '';
    $('u-name').value = '';
    $('u-email').value = '';
    // window.alert, as the password form does — this UI has no toast of its own, and the
    // "no roles yet" part is exactly the thing that must not be missed.
    window.alert(`Created ${created.username}.\n\n${created.note}`);
    loadSecurity();
  });
});

$('password-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(async () => {
    await request('/admin/api/auth/password', {
      method: 'POST',
      body: {
        current_password: $('p-current').value,
        new_password: $('p-new').value,
      },
    });
    window.alert('Password changed. Every session was signed out — please sign in again.');
    signOut();
  });
});

// ── boot ──────────────────────────────────────────────────────────────────────────────────

async function start() {
  // The access token never survives a page load; the HttpOnly refresh cookie does.
  if (!await refresh()) return signOut();

  const me = await request('/admin/api/auth/me');
  $('whoami').textContent = me.username;

  renderPlatformBoxes();
  await guard(loadCatalog);
  return undefined;
}

start().catch((err) => showError(err.message));

export { getUser };
