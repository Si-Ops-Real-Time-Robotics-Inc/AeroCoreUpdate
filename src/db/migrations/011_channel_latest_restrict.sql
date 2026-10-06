-- A served release cannot be deleted — refused by the database, not only by the code in front
-- of it.
--
-- channel.latest has referenced release(version) since 001_init, ON DELETE SET NULL. So a
-- release deleted while a channel pointed at it did not fail: the database quietly pointed the
-- channel at nothing, and a channel pointing at nothing answers every device "no update". A
-- fleet that has stopped updating and a fleet that is up to date look identical.
--
-- The only thing in the way was the check at the top of deleteRelease, and it ran outside the
-- transaction that deleted. A promote landing between the two lost that race in exactly the
-- way that empties a channel with no sign. Feature 005 also makes a removal lock the release
-- row before it checks; this constraint is what still holds for whoever writes the next path.
--
-- NOTHING RELIES ON SET NULL, which is why this is safe on a live database:
--   - deleteSystem refuses while the system has any release, so it never deletes one;
--   - upsertChannel refuses to point a channel at another system's release;
--   - deleteRelease always meant to refuse a served release — SET NULL fired only when that
--     refusal was raced.
-- Existing rows are untouched: RESTRICT matters only at the moment a release is deleted.

ALTER TABLE channel DROP CONSTRAINT channel_latest_fkey;

ALTER TABLE channel
  ADD CONSTRAINT channel_latest_fkey
  FOREIGN KEY (latest) REFERENCES release(version) ON DELETE RESTRICT;
