-- Up Migration
-- Users table: foundation for the next authentication task. No data, no default admin, no seeds.
--
-- Contract (docs/DECISIONS.md, ADR-010):
--  * id: UUID from gen_random_uuid() — built into PostgreSQL 13+ core, no extension needed.
--  * email: stored normalized (trimmed, lower-case). The application normalizes before writing;
--    the CHECK rejects non-normalized values, so the plain UNIQUE constraint is case-insensitive in effect.
--  * password_hash: an encoded hash only (algorithm chosen in the authentication task); never plaintext.
--  * updated_at: maintained by the BEFORE UPDATE trigger, not by callers.
-- Objects are unqualified on purpose: the runner sets search_path (public in production, a per-run schema in tests).

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email))),
  CONSTRAINT users_email_format CHECK (char_length(email) BETWEEN 3 AND 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT users_password_hash_not_empty CHECK (char_length(password_hash) > 0),
  CONSTRAINT users_email_key UNIQUE (email)
);

CREATE FUNCTION users_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION users_set_updated_at();
