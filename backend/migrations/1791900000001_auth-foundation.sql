-- Up Migration
-- Auth foundation (ADR-011): role on users, server-side sessions, structured audit log.
-- Additive only and compatible with the previous health-only release (which does not read these objects).
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

ALTER TABLE users
  ADD COLUMN role text NOT NULL DEFAULT 'viewer'
  CONSTRAINT users_role_valid CHECK (role IN ('admin', 'operator', 'viewer'));

-- One row per login. Only the SHA-256 digest of the opaque cookie token is stored.
-- Absolute expiry: expires_at is fixed at creation and never extended.
CREATE TABLE sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT sessions_revoked_after_creation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Append-only structured events. details holds only server-defined keys/values (no credentials,
-- tokens, cookies, bodies or raw client input); size is capped.
CREATE TABLE audit_log (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  event         text        NOT NULL,
  outcome       text        NOT NULL,
  actor_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  request_id    uuid,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_log_event_format CHECK (event ~ '^[a-z]+(\.[a-z_]+)+$' AND char_length(event) <= 64),
  CONSTRAINT audit_log_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT audit_log_details_object CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2048)
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id);
