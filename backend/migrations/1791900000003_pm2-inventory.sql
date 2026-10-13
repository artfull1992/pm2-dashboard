-- Up Migration
-- Read-only PM2 inventory (ADR-016): the latest inventory state per server and the latest successfully collected
-- process list. Additive only; the previous release does not read these tables. No history (time-series) is kept.

-- One row per server that has ever reported. Freshness uses the SERVER clock (reported_at / inventory_collected_at);
-- *_captured_at are the exporter's clock and only order reports of the same host.
CREATE TABLE server_inventories (
  server_id              uuid        PRIMARY KEY REFERENCES servers (id) ON DELETE CASCADE,
  source                 text,
  state                  text        NOT NULL,
  reason                 text,
  reported_at            timestamptz NOT NULL,
  report_captured_at     timestamptz,
  inventory_captured_at  timestamptz,
  inventory_collected_at timestamptz,
  process_count          integer,
  CONSTRAINT server_inventories_source_format CHECK (source IS NULL OR source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT server_inventories_state CHECK (state IN ('ok', 'stale', 'unavailable')),
  CONSTRAINT server_inventories_reason CHECK ((state = 'unavailable') = (reason IS NOT NULL) AND (reason IS NULL OR reason ~ '^[a-z_]{1,40}$')),
  CONSTRAINT server_inventories_data_together CHECK (
    (inventory_captured_at IS NULL) = (inventory_collected_at IS NULL) AND (inventory_captured_at IS NULL) = (process_count IS NULL)),
  CONSTRAINT server_inventories_data_has_source CHECK (inventory_captured_at IS NULL OR source IS NOT NULL),
  CONSTRAINT server_inventories_process_count CHECK (process_count IS NULL OR process_count BETWEEN 0 AND 500)
);

-- Latest successfully collected PM2 processes. Identity = (server, source, pm_id); pm_id can be reused by PM2 after a
-- delete, so a changed name under the same pm_id is treated as a new application (first_seen_at resets).
-- A successful snapshot replaces the whole set for its server, so rows are bounded by process_count (≤ 500).
CREATE TABLE server_applications (
  server_id      uuid        NOT NULL REFERENCES server_inventories (server_id) ON DELETE CASCADE,
  source         text        NOT NULL,
  pm_id          integer     NOT NULL,
  name           text        NOT NULL,
  status         text        NOT NULL,
  uptime_seconds integer,
  restarts       integer,
  cpu_percent    numeric(6, 1),
  memory_bytes   bigint,
  exec_mode      text,
  first_seen_at  timestamptz NOT NULL,
  CONSTRAINT server_applications_pkey PRIMARY KEY (server_id, source, pm_id),
  CONSTRAINT server_applications_source_format CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT server_applications_pm_id CHECK (pm_id BETWEEN 0 AND 1000000),
  CONSTRAINT server_applications_name CHECK (char_length(name) BETWEEN 1 AND 128 AND name !~ '[[:cntrl:]]'),
  CONSTRAINT server_applications_status CHECK (status IN ('online', 'stopping', 'stopped', 'launching', 'errored', 'one-launch-status', 'waiting restart', 'unknown')),
  CONSTRAINT server_applications_uptime CHECK (uptime_seconds IS NULL OR uptime_seconds BETWEEN 0 AND 315576000),
  CONSTRAINT server_applications_restarts CHECK (restarts IS NULL OR restarts BETWEEN 0 AND 1000000000),
  CONSTRAINT server_applications_cpu CHECK (cpu_percent IS NULL OR cpu_percent BETWEEN 0 AND 10000),
  CONSTRAINT server_applications_memory CHECK (memory_bytes IS NULL OR memory_bytes BETWEEN 0 AND 1125899906842624),
  CONSTRAINT server_applications_exec_mode CHECK (exec_mode IS NULL OR exec_mode IN ('fork', 'cluster'))
);
-- Global listing: keyset ORDER BY name, server_id, pm_id.
CREATE INDEX server_applications_name_idx ON server_applications (name, server_id, pm_id);
