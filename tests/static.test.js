import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { staticFiles } from '../src/middlewares/staticFiles.js';

/**
 * The admin UI lives under /admin/, so the two paths a person actually types — "/" and
 * "/admin" — must not answer with the JSON 404 meant for the fleet.
 */
async function withServer(rootDir, fn) {
  const serve = staticFiles(rootDir);

  const server = http.createServer(async (req, res) => {
    req.pathname = new URL(req.url, 'http://x').pathname;
    await serve(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: `Cannot GET ${req.pathname}` }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn((p) => fetch(`${base}${p}`, { redirect: 'manual' }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aeroserver-static-'));
  await fsp.mkdir(path.join(dir, 'admin'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'admin', 'index.html'), '<h1>admin</h1>');
  await fsp.writeFile(path.join(dir, 'admin', 'app.js'), 'export const x = 1;');
  return dir;
}

test('a directory without a trailing slash redirects to one', async () => {
  const dir = await fixture();
  await withServer(dir, async (get) => {
    const res = await get('/admin');

    // Without this the request 404s, because "public/admin" is a directory and there is no
    // file to read. Relative asset URLs in the index would also resolve one level too high.
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/admin/');
  });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a directory with a trailing slash serves its index', async () => {
  const dir = await fixture();
  await withServer(dir, async (get) => {
    const res = await get('/admin/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<h1>admin<\/h1>/);
  });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a real file is served with the right content type', async () => {
  const dir = await fixture();
  await withServer(dir, async (get) => {
    const res = await get('/admin/app.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
  });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a missing file still falls through to the 404 handler', async () => {
  const dir = await fixture();
  await withServer(dir, async (get) => {
    const res = await get('/admin/nope.js');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('path traversal is refused, not redirected', async () => {
  const dir = await fixture();
  await fsp.writeFile(path.join(dir, '..', 'aeroserver-secret.txt'), 'secret').catch(() => {});
  await withServer(dir, async (get) => {
    const res = await get('/..%2faeroserver-secret.txt');
    assert.equal(res.status, 404);
  });
  await fsp.rm(dir, { recursive: true, force: true });
});
