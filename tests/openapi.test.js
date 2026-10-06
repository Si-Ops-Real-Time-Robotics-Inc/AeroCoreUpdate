import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiRoutes } from '../src/routes/index.js';

/**
 * The spec is the contract, so it has to be checked against the thing it claims
 * to describe. This is the only test that can catch a route added to the code
 * and forgotten in api/openapi.yaml — the failure mode of OpenAPI-first, where
 * the generated client is missing an endpoint that exists and nobody notices
 * until a screen 404s.
 *
 * The spec is read as TEXT rather than parsed. This project has one runtime
 * dependency (`pg`) and adding a YAML parser to satisfy a test would be the
 * wrong trade; extracting path keys and method keys is a scan, not a parser,
 * and it fails loudly if the file stops looking like what it scans for.
 */

const SPEC = new URL('../api/openapi.yaml', import.meta.url);
const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

function specOperations() {
  const ops = new Set();
  let path = null;

  for (const line of readFileSync(SPEC, 'utf8').split('\n')) {
    const pathKey = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathKey) {
      path = pathKey[1];
      continue;
    }
    const verb = /^ {4}([a-z]+):\s*$/.exec(line);
    if (path && verb && VERBS.includes(verb[1])) ops.add(`${verb[1].toUpperCase()} ${path}`);
  }
  return ops;
}

/** `/update/download/:version` in the router is `{version}` in the spec. */
const asSpecPath = (pattern) => pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

const implemented = new Set(
  apiRoutes.routes.map((route) => `${route.method} ${asSpecPath(route.pattern)}`),
);

test('the scan found a spec that still looks like an OpenAPI document', () => {
  // Guards the regexes above: if the file is reformatted so nothing matches,
  // every assertion below would pass vacuously.
  assert.ok(specOperations().size > 30, 'extracted almost no operations from api/openapi.yaml');
});

test('every route the server serves is described in the spec', () => {
  const spec = specOperations();
  const undocumented = [...implemented].filter((op) => !spec.has(op)).sort();
  assert.deepEqual(undocumented, [], `not in api/openapi.yaml:\n  ${undocumented.join('\n  ')}`);
});

test('the spec describes nothing the server does not serve', () => {
  const phantom = [...specOperations()].filter((op) => !implemented.has(op)).sort();
  assert.deepEqual(phantom, [], `in api/openapi.yaml but not routed:\n  ${phantom.join('\n  ')}`);
});

test('the error codes the spec closes over are the ones errors.js can emit', async () => {
  const source = readFileSync(new URL('../src/core/errors.js', import.meta.url), 'utf8');
  const emitted = new Set([...source.matchAll(/new HttpError\(\s*\d+,\s*'([a-z_]+)'/g)]
    .map((m) => m[1]));

  const spec = readFileSync(SPEC, 'utf8');
  const enumBlock = /ErrorCode:[\s\S]*?enum:\n((?: {8}- \S+\n)+)/.exec(spec);
  assert.ok(enumBlock, 'no ErrorCode enum found in the spec');
  const declared = new Set(enumBlock[1].trim().split('\n').map((l) => l.replace(/^\s*-\s*/, '')));

  const missing = [...emitted].filter((c) => !declared.has(c)).sort();
  assert.deepEqual(missing, [], `errors.js can emit codes the spec does not name: ${missing}`);
});

/**
 * Field names in the spec must be columns the query actually selects.
 *
 * This exists because `UnclassifiedNode` was first written from what the old UI
 * appeared to read, and named `claimed_system` and `last_seen_at` — the table
 * has `reported_system`, `first_seen` and `last_seen`. Nothing failed: the
 * generated client simply described fields that never arrive, and every screen
 * built on it would render blanks. A guess that agrees with nothing is exactly
 * what OpenAPI-first is supposed to make impossible.
 */
const ROW_SCHEMAS = [
  ['FleetNode', 'telemetry.repository.js', 'fleetInventory'],
  ['NodeReport', 'telemetry.repository.js', 'recentReports'],
  ['RolloutStat', 'telemetry.repository.js', 'rolloutStats'],
  ['AuditEntry', 'audit.repository.js', 'listAudit'],
  ['UnclassifiedNode', 'system.repository.js', 'listUnclassified'],
];

/** Split a SELECT list on commas that are not inside brackets. */
function splitColumns(list) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let current = '';

  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (ch === ',' && depth === 0 && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** The column names a repository function's SELECT produces. */
function selectedColumns(file, fn) {
  const source = readFileSync(new URL(`../src/repositories/${file}`, import.meta.url), 'utf8');
  const body = source.slice(source.indexOf(`export async function ${fn}`));
  // \bFROM\b, not /FROM/i: `from_version` is a column in one of these queries and a
  // non-anchored match ends the SELECT list in the middle of it, silently.
  const sql = /SELECT([\s\S]*?)\bFROM\b/i.exec(body);
  assert.ok(sql, `no SELECT found in ${file}:${fn}`);

  return new Set(
    splitColumns(sql[1].replace(/DISTINCT ON \([^)]*\)/i, ''))
      .map((item) => item.trim())
      .filter(Boolean)
      // `count(*)::int AS count` and `coalesce(x, '') AS error` reduce to their
      // alias; a bare column reduces to itself.
      .map((item) => {
        const aliased = /\sAS\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(item);
        return (aliased ? aliased[1] : item.split(/[\s.]/).pop()).replace(/::.*$/, '');
      }),
  );
}

/** The property names a schema declares in the spec. */
function schemaProperties(name) {
  const spec = readFileSync(SPEC, 'utf8');
  const start = spec.indexOf(`\n    ${name}:\n`);
  assert.ok(start > 0, `schema ${name} not found in the spec`);
  const rest = spec.slice(start + 1);
  const end = /\n {4}[A-Za-z]/.exec(rest.slice(1));
  const block = end ? rest.slice(0, end.index + 1) : rest;

  const props = block.indexOf('\n      properties:\n');
  assert.ok(props > 0, `schema ${name} declares no properties`);
  return new Set(
    [...block.slice(props).matchAll(/^ {8}([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]),
  );
}

for (const [schema, file, fn] of ROW_SCHEMAS) {
  test(`${schema} names only columns ${fn} selects`, () => {
    const columns = selectedColumns(file, fn);
    const invented = [...schemaProperties(schema)].filter((p) => !columns.has(p)).sort();
    assert.deepEqual(invented, [], `${schema} declares fields the query never returns: ${invented}`);
  });

  test(`${schema} describes every column ${fn} returns`, () => {
    const declared = schemaProperties(schema);
    const undocumented = [...selectedColumns(file, fn)].filter((c) => !declared.has(c)).sort();
    assert.deepEqual(undocumented, [], `${fn} returns columns the spec omits: ${undocumented}`);
  });
}

/**
 * Two schemas the admin UI renders the internals of must stay closed.
 *
 * `Inspection` and `Diff` were `additionalProperties: true` while a screen was already
 * displaying their fields — which is hand-writing shapes under another name, and is how
 * three wrong field sets reached this client before a test existed to notice. Reopening
 * either one silently restores that.
 */
function schemaBlock(name) {
  const spec = readFileSync(SPEC, 'utf8');
  const start = spec.indexOf(`\n    ${name}:\n`);
  assert.ok(start > 0, `schema ${name} not found in the spec`);
  const rest = spec.slice(start + 1);
  const end = /\n {4}[A-Za-z]/.exec(rest.slice(1));
  return end ? rest.slice(0, end.index + 1) : rest;
}

for (const name of ['Inspection', 'Diff']) {
  test(`${name} declares no open additionalProperties`, () => {
    assert.equal(
      /additionalProperties:\s*true/.test(schemaBlock(name)),
      false,
      `${name} is open again; the generated client cannot type what it renders`,
    );
  });

  test(`${name} declares properties rather than standing empty`, () => {
    // A schema closed by deleting its body is closed and useless.
    assert.ok(schemaBlock(name).includes('properties:'), `${name} declares no properties`);
  });
}

/**
 * The admin UI carries its own copy of the platform list, because the contract
 * deliberately leaves `Platform` open: with STRICT_PLATFORMS off the server
 * accepts anything matching its pattern, so an enum in the spec would refuse
 * values the server allows.
 *
 * A copy with nothing watching it is drift waiting to happen, so this compares
 * the two lists directly.
 */
test('the admin UI platform list matches the server list exactly', () => {
  const list = (source, marker) => {
    const block = new RegExp(`${marker}[^[]*\\[([^\\]]*)\\]`).exec(source);
    assert.ok(block, `could not find ${marker}`);
    return [...block[1].matchAll(/['"]([a-z0-9_-]+)['"]/g)].map((m) => m[1]);
  };

  const server = list(
    readFileSync(new URL('../src/domain/platform.js', import.meta.url), 'utf8'),
    'export const KNOWN_PLATFORMS =',
  );
  const ui = list(
    readFileSync(new URL('../webui/src/lib/platforms.ts', import.meta.url), 'utf8'),
    'export const KNOWN_PLATFORMS =',
  );

  assert.ok(server.length >= 13, `only found ${server.length} platforms in the server list`);
  assert.deepEqual(ui, server, 'the admin UI and the server disagree about which platforms exist');
});

/**
 * Two fields the server has always sent and the contract did not describe.
 *
 * A field the server sends and the spec omits is worse than an undocumented one: the
 * generated client cannot type it, so a screen that needs it either hand-writes the shape —
 * the thing this file exists to prevent — or renders a degraded version of itself and nobody
 * notices, because a banner listing fewer facts still looks like a working banner.
 */
test('Finding declares from and to, which the rollback refusal carries', () => {
  const block = schemaBlock('Finding');
  for (const field of ['from:', 'to:']) {
    assert.ok(block.includes(`        ${field}`),
      `Finding must declare ${field.slice(0, -1)} — channel_rollback sends it and a client `
      + 'cannot state the move without it');
  }
  // Optional on purpose: a bundle-inspection finding describes a bundle, not a move.
  assert.match(block, /required:\s*\[rule,\s*message\]/,
    'from/to must stay optional — most findings are not about a channel move');
});

test('Catalog.stray_channels declares all four fields the query selects', () => {
  const spec = readFileSync(SPEC, 'utf8');
  const start = spec.indexOf('        stray_channels:');
  assert.ok(start > 0, 'stray_channels not found');
  const block = spec.slice(start, spec.indexOf('\n        releases:', start));

  for (const field of ['system:', 'channel:', 'nodes:', 'last_seen:']) {
    assert.ok(block.includes(field),
      `stray_channels items must declare ${field.slice(0, -1)}: unknownChannels() selects it, `
      + 'and without nodes and last_seen the banner cannot say whether this is happening now');
  }

  // The columns really are what the repository selects — the same check the row schemas get.
  const repo = readFileSync(
    new URL('../src/repositories/telemetry.repository.js', import.meta.url), 'utf8',
  );
  // Anchored to the function: several queries in this file read check_log, and matching the
  // first one would check a query this schema has nothing to do with.
  const fn = repo.slice(repo.indexOf('export async function unknownChannels'));
  const select = /SELECT([\s\S]*?)FROM check_log/.exec(fn);
  assert.ok(select, 'could not find the unknownChannels query');
  for (const column of ['nodes', 'last_seen']) {
    assert.ok(select[1].includes(column), `unknownChannels no longer selects ${column}`);
  }
});

/**
 * Removing a build (feature 005). Both delete operations declared success only, though both
 * refuse in practice, and Catalog promised a per-release `channels` the server has never sent —
 * which is how every release came to read "staged" on the Catalog screen.
 */
test('Finding declares channels, which the release_in_use refusal carries', () => {
  const block = schemaBlock('Finding');
  assert.ok(block.includes('        channels:'),
    'Finding must declare channels — release_in_use sends them, and a client cannot say which '
    + 'channel to move without them');
  assert.match(block, /required:\s*\[rule,\s*message\]/,
    'channels must stay optional — most findings are not about a served release');
});

for (const [route, label] of [
  ['/admin/api/systems/{system}/releases/{version}:', 'deleteRelease'],
  ['/admin/api/artifacts/{id}:', 'deleteArtifact'],
]) {
  test(`${label} declares every response it can produce`, () => {
    const spec = readFileSync(SPEC, 'utf8');
    const start = spec.indexOf(`\n  ${route}\n`);
    assert.ok(start > 0, `${route} not found`);
    const rest = spec.slice(start + 1);
    const pathBlock = rest.slice(0, (rest.slice(1).search(/\n {2}\//) + 1) || undefined);
    const del = pathBlock.slice(pathBlock.indexOf('\n    delete:'));
    assert.ok(del.startsWith('\n    delete:'), `${label} has no delete operation`);
    const op = del.slice(0, (del.slice(1).search(/\n {4}[a-z]/) + 1) || undefined);
    for (const status of ['"401"', '"403"', '"404"', '"409"']) {
      assert.ok(op.includes(`${status}:`), `${label} does not declare ${status}`);
    }
  });
}

test('Catalog.releases does not promise a channels field the server never sends', () => {
  const block = schemaBlock('Catalog');
  const releases = block.slice(block.indexOf('\n        releases:'));
  assert.ok(releases.includes('artifacts:'), 'could not find Catalog.releases');
  assert.doesNotMatch(releases, /\n {10,}channels:/,
    'which channels serve a release comes from Catalog.channels; the per-release copy was '
    + 'declared, generated and rendered, and never sent');
});
