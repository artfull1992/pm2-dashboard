-- Up Migration
-- Allowlisted PM2 process control (ADR-017). Additive only; the previous release does not read these tables.

-- Latest broker state per server as reported by its Agent (server clock).
CREATE TABLE server_control_status (
  server_id    uuid        PRIMARY KEY REFERENCES servers (id) ON DELETE CASCADE,
  broker_state text        NOT NULL,
  daemon_state text,
  allowlist    text,
  reported_at  timestamptz NOT NULL,
  CONSTRAINT server_control_status_broker CHECK (broker_state IN ('ok', 'unavailable')),
  CONSTRAINT server_control_status_daemon CHECK (daemon_state IS NULL OR daemon_state IN ('ok', 'unavailable')),
  CONSTRAINT server_control_status_allowlist CHECK (allowlist IS NULL OR allowlist IN ('ok', 'invalid'))
);

-- Targets the broker allows (from its root-owned allowlist) and whether each one currently matches exactly one
-- PM2 process. Replaced as a whole on every report; at most 50 per server.
CREATE TABLE server_control_targets (
  server_id    uuid    NOT NULL REFERENCES server_control_status (server_id) ON DELETE CASCADE,
  target_key   text    NOT NULL,
  name         text    NOT NULL,
  pm_id        integer,
  actions      text[]  NOT NULL,
  match_status text    NOT NULL,
  CONSTRAINT server_control_targets_pkey PRIMARY KEY (server_id, target_key),
  CONSTRAINT server_control_targets_key CHECK (target_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT server_control_targets_name CHECK (char_length(name) BETWEEN 1 AND 128 AND name !~ '[[:cntrl:]]'),
  CONSTRAINT server_control_targets_pm_id CHECK (pm_id IS NULL OR pm_id BETWEEN 0 AND 1000000),
  CONSTRAINT server_control_targets_actions CHECK (cardinality(actions) BETWEEN 1 AND 3 AND actions <@ ARRAY['start', 'stop', 'restart']::text[]),
  CONSTRAINT server_control_targets_match CHECK (match_status IN ('ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable')),
  CONSTRAINT server_control_targets_match_pm_id CHECK ((match_status = 'ok') = (pm_id IS NOT NULL))
);

-- Commands. queued → dispatched → succeeded | failed | rejected | expired | unknown. History is kept (audit trail).
CREATE TABLE control_commands (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  target_key      text        NOT NULL,
  action          text        NOT NULL,
  status          text        NOT NULL DEFAULT 'queued',
  reason          text,
  requested_by    uuid        NOT NULL REFERENCES users (id),
  idempotency_key uuid        NOT NULL,
  requested_at    timestamptz NOT NULL,
  deadline_at     timestamptz NOT NULL,
  attempts        integer     NOT NULL DEFAULT 0,
  lease_until     timestamptz,
  dispatched_at   timestamptz,
  completed_at    timestamptz,
  result          jsonb,
  CONSTRAINT control_commands_idempotency UNIQUE (requested_by, idempotency_key),
  CONSTRAINT control_commands_target_key CHECK (target_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT control_commands_action CHECK (action IN ('start', 'stop', 'restart')),
  CONSTRAINT control_commands_status CHECK (status IN ('queued', 'dispatched', 'succeeded', 'failed', 'rejected', 'expired', 'unknown')),
  CONSTRAINT control_commands_reason CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT control_commands_attempts CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT control_commands_deadline CHECK (deadline_at > requested_at),
  CONSTRAINT control_commands_final CHECK ((status IN ('queued', 'dispatched')) = (completed_at IS NULL)),
  CONSTRAINT control_commands_dispatched CHECK (status <> 'dispatched' OR (lease_until IS NOT NULL AND dispatched_at IS NOT NULL AND attempts >= 1)),
  CONSTRAINT control_commands_result CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 512))
);
-- At most one active command per target (no concurrent actions on one process).
CREATE UNIQUE INDEX control_commands_one_active_idx ON control_commands (server_id, target_key) WHERE status IN ('queued', 'dispatched');
CREATE INDEX control_commands_server_idx ON control_commands (server_id, requested_at DESC, id);
CREATE INDEX control_commands_active_idx ON control_commands (server_id, status) WHERE status IN ('queued', 'dispatched');
