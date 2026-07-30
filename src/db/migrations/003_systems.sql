-- Systems: AeroCore runs on different kinds of device — drone, GCS — that need different
-- plugin sets and different config even when they share a platform.
--
-- The node cannot tell us which kind it is. Its update client sends exactly five fields
-- (serial, platform, version, role, channel); `role` is a hardcoded literal in C++, and
-- `serial` is blanked by any OTA that carries config. So the system is derived from the
-- version the node reports: each system has its own version line, every release belongs to
-- exactly one system, and release.version stays globally unique — which makes that lookup
-- unambiguous.

CREATE TABLE system (
  name        TEXT PRIMARY KEY,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT
);

-- Everything published before systems existed keeps working, under one name.
INSERT INTO system (name, description, created_by)
VALUES ('default', 'Releases published before systems existed.', 'migration');

-- ── releases belong to a system ───────────────────────────────────────────────────────────

ALTER TABLE release ADD COLUMN system TEXT REFERENCES system(name);
UPDATE release SET system = 'default' WHERE system IS NULL;
ALTER TABLE release ALTER COLUMN system SET NOT NULL;

-- The lookup behind every check: newest release of one system.
CREATE INDEX release_system_idx ON release (system, version_key DESC);

-- ── channels are per-system ───────────────────────────────────────────────────────────────
-- A channel's `latest` names one version, and a version belongs to one system, so a single
-- global "stable" cannot serve two systems at once.

ALTER TABLE channel_pin  DROP CONSTRAINT IF EXISTS channel_pin_channel_fkey;
ALTER TABLE channel_deny DROP CONSTRAINT IF EXISTS channel_deny_channel_fkey;

ALTER TABLE channel ADD COLUMN system TEXT REFERENCES system(name);
UPDATE channel SET system = 'default' WHERE system IS NULL;
ALTER TABLE channel ALTER COLUMN system SET NOT NULL;
ALTER TABLE channel DROP CONSTRAINT channel_pkey;
ALTER TABLE channel ADD PRIMARY KEY (system, name);

ALTER TABLE channel_pin ADD COLUMN system TEXT;
UPDATE channel_pin SET system = 'default' WHERE system IS NULL;
ALTER TABLE channel_pin ALTER COLUMN system SET NOT NULL;
ALTER TABLE channel_pin DROP CONSTRAINT channel_pin_pkey;
ALTER TABLE channel_pin ADD PRIMARY KEY (system, channel, serial);
ALTER TABLE channel_pin
  ADD FOREIGN KEY (system, channel) REFERENCES channel(system, name) ON DELETE CASCADE;

ALTER TABLE channel_deny ADD COLUMN system TEXT;
UPDATE channel_deny SET system = 'default' WHERE system IS NULL;
ALTER TABLE channel_deny ALTER COLUMN system SET NOT NULL;
ALTER TABLE channel_deny DROP CONSTRAINT channel_deny_pkey;
ALTER TABLE channel_deny ADD PRIMARY KEY (system, channel, serial);
ALTER TABLE channel_deny
  ADD FOREIGN KEY (system, channel) REFERENCES channel(system, name) ON DELETE CASCADE;

-- ── nodes we cannot classify ──────────────────────────────────────────────────────────────
-- A node whose version matches no release could belong to any system. Guessing would mean
-- pushing drone firmware to a GCS, so it is refused an update and parked here for an admin.
--
-- `assigned_system` is that admin's answer, and the only way out of this table: a
-- factory-fresh device reports a version this server never published, so no amount of
-- waiting will classify it. Rows are kept after assignment — the mapping IS the row.

CREATE TABLE unclassified_node (
  serial          TEXT PRIMARY KEY,
  platform        TEXT,
  version         TEXT,
  role            TEXT,
  channel         TEXT,
  fleet           TEXT,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count      INTEGER NOT NULL DEFAULT 1,
  assigned_system TEXT REFERENCES system(name) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ,
  assigned_by     TEXT
);
CREATE INDEX unclassified_node_seen_idx ON unclassified_node (last_seen DESC);
-- The check path reads this on every request from a node it has an assignment for.
CREATE INDEX unclassified_node_assigned_idx ON unclassified_node (assigned_system)
  WHERE assigned_system IS NOT NULL;

-- check_log records which system answered, so the fleet view can group by it.
ALTER TABLE check_log ADD COLUMN system TEXT;
