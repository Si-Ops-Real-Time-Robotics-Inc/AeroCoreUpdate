import { isNewer } from './version.js';

/**
 * Is pointing `system/name` from `current` to `next` a move backwards, and if so, what to say.
 *
 * Moving a channel backwards is almost always a mistyped promote, and it looks harmless
 * because no node downgrades: decide() refuses anything not strictly newer. But a device
 * fresh from the factory has no such protection — it takes whatever the channel points at, so
 * the fleet quietly splits into "updated before the slip" and "provisioned after".
 *
 * Pure, and shared by both paths that can move a channel: the promote endpoint and the upload
 * that names one. Two implementations of this is how the careful one drifts from the other,
 * and the drift would show up as a channel that moved backwards on the path nobody re-read.
 *
 * Returns a finding rather than throwing, so a caller inside a transaction can decide what to
 * do with it. Shape matches bundle inspection's findings: a caller offers the confirmation
 * instead of parsing English prose to discover there is one.
 *
 * @returns {{rule: string, message: string, from: string, to: string}|null}
 */
export function rollbackFinding(system, name, current, next) {
  if (!current || !next || !isNewer(current, next)) return null;

  const message =
    `${system}/${name} is on ${current}; ${next} is older. Nodes already `
    + 'updated will not go back, but newly provisioned ones would take it. Send '
    + '"allow_rollback": true if that is what you intend.';

  return { rule: 'channel_rollback', message, from: current, to: next };
}
