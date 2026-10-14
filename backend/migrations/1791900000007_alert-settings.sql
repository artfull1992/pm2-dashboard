-- Up Migration
-- Admin-managed alert settings and Slack integration (ADR-022). Additive: new tables + nullable/defaulted columns and
-- a widened status set. The previous release ignores all of it (it reads ALERTS_* from env only).
-- No plaintext secret is stored: the webhook is AES-256-GCM ciphertext; the key lives only in api.env.
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

-- Singleton (id = 1). The row is created on first API start from defaults (never overwritten afterwards).
CREATE TABLE alert_settings (
  id                      smallint    PRIMARY KEY DEFAULT 1,
  revision                bigint      NOT NULL DEFAULT 1,
  -- The revision at which the rule thresholds last changed (condition streaks reset when it moves).
  rules_revision          bigint      NOT NULL DEFAULT 1,
  engine_enabled          boolean     NOT NULL DEFAULT false,
  delivery_enabled        boolean     NOT NULL DEFAULT false,
  cpu_open_percent        integer     NOT NULL,
  cpu_close_percent       integer     NOT NULL,
  memory_open_percent     integer     NOT NULL,
  memory_close_percent    integer     NOT NULL,
  confirm_samples         integer     NOT NULL,
  recover_samples         integer     NOT NULL,
  status_confirm_samples  integer     NOT NULL,
  restarts_threshold      integer     NOT NULL,
  restarts_window_minutes integer     NOT NULL,
  interval_seconds        integer     NOT NULL,
  cooldown_minutes        integer     NOT NULL,
  reminder_enabled        boolean     NOT NULL DEFAULT false,
  reminder_minutes        integer     NOT NULL,
  http_timeout_ms         integer     NOT NULL,
  max_attempts            integer     NOT NULL,
  queue_max               integer     NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT alert_settings_singleton CHECK (id = 1),
  CONSTRAINT alert_settings_revision CHECK (revision >= 1 AND rules_revision BETWEEN 1 AND revision),
  CONSTRAINT alert_settings_cpu CHECK (cpu_open_percent BETWEEN 1 AND 10000 AND cpu_close_percent BETWEEN 0 AND 10000 AND cpu_close_percent < cpu_open_percent),
  CONSTRAINT alert_settings_memory CHECK (memory_open_percent BETWEEN 1 AND 100 AND memory_close_percent BETWEEN 0 AND 100 AND memory_close_percent < memory_open_percent),
  CONSTRAINT alert_settings_samples CHECK (confirm_samples BETWEEN 1 AND 20 AND recover_samples BETWEEN 1 AND 20 AND status_confirm_samples BETWEEN 1 AND 20),
  CONSTRAINT alert_settings_restarts CHECK (restarts_threshold BETWEEN 1 AND 1000 AND restarts_window_minutes BETWEEN 2 AND 1440),
  CONSTRAINT alert_settings_timing CHECK (interval_seconds BETWEEN 10 AND 600 AND cooldown_minutes BETWEEN 0 AND 1440 AND reminder_minutes BETWEEN 1 AND 10080),
  CONSTRAINT alert_settings_delivery CHECK (http_timeout_ms BETWEEN 1000 AND 30000 AND max_attempts BETWEEN 1 AND 15 AND queue_max BETWEEN 10 AND 1000)
);

-- Singleton (id = 1). generation increases on every configure/replace/remove; the outbox is bound to it.
CREATE TABLE alert_slack_integration (
  id                   smallint    PRIMARY KEY DEFAULT 1,
  generation           bigint      NOT NULL DEFAULT 0,
  ciphertext           bytea,
  nonce                bytea,
  tag                  bytea,
  key_version          integer,
  configured_at        timestamptz,
  configured_by        uuid        REFERENCES users (id) ON DELETE SET NULL,
  last_test_id         uuid,
  last_test_generation bigint,
  last_test_outcome    text,
  last_test_code       text,
  last_test_at         timestamptz,
  CONSTRAINT alert_slack_integration_singleton CHECK (id = 1),
  CONSTRAINT alert_slack_integration_generation CHECK (generation >= 0),
  CONSTRAINT alert_slack_integration_secret CHECK (
    (ciphertext IS NULL) = (nonce IS NULL) AND (ciphertext IS NULL) = (tag IS NULL) AND (ciphertext IS NULL) = (key_version IS NULL)
    AND (ciphertext IS NULL) = (configured_at IS NULL)
    AND (ciphertext IS NULL OR (octet_length(nonce) = 12 AND octet_length(tag) = 16 AND octet_length(ciphertext) BETWEEN 40 AND 512 AND key_version BETWEEN 1 AND 1000))),
  CONSTRAINT alert_slack_integration_test CHECK (last_test_outcome IS NULL OR (last_test_outcome IN ('success', 'failed', 'unknown') AND last_test_at IS NOT NULL AND last_test_generation IS NOT NULL)),
  CONSTRAINT alert_slack_integration_test_code CHECK (last_test_code IS NULL OR last_test_code ~ '^[a-z0-9_]{1,40}$')
);
INSERT INTO alert_slack_integration (id) VALUES (1);

-- Outbox items are bound to the integration generation they were queued for; cancelled = never sent to another address.
ALTER TABLE alert_outbox ADD COLUMN generation bigint;
ALTER TABLE alert_outbox DROP CONSTRAINT alert_outbox_status;
ALTER TABLE alert_outbox ADD CONSTRAINT alert_outbox_status CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown', 'dropped', 'cancelled'));
ALTER TABLE alert_outbox DROP CONSTRAINT alert_outbox_finished;
ALTER TABLE alert_outbox ADD CONSTRAINT alert_outbox_finished CHECK ((status IN ('sent', 'failed', 'unknown', 'dropped', 'cancelled')) = (finished_at IS NOT NULL));
-- Items queued by the env-configured release (no generation) are never delivered by the new worker.
UPDATE alert_outbox SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = 'integration_changed'
 WHERE status IN ('queued', 'sending');

-- Condition streaks belong to the rules revision they were counted under (a rules change resets pending streaks).
ALTER TABLE alert_conditions ADD COLUMN rules_revision bigint NOT NULL DEFAULT 0;
