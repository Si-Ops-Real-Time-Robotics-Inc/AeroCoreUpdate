-- Two channels per system, fixed: `beta` and `stable`.
--
-- A release lands on beta when it is uploaded and reaches stable only when an admin promotes
-- it. With the set closed there is nothing to name, nothing to create, and the promote button
-- needs no dropdown — the target is the only other channel there is.

-- Every system gets both, including ones that predate this.
INSERT INTO channel (system, name, latest, updated_at)
SELECT s.name, c.name, NULL, now()
FROM system s CROSS JOIN (VALUES ('beta'), ('stable')) AS c(name)
ON CONFLICT (system, name) DO NOTHING;

-- ── pause, pin and deny are removed ───────────────────────────────────────────────────────
--
-- All three were reachable only from the Channels tab, which is gone. Dropping them rather
-- than leaving them unwritten: a column nobody sets, that the check path still reads, is how
-- a rollout gets silently withheld from a fleet six months from now with no way to see why.
--
-- IRREVERSIBLE. Taken with `0 pins, 0 denies, 0 paused` on the live database, so nothing is
-- being destroyed — but a deployment that had used them would lose that state here.
--
-- What this costs: the only remaining brake on a bad release is pointing stable back at the
-- previous version. That path refuses to move a channel backwards unless the caller passes
-- `allow_rollback`, so THAT flag is now the emergency exit, not a convenience.
DROP TABLE IF EXISTS channel_pin;
DROP TABLE IF EXISTS channel_deny;
ALTER TABLE channel DROP COLUMN IF EXISTS paused;
