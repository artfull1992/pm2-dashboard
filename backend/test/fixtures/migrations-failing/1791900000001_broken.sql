-- Up Migration
-- Test fixture (never packaged): partial work followed by an error — the whole run must roll back.
CREATE TABLE partial_object (id int);
INSERT INTO table_that_does_not_exist VALUES (1);
