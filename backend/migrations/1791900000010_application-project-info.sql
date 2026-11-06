-- Up Migration
-- Project information of an application (ADR-036): reference links and a short description an administrator keeps
-- for a service. Additive only; the previous release neither reads nor writes this table (rollback = previous code,
-- the rows stay and are used again after the next upgrade).
--
-- Identity = (server, PM2 process name), the same service identity as selective access (ADR-028): processes with the
-- same name on one server share it, a changed pm_id keeps it, and a name that disappears and comes back on the same
-- server gets its information back. Inventory reports never touch this table (it has no reference to
-- server_applications, whose rows are replaced on every snapshot).
--
-- No row = nothing saved yet (revision 0 for the API). The first save inserts revision 1; every later change bumps it
-- (optimistic concurrency, expectedRevision). Clearing every field keeps the row (and its revision) with NULLs.
-- Objects are unqualified: the runner sets search_path (public in production, a per-run schema in tests).

CREATE TABLE application_project_info (
  server_id    uuid        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  service_name text        NOT NULL,
  github_url   text,
  project_url  text,
  description  text,
  revision     bigint      NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT application_project_info_pkey PRIMARY KEY (server_id, service_name),
  CONSTRAINT application_project_info_service_name CHECK (char_length(service_name) BETWEEN 1 AND 128 AND service_name !~ '[[:cntrl:]]'),
  CONSTRAINT application_project_info_revision CHECK (revision >= 1),
  -- The API validates the exact formats (https://github.com/<owner>/<repository>, explicit http(s) without
  -- credentials); the database keeps the bounds and refuses anything that could never be a plain link.
  CONSTRAINT application_project_info_github_url CHECK (github_url IS NULL OR (
    char_length(github_url) BETWEEN 1 AND 2048 AND github_url ~ '^https://github\.com/[A-Za-z0-9._/-]+$')),
  CONSTRAINT application_project_info_project_url CHECK (project_url IS NULL OR (
    char_length(project_url) BETWEEN 1 AND 2048 AND project_url ~ '^https?://' AND project_url !~ '[[:cntrl:][:space:]\\]')),
  -- Plain text: line breaks and tabs allowed, other control characters not.
  CONSTRAINT application_project_info_description CHECK (description IS NULL OR (
    char_length(description) BETWEEN 1 AND 2000 AND description !~ '[\x01-\x08\x0b-\x1f\x7f-\x9f]'))
);
