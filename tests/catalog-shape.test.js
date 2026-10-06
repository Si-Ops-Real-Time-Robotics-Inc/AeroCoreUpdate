import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SKIP_MESSAGE, hasDatabase, publish, signIn, startServer } from './helpers/harness.js';

/**
 * Every property the contract declares on a catalog release is one the server really sends.
 *
 * tests/openapi.test.js checks routes against the spec, and the columns some row schemas are
 * built from. Neither looks at what a response contains. That is how `Catalog.releases[].channels`
 * was declared, generated into the client and rendered by the Catalog screen without ever being
 * sent: every release read "staged", including the one stable was serving.
 */
describe('the catalog response matches its contract', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let admin;

  before(async () => {
    server = await startServer();
    admin = await signIn(server);
    await publish(admin, { version: '3.1.0' });
  });

  after(async () => { await server?.close(); });

  test('a release carries every property Catalog.releases declares', async () => {
    const spec = readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8');
    const start = spec.indexOf('\n    Catalog:\n');
    assert.ok(start > 0, 'Catalog schema not found');
    const rest = spec.slice(start + 1);
    const catalogBlock = rest.slice(0, (rest.slice(1).search(/\n {4}[A-Za-z]/) + 1) || undefined);
    const releases = catalogBlock.slice(catalogBlock.indexOf('\n        releases:'));
    const declared = [...releases.matchAll(/^ {14}([a-z_]+):/gm)].map((m) => m[1]);
    assert.ok(declared.length >= 3, `found only [${declared.join(', ')}] on Catalog.releases`);

    const { releases: sent } = (await admin.api('/admin/api/catalog')).json();
    const release = sent.find((r) => r.version === '3.1.0');
    assert.ok(release, 'the fixture release is not in the catalog');

    const missing = declared.filter((key) => !(key in release));
    assert.deepEqual(missing, [],
      `declared on Catalog.releases but never sent: ${missing.join(', ')}`);
  });
});
