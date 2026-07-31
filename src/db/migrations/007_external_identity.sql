-- Admin accounts that come from an external identity provider (Keycloak).
--
-- Why a local row at all when the token already names the user: everything on this server
-- refers to an admin by `admin_user.id` — refresh_token.user_id, audit actors, artifact
-- uploaded_by. Keycloak's `sub` is a UUID, not that integer. Rather than rewrite every one
-- of those, an externally-authenticated user gets a local row created on first sign-in and
-- keyed to their `sub`.
--
-- password_hash is NOT NULL on this table, so external rows carry a sentinel that no scrypt
-- comparison can ever match. That is deliberate: such an account must be unable to sign in
-- with a password, and a value that cannot verify is a stronger guarantee than a flag some
-- future code path might forget to check.
ALTER TABLE admin_user
  ADD COLUMN external_id     TEXT,
  ADD COLUMN external_issuer TEXT;

-- One local row per external subject. Partial, so the many rows with NULL external_id (the
-- local accounts, including the break-glass one) are unaffected.
CREATE UNIQUE INDEX admin_user_external_idx
  ON admin_user (external_issuer, external_id)
  WHERE external_id IS NOT NULL;
