-- Up Migration
-- Alerts engine and Slack notifications (ADR-021). Additive only; the previous release does not read these tables.
-- No secrets are stored here: the webhook URL lives only in api.env. Rendered message text is not stored either —
-- it is built at delivery time from the incident's server-defined fields.
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

-- Evaluation state per condition key (rule + server [+ process]). Holds debounce/hysteresis counters and, for the
-- restart rule, the bounded baseline samples. Written only by the evaluator (single, under an advisory lock).
CREATE TABLE alert_conditions (
  condition_key  text        PRIMARY KEY,
  server_id      uuid        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  rule           text        NOT NULL,
  process_key    text,
  state          text        NOT NULL,
  streak         integer     NOT NULL DEFAULT 0,
  last_sample_at timestamptz,
  samples        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  incident_id    uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_conditions_key_len CHECK (char_length(condition_key) BETWEEN 1 AND 400),
  CONSTRAINT alert_conditions_rule CHECK (rule IN ('server_offline', 'inventory_stale', 'process_down', 'process_cpu', 'server_memory', 'process_restarts')),
  CONSTRAINT alert_conditions_state CHECK (state IN ('ok', 'pending', 'firing', 'recovering')),
  CONSTRAINT alert_conditions_streak CHECK (streak BETWEEN 0 AND 1000),
  CONSTRAINT alert_conditions_samples CHECK (jsonb_typeof(samples) = 'array' AND jsonb_array_length(samples) <= 64)
);
CREATE INDEX alert_conditions_server_idx ON alert_conditions (server_id);

-- One row per incident. At most one open (firing) incident per condition key.
CREATE TABLE alert_incidents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_key    text        NOT NULL,
  server_id        uuid        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  rule             text        NOT NULL,
  severity         text        NOT NULL,
  status           text        NOT NULL DEFAULT 'firing',
  resolution       text,
  server_name      text        NOT NULL,
  process_name     text,
  pm_id            integer,
  detail           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  notify           boolean     NOT NULL,
  opened_at        timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  resolved_at      timestamptz,
  CONSTRAINT alert_incidents_rule CHECK (rule IN ('server_offline', 'inventory_stale', 'process_down', 'process_cpu', 'server_memory', 'process_restarts')),
  CONSTRAINT alert_incidents_severity CHECK (severity IN ('critical', 'warning')),
  CONSTRAINT alert_incidents_status CHECK (status IN ('firing', 'resolved')),
  CONSTRAINT alert_incidents_resolution CHECK ((status = 'resolved') = (resolution IS NOT NULL AND resolved_at IS NOT NULL)
    AND (resolution IS NULL OR resolution IN ('recovered', 'process_gone', 'excluded'))),
  CONSTRAINT alert_incidents_names CHECK (char_length(server_name) BETWEEN 1 AND 100 AND (process_name IS NULL OR char_length(process_name) BETWEEN 1 AND 128)),
  CONSTRAINT alert_incidents_detail CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 1024)
);
CREATE UNIQUE INDEX alert_incidents_one_open_idx ON alert_incidents (condition_key) WHERE status = 'firing';
CREATE INDEX alert_incidents_open_idx ON alert_incidents (opened_at, id) WHERE status = 'firing';
CREATE INDEX alert_incidents_resolved_idx ON alert_incidents (resolved_at DESC, id DESC) WHERE status = 'resolved';
CREATE INDEX alert_incidents_key_idx ON alert_incidents (condition_key, resolved_at DESC);

-- Durable, bounded delivery queue (at-least-once to Slack). Claimed with a lease (FOR UPDATE SKIP LOCKED).
CREATE TABLE alert_outbox (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id     uuid        NOT NULL REFERENCES alert_incidents (id) ON DELETE CASCADE,
  kind            text        NOT NULL,
  status          text        NOT NULL DEFAULT 'queued',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT alert_outbox_kind CHECK (kind IN ('firing', 'resolved', 'reminder')),
  CONSTRAINT alert_outbox_status CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown', 'dropped')),
  CONSTRAINT alert_outbox_attempts CHECK (attempts BETWEEN 0 AND 20),
  CONSTRAINT alert_outbox_error CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT alert_outbox_finished CHECK ((status IN ('sent', 'failed', 'unknown', 'dropped')) = (finished_at IS NOT NULL)),
  CONSTRAINT alert_outbox_lease CHECK (status <> 'sending' OR lease_until IS NOT NULL)
);
CREATE UNIQUE INDEX alert_outbox_once_idx ON alert_outbox (incident_id, kind) WHERE kind IN ('firing', 'resolved');
CREATE INDEX alert_outbox_pending_idx ON alert_outbox (next_attempt_at, id) WHERE status IN ('queued', 'sending');
CREATE INDEX alert_outbox_incident_idx ON alert_outbox (incident_id, id DESC);
CREATE INDEX alert_outbox_finished_idx ON alert_outbox (finished_at) WHERE finished_at IS NOT NULL;
