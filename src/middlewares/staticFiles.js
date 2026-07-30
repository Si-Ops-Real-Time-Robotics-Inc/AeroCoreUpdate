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

/** Serve static files from rootDir; fall through to next() when nothing matches. */
export function staticFiles(rootDir, { index = 'index.html' } = {}) {
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
      return next();
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  };
}
