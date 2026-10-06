-- Remove local password authentication. Keycloak is the only way in (Constitution I, 2.0.0).
--
-- WHAT SURVIVES, and why it looks like it should not:
--
--   admin_user  STAYS. It is not the local account's table — every Keycloak sign-in upserts
--               a row into it (authenticateExternal → upsertExternalUser), and it is what
--               /auth/me returns an id from, what "cut this account's sessions" acts on,
--               and what the audit trail names. Only its two password columns go.
--
--   registration_attempt  STAYS. It throttles the self-service sign-up form by address, and
--               that form creates accounts in the shared Keycloak realm, not here. Dropping
--               it would leave an open form with no ceiling.
--
-- ORDER MATTERS: the rows go before the columns. A row that exists only because it had a
-- password must not be left behind with the reason for it already gone.

-- 1. Local accounts. A row with no external identity has no way to be signed in to any more.
DELETE FROM admin_user WHERE external_id IS NULL;

-- 2. Sessions this server issued itself. A Keycloak session's refresh token lives in a
--    browser cookie and was never stored here, so nothing of the remaining kind is lost.
DROP TABLE IF EXISTS refresh_token;

-- 3. Throttling that existed to slow down password guessing.
DROP TABLE IF EXISTS login_attempt;

-- 4. The password itself, and the timestamp that tracked when it last changed.
ALTER TABLE admin_user
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS password_changed_at;
