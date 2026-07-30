import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { config } from '../config/index.js';
import { logger } from './logger.js';

const run = promisify(execFile);

/**
 * Load the TLS key pair, generating a self-signed certificate when neither file exists.
 *
 * crypto.X509Certificate can only PARSE certificates, so generating one means shelling out
 * to openssl. The certificate lives on a volume, so a restart keeps the same identity.
 */
export async function loadTlsContext() {
  const certPath = config.tlsCertFile;
  const keyPath = config.tlsKeyFile;

  const [hasCert, hasKey] = await Promise.all([exists(certPath), exists(keyPath)]);

  // Half a key pair is a misconfiguration, not something to paper over by regenerating.
  if (hasCert !== hasKey) {
    throw new Error(
      `TLS is half-configured: ${hasCert ? 'certificate' : 'key'} exists but the other does not `
      + `(${certPath}, ${keyPath})`,
    );
  }

  let generated = false;
  if (!hasCert) {
    await generateSelfSigned(certPath, keyPath);
    generated = true;
  }

  const [cert, key] = await Promise.all([
    fsp.readFile(certPath, 'utf8'),
    fsp.readFile(keyPath, 'utf8'),
  ]);

  return { cert, key, generated, ...describe(cert) };
}

/** Parse the certificate for the boot log and the admin UI. */
export function describe(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return {
      subject: x509.subject.replace(/\n/g, ', '),
      issuer: x509.issuer.replace(/\n/g, ', '),
      validTo: x509.validTo,
      validFrom: x509.validFrom,
      fingerprint256: x509.fingerprint256,
      subjectAltName: x509.subjectAltName || '',
      selfSigned: x509.subject === x509.issuer,
      daysRemaining: Math.floor((new Date(x509.validTo) - Date.now()) / 86_400_000),
    };
  } catch (err) {
    logger.warn('could not parse TLS certificate', err.message);
    return { subject: '', issuer: '', selfSigned: false, daysRemaining: null };
  }
}

/** Log what the operator needs to know, including what to provision into a node. */
export function logCertificate(info) {
  logger.info(`TLS certificate: ${info.subject || '(unparsed)'}`);
  logger.info(`TLS SAN: ${info.subjectAltName || '(none)'}`);
  logger.info(`TLS fingerprint (SHA-256): ${info.fingerprint256}`);
  logger.info(`TLS valid until: ${info.validTo} (${info.daysRemaining} days)`);

  if (info.generated) {
    logger.warn('A self-signed certificate was generated. Nodes and browsers must be told to '
      + 'trust the fingerprint above; mount a real certificate for production.');
  } else if (info.selfSigned) {
    logger.warn('The TLS certificate is self-signed.');
  }

  if (info.selfSigned) {
    // HSTS is suppressed for exactly this reason; say so, because the alternative is an
    // operator locked out of the UI wondering why the browser will not let them through.
    logger.warn('HSTS is disabled while the certificate is self-signed: sending it would make '
      + 'the browser certificate warning impossible to click through.');

    const names = info.subjectAltName || '';
    if (!/IP Address:(?!127\.0\.0\.1|0:0:0:0:0:0:0:1)/.test(names)) {
      logger.warn('The certificate names no address other than localhost. Reaching this server '
        + 'from another machine needs that address in TLS_SAN, then delete the certificate '
        + 'files so it is regenerated.');
    }
  }
  if (info.daysRemaining !== null && info.daysRemaining < 14) {
    logger.warn(`The TLS certificate expires in ${info.daysRemaining} days.`);
  }
}

/**
 * Reload the certificate in place when the file changes, so a renewal does not need a
 * restart. Existing connections keep the old context; new ones get the new one.
 */
export function watchCertificate(server) {
  const targets = [config.tlsCertFile, config.tlsKeyFile];
  const watchers = [];
  let timer = null;

  const reload = () => {
    clearTimeout(timer);
    // Renewal tools write both files; debounce so we reload once, after both have landed.
    timer = setTimeout(async () => {
      try {
        const [cert, key] = await Promise.all([
          fsp.readFile(config.tlsCertFile, 'utf8'),
          fsp.readFile(config.tlsKeyFile, 'utf8'),
        ]);
        server.setSecureContext({ cert, key });
        logCertificate({ ...describe(cert), generated: false });
        logger.info('TLS certificate reloaded');
      } catch (err) {
        logger.error('TLS certificate reload failed; keeping the previous one', err.message);
      }
    }, 500).unref?.();
  };

  for (const target of targets) {
    try {
      const watcher = fs.watch(target, reload);
      watcher.unref?.();
      watchers.push(watcher);
    } catch (err) {
      logger.warn(`cannot watch ${target} for changes: ${err.message}`);
    }
  }
  return () => watchers.forEach((w) => w.close());
}

async function generateSelfSigned(certPath, keyPath) {
  await fsp.mkdir(path.dirname(certPath), { recursive: true });
  await fsp.mkdir(path.dirname(keyPath), { recursive: true });

  const cn = config.tlsCn;
  // A modern browser ignores CN entirely, and a verifying client rejects any address not
  // listed here — so every address this server will be dialled by has to be named.
  const entries = [`DNS:${cn}`, 'DNS:localhost', 'IP:127.0.0.1', 'IP:::1'];
  for (const extra of config.tlsSan) {
    entries.push(/^(DNS|IP):/.test(extra) ? extra
      : `${/^\d+\.\d+\.\d+\.\d+$/.test(extra) ? 'IP' : 'DNS'}:${extra}`);
  }
  const san = [...new Set(entries)].join(',');

  logger.warn(`No TLS certificate at ${certPath}; generating a self-signed one for CN=${cn}`);
  logger.warn(`subjectAltName=${san}`);

  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=${san}`,
  ]);

  await fsp.chmod(keyPath, 0o600);
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}
