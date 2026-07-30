import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * Execute the admin UI's render functions against a stub DOM.
 *
 * Nothing else in this suite runs a line of public/admin/app.js. `node --check` parses it and
 * scripts/check-refs.mjs resolves its names, but neither proves a render function produces the
 * right thing — or produces anything at all rather than throwing on the first field whose
 * shape it guessed wrong. That gap is how `shippedConfigSection` shipped: called from two
 * places, defined in none, and no test ever entered the branch.
 *
 * The module is run in a vm rather than imported because its render functions are internal by
 * design; the trailing line below is the only export the test needs.
 */

/**
 * A real class, because `table()` branches on `cell instanceof Node` to tell an element from a
 * string. Plain object literals would fail that test and every element would be rendered as
 * its own `[object Object]`.
 */
class Node {}

/** The smallest DOM these functions actually touch. */
function makeDom() {
  const make = (tag) => {
    const node = Object.assign(new Node(), {
      tag,
      className: '',
      textContent: '',
      hidden: false,
      title: '',
      children: [],
      style: {},
      dataset: {},
      classList: {
        add() {}, remove() {}, toggle() {}, contains: () => false,
      },
      // A <select> reports the first option until something assigns to it, which is what
      // makes "the button must name the target" testable at all.
      value: '',
      append(...kids) {
        node.children.push(...kids);
        if (!node.value) node.value = kids.find((k) => k?.tag === 'option')?.value ?? node.value;
      },
      appendChild(kid) { node.children.push(kid); return kid; },
      replaceChildren(...kids) { node.children = kids; if (!kids.length) node.value = ''; },
      addEventListener() {},
      querySelectorAll: () => [],
      remove() {},
      scrollIntoView() {},
    });
    return node;
  };

  // Stable per id: a renderer that writes into $('channel-list') has to be inspectable
  // afterwards, which a fresh stub every call would make impossible.
  const byId = new Map();

  return {
    createElement: make,
    createTextNode: (text) => Object.assign(new Node(), {
      tag: '#text', textContent: text, children: [],
    }),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, make('div'));
      return byId.get(id);
    },
    addEventListener() {},
    querySelectorAll: () => [],
  };
}

/** Every string in a rendered tree, in document order. */
function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  const own = node.textContent ?? '';
  return own + (node.children ?? []).map(textOf).join(' ');
}

const ui = await (async () => {
  const source = await readFile(new URL('../public/admin/app.js', import.meta.url), 'utf8');

  const sandbox = {
    document: makeDom(),
    Node,
    // fillSelect builds options with `new Option(text, value)`.
    Option: class Option extends Node {
      constructor(text, value) {
        super();
        Object.assign(this, { tag: 'option', textContent: text, value, children: [] });
      }
    },
    window: {
      alert() {}, confirm: () => true, scrollTo() {},
      location: { reload() {}, href: '/admin/' },
    },
    // start() runs on load and immediately calls refresh(); a rejected fetch takes the
    // signed-out path, which is caught. Nothing under test depends on it.
    fetch: () => Promise.reject(new Error('no network in tests')),
    // What ./api.js would have provided. Only refresh() is reached, by start() on load.
    ApiError: class ApiError extends Error {},
    clearSession() {},
    getUser: () => null,
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(false),
    request: () => Promise.reject(new Error('no network in tests')),
    sha256: () => Promise.resolve(''),
    upload: () => Promise.reject(new Error('no network in tests')),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Map,
    Set,
    Error,
  };
  sandbox.globalThis = sandbox;

  // The module's own import and export lines are the only two things a vm cannot run. Both
  // are replaced rather than the file being restructured, so what executes below stays the
  // file that ships.
  const body = source
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/api\.js';/m, 'const {} = {};')
    .replace(/^export \{[^}]*\};?\s*$/m, '');

  // `catalog` and `unclassified` are module-level state the renderers read; the trailing line
  // is in their scope, so it can both expose the renderers and set what they read.
  const harnessed = `${body}
    globalThis.__ui = {
      shippedConfigSection, configOwner, el, bundledPluginRows,
      claimedSystem, renderUnclassified, systemScope, rolloutEvidence, servedBy,
      channelStanding, renderInspection, standingLabel, renderCatalog, channelCell,
      showCommit, renderSystems, kindCell, channelCell, renderApiKeys,
      setChannelLatest,
      setRequest: (fn) => { request = fn; },
      setConfirm: (fn) => { window.confirm = fn; },
      setCatalog: (value) => { catalog = value; },
      setUnclassified: (value) => { unclassified = value; },
    };`;

  vm.runInNewContext(harnessed, sandbox, { filename: 'app.js' });
  return { ...sandbox.__ui, dom: sandbox.document };
})();

// ── shippedConfigSection ──────────────────────────────────────────────────────────────────

const CORE_FILE = {
  file: 'config/AeroCoreEngine.json',
  plugin: null,
  params: [
    { param: 'update.server_url', value: 'https://ota.local', locked: true, readonly: false },
    { param: 'web.port', value: 9090, locked: false, readonly: false },
  ],
};

test('config riding inside a core slice is rendered, split by locked', () => {
  const html = textOf(ui.shippedConfigSection({
    cores: [{ platform: 'linux-x86_64', shipped_config: [CORE_FILE] }],
    plugins: [],
  }));

  assert.match(html, /core · linux-x86_64/);
  assert.match(html, /update/, 'the group name is shown');
  assert.match(html, /server_url/);
  assert.match(html, /locked — kept/, 'a locked param survives the update');
  assert.match(html, /replaced/, 'an unlocked one does not');
});

test('a plugin folder inside the core slice is named, not filed under the core', () => {
  // Its config is replaced along with the core, but saying "core" would send an operator
  // looking in the wrong file.
  const html = textOf(ui.shippedConfigSection({
    cores: [{
      platform: 'linux-x86_64',
      shipped_config: [{
        file: 'plugins/Example_Plugin/config/Example_Plugin.json',
        plugin: 'Example_Plugin',
        params: [{ param: 'general.fps', value: 30, locked: false, readonly: false }],
      }],
    }],
    plugins: [],
  }));

  assert.match(html, /Example_Plugin · linux-x86_64/);
  assert.doesNotMatch(html, /core · linux-x86_64/);
});

test('a plugin component with its own config is rendered too', () => {
  const html = textOf(ui.shippedConfigSection({
    cores: [],
    plugins: [{
      name: 'Camera',
      platform: 'linux-x86_64',
      shipped_config: [{
        file: 'config/Camera.json',
        plugin: null,
        params: [{ param: 'camera.width', value: 1920, locked: false, readonly: false }],
      }],
    }],
  }));

  assert.match(html, /Camera · linux-x86_64/);
  assert.match(html, /width/);
});

test('a shipped file with no params is still reported', () => {
  // ota_keys.json has no params but is replaced wholesale, so dropping it would hide a real
  // overwrite.
  const html = textOf(ui.shippedConfigSection({
    cores: [{
      platform: 'linux-x86_64',
      shipped_config: [{ file: 'config/ota_keys.json', plugin: null, params: [] }],
    }],
    plugins: [],
  }));

  assert.match(html, /ota_keys\.json/);
});

test('a bundle shipping no slice config says so rather than rendering nothing', () => {
  const html = textOf(ui.shippedConfigSection({
    cores: [{ platform: 'linux-x86_64', shipped_config: [] }],
    plugins: [],
  }));

  assert.match(html, /No config\/ directory/);
});

test('an artifact from before inspection existed does not throw', () => {
  // inspection is NULL for every row uploaded before the server opened bundles. That is not
  // the same as "ships nothing", and the panel must not claim it is.
  const html = textOf(ui.shippedConfigSection(null));

  assert.match(html, /before the server inspected bundles/);
  assert.doesNotMatch(html, /No config\/ directory/);
});

test('missing shipped_config keys are tolerated', () => {
  // The field is absent on reports written by an older server version.
  assert.doesNotThrow(() => ui.shippedConfigSection({ cores: [{}], plugins: [{}] }));
  assert.doesNotThrow(() => ui.shippedConfigSection({}));
});

// ── placing a node: what it claimed to be ─────────────────────────────────────────────────

test('an unplaced node shows the system it claimed', () => {
  // The claim is usually the whole diagnosis: "says it is HERA-2" and there is nothing else
  // to work out — the build script has a typo.
  ui.setCatalog({ systems: [{ name: 'HERA' }], channels: [], releases: [] });
  const cell = ui.claimedSystem({ reported_system: 'HERA-2' });

  assert.equal(textOf(cell), 'HERA-2');
  assert.match(cell.className, /warn/, 'a name this server does not have is the alarming case');
  assert.match(cell.title, /No system by that name/);
});

test('a claim naming a real system is not flagged as the problem', () => {
  // It exists, so the node was parked for another reason — its version belongs elsewhere.
  ui.setCatalog({ systems: [{ name: 'HERA' }], channels: [], releases: [] });
  const cell = ui.claimedSystem({ reported_system: 'HERA' });

  assert.equal(textOf(cell), 'HERA');
  assert.doesNotMatch(cell.className, /warn/);
  assert.match(cell.title, /parked for another reason/);
});

test('a node that sent no system is distinguished from one that sent a wrong one', () => {
  // An older, unstamped build. Conflating the two would send an operator hunting a typo that
  // does not exist.
  ui.setCatalog({ systems: [{ name: 'HERA' }], channels: [], releases: [] });
  const cell = ui.claimedSystem({ reported_system: null });

  assert.equal(textOf(cell), 'did not say');
  assert.doesNotMatch(cell.className, /warn/);
});

// ── channels that do not exist for the asking node's system ───────────────────────────────

test('nodes asking for a channel their system lacks are surfaced', () => {
  // update.channel is free text an operator types on the device. Asking for one that does not
  // exist returns a valid 204, identical to being up to date, and the device shows no error.
  ui.setCatalog({
    systems: [{ name: 'HERA' }],
    channels: [{ system: 'HERA', name: 'stable', latest: '0.15.0', paused: false, pins: 0, denies: 0 }],
    stray_channels: [
      { system: 'HERA', channel: 'beta', nodes: 3, last_seen: '2026-07-28T09:00:00Z' },
    ],
    releases: [],
  });

  ui.renderSystems();
  const html = textOf(ui.dom.getElementById('system-list'));

  assert.match(html, /3 node\(s\)/);
  assert.match(html, /"beta"/);
  assert.match(html, /system HERA/);
  assert.match(html, /told they are up to date/, 'the symptom, which is why it goes unnoticed');
});

test('no stray channels means no banner', () => {
  ui.setCatalog({
    systems: [{ name: 'HERA' }],
    channels: [{ system: 'HERA', name: 'stable', latest: '0.15.0', paused: false, pins: 0, denies: 0 }],
    stray_channels: [],
    releases: [],
  });

  ui.renderSystems();
  assert.doesNotMatch(textOf(ui.dom.getElementById('system-list')), /told they are up to date/);
});

test('a catalog from an older server without stray_channels does not throw', () => {
  ui.setCatalog({ systems: [], channels: [], releases: [] });
  assert.doesNotThrow(() => ui.renderSystems());
});

// ── a plugin that runs on several systems ─────────────────────────────────────────────────

test('a plugin declaring no system reads as "any"', () => {
  // Empty means compatible with everything, the same reading system_covers() gives it. It is
  // not missing data, so it must not look like a gap.
  const cell = ui.systemScope([], 'HERA');

  assert.equal(textOf(cell), 'any');
  assert.doesNotMatch(cell.className, /warn/);
});

test('a plugin built only for this bundle\'s system says nothing', () => {
  // The common case. Printing "HERA" on every row of a HERA bundle is noise.
  assert.equal(textOf(ui.systemScope(['HERA'], 'HERA')), '—');
});

test('a plugin shared with other systems names them', () => {
  // Several plugins are valid on more than one product, and an operator changing one needs to
  // know it also ships in another system's bundles.
  const cell = ui.systemScope(['HERA', 'drone', 'rover'], 'HERA');

  assert.equal(textOf(cell), '+ drone, rover');
  assert.doesNotMatch(cell.className, /warn/, 'shared is normal, not a problem');
  assert.match(cell.title, /shipped again in those bundles/);
});

test('a plugin not covering this bundle is flagged', () => {
  const cell = ui.systemScope(['drone'], 'HERA');

  assert.equal(textOf(cell), 'drone');
  assert.match(cell.className, /warn/);
  assert.match(cell.title, /skip this plugin/);
});

test('case matters, because it matters to the node', () => {
  // system_covers() compares with == on std::string.
  const cell = ui.systemScope(['Hera'], 'HERA');
  assert.match(cell.className, /warn/);
});

test('with no bundle system there is nothing to compare against', () => {
  // A config-only bundle names no system, so the list is shown plainly rather than judged.
  assert.equal(textOf(ui.systemScope(['HERA', 'drone'], null)), 'HERA, drone');
});

// ── the evidence shown when promoting ─────────────────────────────────────────────────────

test('no reports is stated plainly, not shown as a clean pass', () => {
  // "0 of 0 failed" reads like a green tick. Nobody having run the build is the opposite of
  // evidence, and this is the panel where someone decides to give it to the whole fleet.
  const html = textOf(ui.rolloutEvidence([]));

  assert.match(html, /No node has reported this version yet/);
  assert.match(html, /nothing here showing it works/);
});

test('an all-success rollout says so without alarm', () => {
  const node = ui.rolloutEvidence([{ result: 'success', error: '(none)', count: 10 }]);

  assert.match(textOf(node), /10 report\(s\), all success/);
  assert.doesNotMatch(textOf(node), /failed/);
});

test('failures are counted and named', () => {
  const node = ui.rolloutEvidence([
    { result: 'success', error: '(none)', count: 10 },
    { result: 'failed', error: 'sha_mismatch', count: 1 },
    { result: 'failed', error: 'config_reconcile_failed', count: 1 },
  ]);
  const html = textOf(node);

  assert.match(html, /12 report\(s\)/);
  assert.match(html, /10 success/);
  assert.match(html, /2 failed/);
  assert.match(html, /sha_mismatch ×1/);
  assert.match(html, /config_reconcile_failed ×1/);
});

test('anything other than success counts against the release', () => {
  // A result the server has never seen before must not be silently counted as a pass; total
  // minus success is the safe direction.
  const html = textOf(ui.rolloutEvidence([
    { result: 'success', error: '(none)', count: 3 },
    { result: 'weird_new_state', error: 'huh', count: 2 },
  ]));

  assert.match(html, /3 success, 2 failed/);
});

// ── pointing a channel at a version, including backwards ──────────────────────────────────

/**
 * Record every request the code under test makes, and reply with what the test wants.
 *
 * Bodies are round-tripped through JSON because app.js runs in a vm realm: its object literals
 * have a different Object.prototype, and deepStrictEqual compares that too.
 */
function stubRequest(replies) {
  const calls = [];
  ui.setRequest(async (url, init) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(init?.body ?? null)) });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? {};
  });
  return calls;
}

const rollbackError = () => Object.assign(new Error('is older'), {
  status: 400,
  code: 'invalid_parameter',
  details: [{ rule: 'channel_rollback', message: 'is older', from: '0.15.0', to: '0.14.0' }],
});

test('a forward move goes straight through', async () => {
  const calls = stubRequest([{}]);
  ui.setConfirm(() => {
    throw new Error('must not ask: moving forward needs no confirmation');
  });

  assert.equal(await ui.setChannelLatest('HERA', 'stable', '0.16.0'), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { latest: '0.16.0' });
});

test('a refused rollback is offered, not left as a dead end', async () => {
  // The server names a flag; if the UI cannot send it, the operator is told what to do and
  // then cannot do it.
  const calls = stubRequest([rollbackError(), {}]);
  let asked = '';
  ui.setConfirm((message) => { asked = message; return true; });

  assert.equal(await ui.setChannelLatest('HERA', 'stable', '0.14.0'), true);

  assert.equal(calls.length, 2, 'retried once the operator agreed');
  assert.deepEqual(calls[1].body, { latest: '0.14.0', allow_rollback: true });
  assert.match(asked, /0\.15\.0/, 'says what it is on now');
  assert.match(asked, /0\.14\.0/);
  assert.match(asked, /provisioned from now on/, 'names the actual consequence');
});

test('declining the rollback sends nothing more', async () => {
  const calls = stubRequest([rollbackError()]);
  ui.setConfirm(() => false);

  assert.equal(await ui.setChannelLatest('HERA', 'stable', '0.14.0'), false);
  assert.equal(calls.length, 1, 'the refusal stands');
});

test('any other error is rethrown untouched', async () => {
  // Only the rollback finding earns the retry. Swallowing anything else would turn a real
  // failure into a confirmation dialog that then fails again.
  const boom = Object.assign(new Error('No release 9.9.9'), {
    status: 400, code: 'invalid_parameter', details: null,
  });
  stubRequest([boom]);
  ui.setConfirm(() => {
    throw new Error('must not ask about an unrelated failure');
  });

  await assert.rejects(() => ui.setChannelLatest('HERA', 'stable', '9.9.9'), /No release/);
});

test('the branch is on the finding, not on the message text', async () => {
  // Rewording the server's message must not break the only path out of the refusal.
  const reworded = Object.assign(new Error('completely different wording'), {
    status: 400,
    code: 'invalid_parameter',
    details: [{ rule: 'channel_rollback', message: 'x', from: '2.0.0', to: '1.0.0' }],
  });
  const calls = stubRequest([reworded, {}]);
  ui.setConfirm(() => true);

  assert.equal(await ui.setChannelLatest('drone', 'stable', '1.0.0'), true);
  assert.equal(calls.length, 2);
});

// ── where a release stands, per channel ───────────────────────────────────────────────────

const chans = (...list) => ui.setCatalog({
  systems: [{ name: 'HERA' }],
  channels: list.map((c) => ({ system: 'HERA', pinnedVersions: [], paused: false, ...c })),
  releases: [],
});

/**
 * Each tag as "class:text", so a test asserts on both what it says and how it reads.
 *
 * Spread first: `tags` comes back from the vm realm, and `.map` on it would produce a vm-realm
 * Array whose prototype deepStrictEqual refuses to match.
 */
const shape = (tags) => [...tags].map((t) => `${t.className}:${textOf(t)}`);

test('a release on beta shows stable is still behind', () => {
  // The half that was missing. "live: beta" said where it IS; what decides a promote is where
  // stable is NOT.
  chans({ name: 'stable', latest: '0.15.0' }, { name: 'beta', latest: '0.16.0' });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  // beta first, always: that is the direction a release travels, and reading the same two
  // positions on every row is what makes the column scannable.
  assert.deepEqual(shape(tags), ['tag ok:beta', 'tag dim:stable: 0.15.0']);
});

test('after a promote, beta has let go and stable is green', () => {
  // Both green cannot happen any more — one release runs on one channel — so the case worth
  // pinning is the handover: promoted to stable, beta let go of it.
  chans({ name: 'stable', latest: '0.16.0' }, { name: 'beta', latest: null });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  assert.deepEqual(shape(tags), ['tag dim:beta: none', 'tag ok:stable']);
});

test('a release nothing points at reads as a warning, not as missing green', () => {
  chans({ name: 'stable', latest: '0.15.0' }, { name: 'beta', latest: '0.15.0' });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  assert.match(tags[0].className, /warn/);
  assert.match(textOf(tags[0]), /nobody sees this/);
  // And it still says where the channels actually are.
  assert.deepEqual(shape(tags.slice(1)), ['tag dim:beta: 0.15.0', 'tag dim:stable: 0.15.0']);
});

test('a channel serving this release is named plainly', () => {
  // Green alone would claim nodes are being served, and they are not.
  chans({ name: 'beta', latest: '0.16.0' }, { name: 'stable', latest: null });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  assert.equal(textOf(tags[0]), 'beta');
  assert.match(tags[0].title, /being offered this version/);
});

test('the other channel says what it has instead', () => {
  // What stable has instead, so the promote decision needs no second screen.
  chans({ name: 'beta', latest: '0.16.0' }, { name: 'stable', latest: '0.15.0' });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  assert.equal(textOf(tags[1]), 'stable: 0.15.0');
});

test('a channel handing out nothing says none', () => {
  chans({ name: 'beta', latest: null }, { name: 'stable', latest: null });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  // "none", not "nothing": the column is narrow and the word is doing a label's job.
  assert.match(textOf(tags[1]), /beta: none/);
});

test('a system with no channels at all is the loudest case', () => {
  ui.setCatalog({ systems: [{ name: 'HERA' }], channels: [], releases: [] });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  assert.equal(textOf(tags[0]), 'no channels');
  assert.match(tags[0].className, /warn/);
});

test('another system\'s channels are not counted', () => {
  ui.setCatalog({
    systems: [{ name: 'HERA' }, { name: 'drone' }],
    channels: [
      { system: 'drone', name: 'stable', latest: '0.16.0', pinnedVersions: [], paused: false },
    ],
    releases: [],
  });
  const tags = ui.channelStanding({ system: 'HERA', version: '0.16.0' });

  // drone/stable happens to be on the same version number; version numbers are per system.
  assert.equal(textOf(tags[0]), 'no channels');
});

// ── the Publish tab says where the upload landed ──────────────────────────────────────────

const UPLOAD = {
  version: '0.16.0',
  system: 'HERA',
  inspection: {
    format: 'bundle',
    version: '0.16.0',
    platforms: ['linux-x86_64'],
    cores: [{ platform: 'linux-x86_64', path: 'core/linux-x86_64', slice_version: '0.16.0', system: 'HERA', bundled_plugins: [], shipped_config: [] }],
    plugins: [],
    configs: [],
    release: { system: 'HERA', minVersion: null, mandatory: false, notes: null },
    warnings: [],
    declaredSystems: ['HERA'],
  },
};

test('a fresh upload says no node can see it, and where the channels are', () => {
  // This is the whole point of the panel right after an upload: the release exists and is
  // reachable by nobody. Saying only "staged" leaves out what stable is currently handing out,
  // which is what the operator compares it against.
  chans({ name: 'stable', latest: '0.15.0' }, { name: 'beta', latest: '0.15.0' });
  ui.renderInspection(UPLOAD);

  const html = textOf(ui.dom.getElementById('inspection'));
  assert.match(html, /channels /);
  assert.match(html, /nobody sees this/);
  assert.match(html, /beta: 0\.15\.0/);
  assert.match(html, /stable: 0\.15\.0/);
});

test('once a channel points at it, the panel stops saying nobody sees it', () => {
  // Redrawn after Publish. Leaving the old text up is worse than showing nothing: it states
  // something that has just become false.
  chans({ name: 'stable', latest: '0.15.0' }, { name: 'beta', latest: '0.16.0' });
  ui.renderInspection(UPLOAD);

  const html = textOf(ui.dom.getElementById('inspection'));
  assert.doesNotMatch(html, /nobody sees this/);
  assert.match(html, /live on/, 'the label carries the verb, not just the channel name');
  assert.match(html, /beta/);
  assert.match(html, /stable: 0\.15\.0/, 'and stable is still visibly behind');
});

test('the panel renders for a system with no channels without throwing', () => {
  ui.setCatalog({ systems: [{ name: 'HERA' }], channels: [], releases: [] });
  assert.doesNotThrow(() => ui.renderInspection(UPLOAD));
  assert.match(textOf(ui.dom.getElementById('inspection')), /no channels/);
});

// ── the label carries the verb the chips do not ──────────────────────────────────────────

test('a release a channel hands out is labelled "live on"', () => {
  // Green alone is ambiguous: `beta` could mean "serving this" or "a channel that exists".
  // With two green chips and nothing else on the row there is nothing to infer it from.
  chans({ name: 'stable', latest: '0.13.4' }, { name: 'beta', latest: '0.13.4' });
  assert.equal(ui.standingLabel({ system: 'HERA', version: '0.13.4' }), 'live on');
});

test('a release nothing hands out keeps the neutral label', () => {
  // The staged chip already says nobody sees it; claiming it is "live on" anything would be
  // exactly backwards.
  chans({ name: 'stable', latest: '0.15.0' }, { name: 'beta', latest: '0.16.0' });
  assert.equal(ui.standingLabel({ system: 'HERA', version: '0.17.0' }), 'channels');
});

test('a release on beta counts as live', () => {
  // Some serials are being offered it, which is what the word has to mean.
  chans({ name: 'beta', latest: '0.16.0' }, { name: 'stable', latest: '0.15.0' });
  assert.equal(ui.standingLabel({ system: 'HERA', version: '0.16.0' }), 'live on');
});

test('a release in a system with no channels is not live', () => {
  ui.setCatalog({ systems: [{ name: 'HERA' }], channels: [], releases: [] });
  assert.equal(ui.standingLabel({ system: 'HERA', version: '0.16.0' }), 'channels');
});

// ── the Channel column ───────────────────────────────────────────────────────────────────

const artifact = (platform) => ({
  kind: 'slim', platform, platforms: [platform], size: 1024, sha256: 'a'.repeat(64),
  bundle_format: 'bundle', warning_count: 0, plugins: {}, config: {}, id: 1,
});

test('the artifact table has a Channel column', () => {
  // Asked as a column because that is where the question gets asked: while looking at a row
  // and deciding whether this artifact is the one a given node receives.
  ui.setCatalog({
    revision: '14',
    systems: [{ name: 'HERA' }],
    channels: [
      { system: 'HERA', name: 'stable', latest: '0.13.4', paused: false, pinnedVersions: [] },
      { system: 'HERA', name: 'beta', latest: '0.16.0', paused: false, pinnedVersions: [] },
    ],
    releases: [{
      version: '0.13.4', system: 'HERA', publishedAt: '2026-07-29T06:00:00Z',
      artifacts: [artifact('linux-x86_64')],
    }],
  });
  ui.renderCatalog();

  const html = textOf(ui.dom.getElementById('catalog-list'));
  assert.match(html, /Channel/, 'the header');
  assert.match(html, /live on/);
  assert.match(html, /beta: 0\.16\.0/, 'and where the other channel is');
});

test('the cell repeats per artifact row, on purpose', () => {
  // Channel standing belongs to the release, not the artifact — but a column that skipped
  // rows would leave the question unanswered on exactly the row being read.
  chans({ name: 'stable', latest: '0.13.4' });
  const cell = ui.channelCell({ system: 'HERA', version: '0.13.4' });

  assert.match(textOf(cell), /live on/);
  assert.match(textOf(cell), /stable/);
});

test('a release with no artifacts still says where it stands', () => {
  // No table to hold the column, and a channel pointing at a version whose bytes are gone is
  // precisely what an operator must not miss.
  ui.setCatalog({
    revision: '14',
    systems: [{ name: 'HERA' }],
    channels: [{ system: 'HERA', name: 'stable', latest: '0.13.4', paused: false, pinnedVersions: [] }],
    releases: [{
      version: '0.13.4', system: 'HERA', publishedAt: '2026-07-29T06:00:00Z', artifacts: [],
    }],
  });
  ui.renderCatalog();

  assert.match(textOf(ui.dom.getElementById('catalog-list')), /live on/);
});

// ── moving a release between channels is announced ───────────────────────────────────────

test('pointing a channel at a version another one serves asks first', () => {
  // The move clears the other channel, which changes what a different set of nodes is
  // offered. Doing that behind the operator's back is not acceptable at any scale.
  chans({ name: 'stable', latest: '0.13.4' }, { name: 'beta', latest: '0.15.0' });
  const calls = stubRequest([{ released: ['beta'] }]);

  let asked = '';
  ui.setConfirm((message) => { asked = message; return true; });

  return ui.setChannelLatest('HERA', 'stable', '0.15.0').then((ok) => {
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.match(asked, /currently on beta/);
    assert.match(asked, /one channel at a time/);
    assert.match(asked, /Nodes there keep 0\.15\.0/, 'nothing is taken away from them');
  });
});

test('declining leaves both channels where they were', async () => {
  chans({ name: 'stable', latest: '0.13.4' }, { name: 'beta', latest: '0.15.0' });
  const calls = stubRequest([]);
  ui.setConfirm(() => false);

  assert.equal(await ui.setChannelLatest('HERA', 'stable', '0.15.0'), false);
  assert.equal(calls.length, 0, 'nothing was sent');
});

test('a version no other channel serves moves without a prompt', async () => {
  // Nothing is being taken from anyone, so there is nothing to warn about.
  chans({ name: 'stable', latest: '0.13.4' }, { name: 'beta', latest: '0.15.0' });
  const calls = stubRequest([{ released: [] }]);
  ui.setConfirm(() => {
    throw new Error('must not ask when no channel loses the version');
  });

  assert.equal(await ui.setChannelLatest('HERA', 'stable', '0.16.0'), true);
  assert.equal(calls.length, 1);
});

// ── the box after step one ───────────────────────────────────────────────────────────────

const commitBox = () => ({
  title: ui.dom.getElementById('commit-title').textContent,
  hint: ui.dom.getElementById('commit-hint').textContent,
  token: ui.dom.getElementById('commit-wrap').dataset.token,
});

test('the panel says nothing is stored yet', () => {
  // This is the only screen describing something that does not exist. It looks exactly like
  // the panel that used to appear AFTER the write, and an operator who reads it as "done"
  // walks away leaving the bundle in a temp directory the pruner sweeps within the hour.
  chans({ name: 'beta', latest: '0.13.4' }, { name: 'stable', latest: '0.13.4' });
  ui.showCommit({ token: 'abc', version: '0.13.5', system: 'HERA' });

  const box = commitBox();
  assert.match(box.title, /Store 0\.13\.5 and put it on beta\?/);
  assert.match(box.hint, /Nothing is stored yet/);
});

test('it says who will get it and who will not', () => {
  chans({ name: 'beta', latest: '0.13.4' }, { name: 'stable', latest: '0.13.4' });
  ui.showCommit({ token: 'abc', version: '0.13.5', system: 'HERA' });

  const { hint } = commitBox();
  assert.match(hint, /only devices set to beta/);
  assert.match(hint, /rest of the fleet is untouched/);
  assert.match(hint, /promote it from the Catalog/, 'and where the next step lives');
});

test('the token is carried on the panel, not in a variable that a reload loses', () => {
  chans({ name: 'beta', latest: null }, { name: 'stable', latest: null });
  ui.showCommit({ token: 'a7f3', version: '1.0.0', system: 'HERA' });

  assert.equal(commitBox().token, 'a7f3');
});

test('a no-op bundle still says nothing is stored, and why it is pointless', () => {
  // Two facts, and neither may hide the other: it has not been written, AND writing it would
  // make every node download a bundle that changes nothing.
  chans({ name: 'beta', latest: '0.13.4' }, { name: 'stable', latest: '0.13.4' });
  ui.showCommit({
    token: 'abc',
    version: '0.13.5',
    system: 'HERA',
    diff: { no_op: true, previousVersion: '0.13.4' },
  });

  const { hint } = commitBox();
  assert.match(hint, /Nothing is stored yet/);
  assert.match(hint, /changes nothing compared with 0\.13\.4/);
  assert.match(hint, /skipped\/same_version/);
});

// ── a release whose bytes are gone ───────────────────────────────────────────────────────

test('an artifact with no file on disk says so', () => {
  // This row looks perfectly healthy from every other angle: the release is listed, a channel
  // points at it, and nodes are simply told there is no update. The only other trace is one
  // line in the server log.
  const cell = ui.kindCell({ kind: 'slim', platform: 'linux-x86_64', readable: false });

  assert.match(textOf(cell), /bytes missing/);
  assert.match(textOf(cell), /slim \(linux-x86_64\)/, 'still says what it was');
});

test('a readable artifact is left plain', () => {
  assert.equal(ui.kindCell({ kind: 'slim', platform: 'linux-x86_64', readable: true }),
    'slim (linux-x86_64)');
});

test('an artifact from a server that did not report readability is not accused', () => {
  // `readable` is absent on an older payload. Absent is not false.
  assert.equal(ui.kindCell({ kind: 'fleet', platform: null }), 'fleet');
});

test('the channel column stops claiming a release is live when its file is gone', () => {
  // "live on beta" beside a missing file is the lie that matters: an operator reads it as
  // shipped, and every node is quietly being told there is nothing for it.
  chans({ name: 'beta', latest: '0.13.4' }, { name: 'stable', latest: null });
  const cell = ui.channelCell({ system: 'HERA', version: '0.13.4' }, { readable: false });

  assert.match(textOf(cell), /nothing served/);
  assert.doesNotMatch(textOf(cell), /live on/);
});

// ── the fleet key card ───────────────────────────────────────────────────────────────────

test('the key is shown in full, because the point is to copy it', () => {
  // A mask that has to be revealed is a click that teaches nothing; what makes the read
  // accountable is the audit entry, not the UI hiding the value.
  ui.renderApiKeys({ keys: [{ fleet: 'test-fleet', key: 'k'.repeat(20) }], shared: true });

  const html = textOf(ui.dom.getElementById('api-keys'));
  assert.match(html, /test-fleet/);
  assert.match(html, new RegExp('k'.repeat(20)));
});

test('no key configured is stated as the outage it is', () => {
  // Without UPDATE_API_KEYS every fleet request answers 401, and nothing else on this screen
  // would say why.
  ui.renderApiKeys({ keys: [], shared: true });

  const html = textOf(ui.dom.getElementById('api-keys'));
  assert.match(html, /No UPDATE_API_KEYS is configured/);
  assert.match(html, /401/);
});
