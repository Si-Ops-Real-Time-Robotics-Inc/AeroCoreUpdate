import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  SKIP_MESSAGE, fleetHeaders, hasDatabase, publish, setChannel, signIn, startServer,
} from './helpers/harness.js';

/**
 * The files half of migration 012.
 *
 * Artifacts used to live at <root>/<version>/<file>. Two systems may now publish the same
 * version number, so they live at <root>/<system>/<version>/<file>, and a deployment upgraded
 * across this change has its files in the old place with rows that expect the new one. Unless
 * they are moved, every release published before the upgrade answers "no update" — the check
 * path declines to offer what it cannot read.
 */
describe('moving artifacts into the per-system layout', { skip: hasDatabase ? false : SKIP_MESSAGE }, () => {
  let server;
  let session;
  let root;
  let artifactPath;
  let moveLegacyArtifacts;

  const exists = (file) => fsp.access(file).then(() => true, () => false);

  before(async () => {
    server = await startServer();
    session = await signIn(server);
    root = path.join(server.dir, 'artifacts');
    // Imported after startServer(), so they read the configuration the server is using.
    ({ artifactPath } = await import('../src/repositories/catalog.repository.js'));
    ({ moveLegacyArtifacts } = await import('../src/services/artifactLayout.service.js'));

    await publish(session, { version: '8.0.0' });
    await setChannel(session, 'stable', { latest: '8.0.0' });
  });

  after(async () => { await server?.close(); });

  /** Put the file back where a pre-012 server left it. */
  const toLegacy = async (version, file) => {
    await fsp.mkdir(path.join(root, version), { recursive: true });
    await fsp.rename(artifactPath('default', version, file), path.join(root, version, file));
  };

  test('a file in the old place is moved to the new one, and the old directory goes', async () => {
    await toLegacy('8.0.0', 'linux-x86_64.tar.gz');

    assert.equal(await moveLegacyArtifacts(), 1);
    assert.ok(await exists(artifactPath('default', '8.0.0', 'linux-x86_64.tar.gz')));
    assert.equal(await exists(path.join(root, '8.0.0')), false, 'emptied, so removed');
  });

  test('after the move the release is served again', async () => {
    const res = await server.request(
      '/api/v1/update/check?system=default&serial=SN-L&platform=linux-x86_64&version=0.1.0',
      { headers: fleetHeaders() },
    );
    assert.equal(res.json().version, '8.0.0');
  });

  test('running it again moves nothing', async () => {
    // It runs at every boot, so a second run must be a no-op, not an error.
    assert.equal(await moveLegacyArtifacts(), 0);
  });

  test('an old directory holding something else is left in place', async () => {
    await toLegacy('8.0.0', 'linux-x86_64.tar.gz');
    await fsp.writeFile(path.join(root, '8.0.0', 'operator-notes.txt'), 'not ours');

    assert.equal(await moveLegacyArtifacts(), 1);
    assert.ok(await exists(path.join(root, '8.0.0', 'operator-notes.txt')),
      'only a directory this emptied is removed');
  });
});
