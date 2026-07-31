import http from 'node:http';
import http2 from 'node:http2';

import { createApp } from './app.js';
import { config, isProduction } from './config/index.js';
import { logger } from './core/logger.js';
import { loadTlsContext, logCertificate, watchCertificate } from './core/tls.js';
import { pruneTempFiles } from './core/files.js';
import { closePool, connectWithRetry } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { bootstrapAdmin } from './services/auth.service.js';
import { initSigning, logSigningKey } from './services/signing.service.js';
import { initOidc } from './core/oidc.js';
import { setTlsInfo } from './services/tlsInfo.service.js';
import { listChannels } from './repositories/catalog.repository.js';
import { pruneCheckLog } from './repositories/telemetry.repository.js';
import { pruneExpiredTokens, pruneLoginAttempts } from './repositories/auth.repository.js';
import { tempDir } from './services/publish.service.js';

const servers = [];

async function main() {
  assertRequiredSecrets();

  await connectWithRetry();
  if (config.runMigrations) await migrate();
  await bootstrapAdmin();

  await initSigning();
  logSigningKey();

  // Never fatal: a server that cannot reach the IdP must still serve everything that does
  // not need an IdP token, and initOidc falls back to its on-disk key cache.
  await initOidc();

  const tls = await loadTlsContext();
  setTlsInfo({ enabled: true, ...tls });
  logCertificate(tls);

  await summariseCatalog();
  await housekeeping();

  const app = createApp();

  // HTTP/2 with the HTTP/1.1 fallback left on, negotiated per connection by ALPN.
  //
  // `allowHTTP1` is not optional here. The node's update client is httplib, which speaks
  // HTTP/1.1 only — an h2-exclusive listener would take the entire fleet offline the moment it
  // started, and the devices would report nothing but connection failures.
  //
  // The compatibility API gives handlers the same (req, res) shape, so the middleware chain is
  // untouched. What HTTP/2 buys on this server is the admin UI: a browser loads the page, its
  // script, its stylesheet and several API calls over one connection instead of six handshakes.
  const httpsServer = http2.createSecureServer(
    { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', allowHTTP1: true }, app,
  );
  servers.push(httpsServer);
  watchCertificate(httpsServer);

  await listen(httpsServer, config.port, `https://${config.host}:${config.port} (h2, h1 fallback)`);

  if (config.allowPlaintextHttp) {
    // Escape hatch for a fleet whose core has no TLS backend (spec section 10). Admin paths
    // are refused with 426 by the requireTls middleware.
    const httpServer = http.createServer(app);
    servers.push(httpServer);
    await listen(httpServer, config.httpPort, `http://${config.host}:${config.httpPort}`);
    logger.warn('Plaintext HTTP is enabled; it serves /api/v1 only and /admin returns 426.');
  }

  setInterval(housekeeping, 24 * 3600 * 1000).unref();
}

function assertRequiredSecrets() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  // Still required with Keycloak in play: it signs the LOCAL admin session, which is the
  // break-glass route this server keeps for when the IdP is down.
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  // Only when the fleet still authenticates with it. Under FLEET_AUTH_MODE=jwt nothing ever
  // reads the key, so demanding one would be asking for a secret to satisfy a check rather
  // than a purpose — and an unused secret is one more thing to leak.
  if (config.fleetAuthMode !== 'jwt' && !config.apiKeys.size) missing.push('UPDATE_API_KEYS');

  if (!missing.length) return;

  if (isProduction()) {
    logger.error(`Refusing to start: ${missing.join(', ')} must be set in production`);
    process.exit(1);
  }
  for (const name of missing) logger.warn(`${name} is not set`);
  if (!config.jwtSecret) {
    logger.error('JWT_SECRET is required even in development; set it and restart');
    process.exit(1);
  }
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.host, () => {
      server.removeListener('error', reject);
      logger.info(`AeroServer [${config.env}] listening on ${label}`);
      resolve();
    });
  });
}

async function summariseCatalog() {
  try {
    const channels = await listChannels();
    if (!channels.length) {
      logger.warn('No channels are configured yet; every check answers update_available:false');
      return;
    }
    for (const channel of channels) {
      logger.info(
        `channel ${channel.system}/${channel.name}: latest=${channel.latest ?? '(none)'}`,
      );
    }
  } catch (err) {
    logger.error('could not read the catalog at boot', err);
  }
}

async function housekeeping() {
  try {
    const removed = await pruneTempFiles(tempDir());
    if (removed) logger.info(`removed ${removed} abandoned upload temp files`);
    await pruneCheckLog();
    await pruneExpiredTokens();
    await pruneLoginAttempts();
  } catch (err) {
    logger.error('housekeeping failed', err);
  }
}

/** Stop accepting connections, drain in-flight requests, force exit on timeout. */
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);

  const timer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeout).unref();

  Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    .then(() => closePool())
    .then(() => {
      clearTimeout(timer);
      logger.info('Shutdown complete');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Failed to shut down cleanly', err);
      process.exit(1);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  shutdown('uncaughtException');
});

main().catch((err) => {
  logger.error('Startup failed', err);
  process.exit(1);
});
