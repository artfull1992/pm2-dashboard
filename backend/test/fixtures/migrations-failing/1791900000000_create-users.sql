-- Up Migration
-- Test fixture (never packaged): a valid first migration followed by a failing second one.
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL);
