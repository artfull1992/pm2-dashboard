-- Up Migration
-- Role + resource access (ADR-028). Additive only; the previous release neither reads nor writes these objects (it
-- would ignore the grants and treat operator/viewer globally — see the rollback note in ADR-028).
--
--  * user_server_access: a server granted to a user, mode 'all' (every current and future service of THAT server)
--    or 'selected' (only the names in user_service_access). No row = no access. admin never needs rows.
--  * user_service_access: selected services by PM2 process name (service identity, ADR-028; pm_id is never used).
--  * users.access_revision: optimistic concurrency of the admin access editor (bumped on every grant change).
--  * control_commands.service_name / target_identity: the service a command acts on (scope of history and of the
--    dispatch re-check) and the process definition identity it was requested for (auto broker, ADR-028).
--  * server_control_targets.identity / logs, server_control_status.protocol / mode: version-2 Agent reports.
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

ALTER TABLE users
  ADD COLUMN access_revision bigint NOT NULL DEFAULT 0
  CONSTRAINT users_access_revision_nonnegative CHECK (access_revision >= 0);

CREATE TABLE user_server_access (
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  server_id  uuid        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  mode       text        NOT NULL,
  granted_by uuid        REFERENCES users (id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_server_access_pkey PRIMARY KEY (user_id, server_id),
  CONSTRAINT user_server_access_mode CHECK (mode IN ('all', 'selected'))
);
CREATE INDEX user_server_access_server_idx ON user_server_access (server_id);

CREATE TABLE user_service_access (
  user_id      uuid        NOT NULL,
  server_id    uuid        NOT NULL,
  service_name text        NOT NULL,
  granted_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_service_access_pkey PRIMARY KEY (user_id, server_id, service_name),
  CONSTRAINT user_service_access_server_fkey FOREIGN KEY (user_id, server_id) REFERENCES user_server_access (user_id, server_id) ON DELETE CASCADE,
  CONSTRAINT user_service_access_name CHECK (char_length(service_name) BETWEEN 1 AND 128 AND service_name !~ '[[:cntrl:]]')
);
CREATE INDEX user_service_access_server_name_idx ON user_service_access (server_id, service_name);

ALTER TABLE control_commands
  ADD COLUMN service_name text
    CONSTRAINT control_commands_service_name CHECK (service_name IS NULL OR (char_length(service_name) BETWEEN 1 AND 128 AND service_name !~ '[[:cntrl:]]')),
  ADD COLUMN target_identity text
    CONSTRAINT control_commands_target_identity CHECK (target_identity IS NULL OR target_identity ~ '^[0-9a-f]{16}$');
CREATE INDEX control_commands_service_idx ON control_commands (server_id, service_name, requested_at DESC, id);

ALTER TABLE server_control_targets
  ADD COLUMN identity text CONSTRAINT server_control_targets_identity CHECK (identity IS NULL OR identity ~ '^[0-9a-f]{16}$'),
  ADD COLUMN logs boolean NOT NULL DEFAULT false;

ALTER TABLE server_control_status
  ADD COLUMN protocol smallint NOT NULL DEFAULT 1 CONSTRAINT server_control_status_protocol CHECK (protocol IN (1, 2)),
  ADD COLUMN mode text CONSTRAINT server_control_status_mode CHECK (mode IS NULL OR mode IN ('allowlist', 'auto')),
  -- Version 2: how many targets the broker knows; more than reported = the list was cut at 500 (shown, never silent).
  ADD COLUMN targets_total integer CONSTRAINT server_control_status_targets_total CHECK (targets_total IS NULL OR targets_total >= 0);
