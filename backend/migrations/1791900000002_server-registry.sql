-- Up Migration
-- Server registry, Agent credentials and latest heartbeat (ADR-015). Additive only; compatible with the previous
-- release, which does not read these tables. Objects are unqualified (runner sets search_path).

CREATE TABLE servers (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT servers_name_key UNIQUE (name),
  CONSTRAINT servers_name_format CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]')
);
-- Keyset pagination: ORDER BY created_at, id.
CREATE INDEX servers_created_at_id_idx ON servers (created_at, id);

-- Machine credentials: only SHA-256 digests of the opaque bearer token are stored.
CREATE TABLE agent_credentials (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  uuid        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  token_hash bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT agent_credentials_token_hash_key UNIQUE (token_hash),
  CONSTRAINT agent_credentials_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT agent_credentials_revoked_after_creation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
-- At most one active credential per server (rotation revokes the previous one in the same transaction).
CREATE UNIQUE INDEX agent_credentials_one_active_idx ON agent_credentials (server_id) WHERE revoked_at IS NULL;

-- Latest accepted heartbeat per server. received_at is the SERVER clock; no history is kept.
CREATE TABLE server_heartbeats (
  server_id   uuid        PRIMARY KEY REFERENCES servers (id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  snapshot    jsonb       NOT NULL,
  CONSTRAINT server_heartbeats_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 2048)
);
