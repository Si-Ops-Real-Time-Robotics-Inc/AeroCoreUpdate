-- Catalog: what releases exist, what artifacts they ship, and which channel points where.

CREATE TABLE release (
  version      TEXT PRIMARY KEY,
  -- Component-wise int array so SQL sorts versions correctly. `ORDER BY version` on the
  -- text column would put 0.9.0 above 0.10.0 and silently invert a rollout.
  version_key  INT[]       NOT NULL,
  min_version  TEXT,
  mandatory    BOOLEAN     NOT NULL DEFAULT false,
  notes        TEXT,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT
);

CREATE TABLE artifact (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version    TEXT   NOT NULL REFERENCES release(version) ON DELETE CASCADE,
  kind       TEXT   NOT NULL CHECK (kind IN ('fleet', 'slim')),
  platform   TEXT,                      -- NULL for a fleet catalog bundle
  -- The platform set this artifact covers. Source of the signed `target` field; stored as an
  -- array so canonicalTarget() alone decides the ordering.
  platforms  TEXT[] NOT NULL,
  file       TEXT   NOT NULL,
  size       BIGINT NOT NULL,
  sha256     TEXT   NOT NULL,
  -- Pre-signed artifacts: lets an operator keep the private key in the release pipeline
  -- instead of on the server that serves files (spec section 10).
  signature_alg    TEXT,
  signature_key_id TEXT,
  signature_value  TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by TEXT,
  UNIQUE (version, kind, platform)
);
CREATE INDEX artifact_version_idx ON artifact (version);

-- Per-plugin versions are NOT recorded in the bundle manifest (spec section 5), so this
-- table is the only possible source for the `plan` in a fleet response.
CREATE TABLE artifact_plugin (
  artifact_id BIGINT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  platform    TEXT   NOT NULL,
  name        TEXT   NOT NULL,
  version     TEXT   NOT NULL,
  PRIMARY KEY (artifact_id, platform, name)
);

-- The params this release sets, mirroring the bundle's `config` components.
CREATE TABLE artifact_config (
  artifact_id BIGINT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  platform    TEXT   NOT NULL,
  target      TEXT   NOT NULL,          -- 'core' or a plugin name
  param       TEXT   NOT NULL,          -- dotted 'group.param'
  value       JSONB  NOT NULL,
  PRIMARY KEY (artifact_id, platform, target, param)
);

CREATE TABLE channel (
  name       TEXT PRIMARY KEY,
  latest     TEXT REFERENCES release(version) ON DELETE SET NULL,
  paused     BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_pin (
  channel TEXT NOT NULL REFERENCES channel(name) ON DELETE CASCADE,
  serial  TEXT NOT NULL,
  version TEXT NOT NULL REFERENCES release(version) ON DELETE CASCADE,
  PRIMARY KEY (channel, serial)
);

CREATE TABLE channel_deny (
  channel TEXT NOT NULL REFERENCES channel(name) ON DELETE CASCADE,
  serial  TEXT NOT NULL,
  reason  TEXT,
  PRIMARY KEY (channel, serial)
);

-- Bumped in the same transaction as any admin change that alters an answer. Feeding it into
-- the ETag is what makes pausing a rollout invalidate every cached check immediately.
CREATE TABLE catalog_rev (
  id  BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  rev BIGINT  NOT NULL DEFAULT 1
);
INSERT INTO catalog_rev (id, rev) VALUES (true, 1);

-- Update outcomes reported by nodes (spec section 11).
CREATE TABLE node_report (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  serial       TEXT,
  platform     TEXT,
  role         TEXT,
  from_version TEXT,
  to_version   TEXT,
  result       TEXT,
  error        TEXT,
  at           TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fleet        TEXT,
  raw          JSONB NOT NULL
);
CREATE INDEX node_report_rollout_idx ON node_report (to_version, result);
CREATE INDEX node_report_serial_idx  ON node_report (serial, received_at DESC);

-- One row per check, so an operator can see what version each serial is actually running.
CREATE TABLE check_log (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  serial           TEXT,
  platform         TEXT,
  version          TEXT,
  role             TEXT,
  channel          TEXT,
  form             TEXT NOT NULL CHECK (form IN ('get', 'post')),
  offered          TEXT,
  update_available BOOLEAN NOT NULL,
  fleet            TEXT
);
CREATE INDEX check_log_serial_idx ON check_log (serial, at DESC);
CREATE INDEX check_log_at_idx     ON check_log (at DESC);

CREATE TABLE audit (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT,
  action  TEXT NOT NULL,
  subject TEXT,
  detail  JSONB
);
CREATE INDEX audit_at_idx ON audit (at DESC);

-- Admin accounts. Only admins reach the web UI; fleet clients authenticate with X-API-Key
-- and never touch these tables.
CREATE TABLE admin_user (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username            TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,
  disabled            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens are opaque random values (not JWTs) so they can be revoked, and only their
-- SHA-256 is stored. `family` implements rotation with reuse detection.
CREATE TABLE refresh_token (
  jti        UUID PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  token_hash TEXT   NOT NULL,
  family     UUID   NOT NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX refresh_token_user_idx   ON refresh_token (user_id, expires_at);
CREATE INDEX refresh_token_family_idx ON refresh_token (family);

CREATE TABLE login_attempt (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT,
  ip       TEXT,
  success  BOOLEAN NOT NULL
);
CREATE INDEX login_attempt_user_idx ON login_attempt (username, at DESC);
CREATE INDEX login_attempt_ip_idx   ON login_attempt (ip, at DESC);
