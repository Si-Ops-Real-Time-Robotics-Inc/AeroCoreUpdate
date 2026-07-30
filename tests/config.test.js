import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Defaults, read from a process where the variable genuinely does not exist.
 *
 * A test that sets the variable to the value it expects proves nothing about the default, and
 * `process.env` cannot hold `undefined` — assigning it stores the string "undefined", which
 * would be read as a channel named "undefined". The only honest way to ask what happens when
 * an operator configures nothing is to start a process with nothing configured.
 */
async function defaultOf(key, expression) {
  const env = { ...process.env };
  delete env[key];
  // Enough to satisfy the required-variable check; none of it affects what is being read.
  Object.assign(env, {
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(24),
    UPDATE_API_KEYS: 'k:0123456789abcdefghij',
    DATABASE_URL: 'postgres://x@127.0.0.1/x',
  });

  const { stdout } = await run(process.execPath, [
    '--input-type=module',
    '-e', `const { config } = await import('./src/config/index.js');
           process.stdout.write(JSON.stringify(${expression}));`,
  ], { env, cwd: new URL('..', import.meta.url).pathname });

  return JSON.parse(stdout);
}

test('a fresh upload lands on beta when nothing is configured', async () => {
  // The staging channel, not the fleet: only devices an operator deliberately put on beta
  // follow it, so an accidental upload reaches the test group and stops there.
  assert.equal(await defaultOf('AUTO_PROMOTE_CHANNEL', 'config.autoPromoteChannel'), 'beta');
});

test('an empty value means "land nowhere", and is distinguishable from unset', async () => {
  const env = { ...process.env, AUTO_PROMOTE_CHANNEL: '' };
  Object.assign(env, {
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(24),
    UPDATE_API_KEYS: 'k:0123456789abcdefghij',
    DATABASE_URL: 'postgres://x@127.0.0.1/x',
  });

  const { stdout } = await run(process.execPath, [
    '--input-type=module',
    '-e', `const { config } = await import('./src/config/index.js');
           process.stdout.write(JSON.stringify(config.autoPromoteChannel));`,
  ], { env, cwd: new URL('..', import.meta.url).pathname });

  assert.equal(JSON.parse(stdout), '', 'an operator can still opt out of landing anywhere');
});
