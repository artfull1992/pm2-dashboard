-- Up Migration
-- User administration and self-service password change (ADR-019). Additive only and compatible with the previous
-- release, which neither reads nor writes these objects.
--
--  * credential_version: bumped in the same transaction as every security-relevant user change (password, role,
--    activity) together with revoking all of the user's sessions. Login re-checks it under a row lock when creating
--    a session, so a login that verified the old password before the change cannot create a session after it.
--    Existing users (the bootstrap admin) start at 1.
--  * (created_at, id) index: keyset pagination of the admin user list.
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

ALTER TABLE users
  ADD COLUMN credential_version bigint NOT NULL DEFAULT 1
  CONSTRAINT users_credential_version_positive CHECK (credential_version >= 1);

CREATE INDEX users_created_at_id_idx ON users (created_at, id);
