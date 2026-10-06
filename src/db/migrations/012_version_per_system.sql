-- A version number is unique within a system, no longer across all of them.
--
-- 003_systems made release.version globally unique because the node could not say which kind
-- of device it was: the version it reported was the only way to find its line, so two systems
-- sharing a number would have made that lookup ambiguous. The node now sends `system` on every
-- check (UpdateClient::check), and the check path requires it, so the version no longer has to
-- carry that information — and keeping it global meant HERA could not ship 0.2.0 because
-- HERAHUB already had, two products that have nothing to do with each other.
--
-- A release is now identified by (system, version), and everything that pointed at a release
-- by version alone points at it by both.

-- ── artifacts learn their system ─────────────────────────────────────────────────────────
-- Filled BEFORE the release key changes: right now each version still names one release, so
-- the join below is unambiguous. After this file it would not be.

ALTER TABLE artifact ADD COLUMN system TEXT;
UPDATE artifact a SET system = r.system FROM release r WHERE r.version = a.version;
ALTER TABLE artifact ALTER COLUMN system SET NOT NULL;

-- ── drop everything keyed to release(version) ────────────────────────────────────────────

ALTER TABLE channel  DROP CONSTRAINT channel_latest_fkey;
ALTER TABLE artifact DROP CONSTRAINT artifact_version_fkey;
ALTER TABLE artifact DROP CONSTRAINT artifact_version_kind_platform_key;
DROP INDEX artifact_fleet_uniq;
DROP INDEX artifact_version_idx;

-- ── re-key ────────────────────────────────────────────────────────────────────────────────

ALTER TABLE release DROP CONSTRAINT release_pkey;
ALTER TABLE release ADD PRIMARY KEY (system, version);

ALTER TABLE artifact
  ADD CONSTRAINT artifact_release_fkey
  FOREIGN KEY (system, version) REFERENCES release(system, version) ON DELETE CASCADE;
ALTER TABLE artifact
  ADD CONSTRAINT artifact_system_version_kind_platform_key UNIQUE (system, version, kind, platform);
-- The fleet row has platform IS NULL, which a unique constraint treats as distinct — see
-- 002_bundle_inspection for why this partial index exists at all.
CREATE UNIQUE INDEX artifact_fleet_uniq ON artifact (system, version) WHERE platform IS NULL;
CREATE INDEX artifact_release_idx ON artifact (system, version);

-- The channel's own system is half of the key, so a channel can only ever point at a release
-- of its own system — a rule the code used to keep by hand (upsertChannel) and the database
-- now keeps for it. MATCH SIMPLE: an empty channel (latest IS NULL) is not checked.
-- Still RESTRICT, for the reason 011_channel_latest_restrict gives.
ALTER TABLE channel
  ADD CONSTRAINT channel_latest_fkey
  FOREIGN KEY (system, latest) REFERENCES release(system, version) ON DELETE RESTRICT;
