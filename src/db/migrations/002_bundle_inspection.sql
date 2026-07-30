-- Server-side inspection of the uploaded .tar.gz (services/bundleInspect.service.js).

-- Which container format the upload turned out to be. NULL means the row predates inspection,
-- which is NOT the same as 'legacy' — the UI must render those differently.
ALTER TABLE artifact ADD COLUMN bundle_format TEXT
  CHECK (bundle_format IN ('bundle', 'legacy'));

-- The full report: declared components, per-platform core slice versions, and the warnings
-- that did not block the upload. Without it those warnings exist only in the 201 response and
-- an operator can never see again why an artifact was accepted.
ALTER TABLE artifact ADD COLUMN inspection JSONB;

-- The packaging scripts write the literal string 'unknown' when a plugin was built with no
-- version define. That is a real, expected state, so the literal is stored and flagged rather
-- than coerced or rejected. Everything that orders versions must consult this flag first:
-- isNewer('unknown', x) throws.
ALTER TABLE artifact_plugin ADD COLUMN version_known BOOLEAN NOT NULL DEFAULT true;

-- Lets PUT /artifacts/:id/metadata replace an operator's own rows without wiping the ones the
-- bundle supplied.
ALTER TABLE artifact_plugin ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'bundle'));

-- kind and platform were only kept consistent by convention.
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_platform_ck
  CHECK ((kind = 'fleet' AND platform IS NULL) OR (kind = 'slim' AND platform IS NOT NULL));

-- UNIQUE (version, kind, platform) never stopped a second fleet row: every fleet row has
-- platform IS NULL, and Postgres treats NULLs as DISTINCT in a unique index. The only guard
-- was an advisory SELECT in publish.service.js — a TOCTOU race two concurrent CI uploads can
-- lose, leaving two rows and one set of bytes. Slim rows are already covered.
CREATE UNIQUE INDEX artifact_fleet_uniq ON artifact (version) WHERE platform IS NULL;
