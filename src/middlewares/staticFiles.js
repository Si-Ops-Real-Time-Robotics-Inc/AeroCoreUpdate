import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serve static files from rootDir; fall through to next() when nothing matches.
 *
 * `spa` turns the directory under `prefix` into a single-page app: a path that
 * names no file is answered with its index document, so the client router sees
 * it instead of a 404. The OIDC redirect lands on /admin/callback, which is a
 * client route and has never been a file.
 */
export function staticFiles(rootDir, { index = 'index.html', spa = null } = {}) {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let relative;
    try {
      relative = decodeURIComponent(req.pathname).replace(/^\/+/, '');
    } catch {
      return next();
    }
    // A directory request serves its index document.
    if (relative === '' || relative.endsWith('/')) relative += index;

    const filePath = path.join(rootDir, relative);

    // Block path traversal: the resolved file must stay inside rootDir.
    if (!filePath.startsWith(rootDir + path.sep)) return next();

    let data;
    let servedPath = filePath;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        // /admin -> /admin/ so the index document is served and relative asset URLs in it
        // resolve against the directory rather than its parent.
        res.writeHead(301, { Location: `${req.pathname}/` });
        res.end();
        return undefined;
      }
      data = await fs.readFile(filePath);
    } catch {
      // Only a path that could be a client route falls back. A missing asset
      // must stay a 404: answering a missing .js with index.html hands the
      // browser HTML where it expected a module, and the console error names
      // the wrong problem entirely.
      const isClientRoute = spa
        && req.pathname.startsWith(spa.prefix)
        && path.extname(req.pathname) === ''
        && (req.headers.accept ?? '').includes('text/html');
      if (!isClientRoute) return next();

      servedPath = path.join(rootDir, spa.index);
      try {
        data = await fs.readFile(servedPath);
      } catch {
        return next();
      }
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(servedPath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  };
}
