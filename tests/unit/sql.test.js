import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertIdentifier,
  createDatabaseSql,
  createRoleSql,
  enforceRoleAttributesSql,
  quoteIdent,
  quoteLiteral,
  restrictDatabaseSql,
  setRolePasswordSql,
} from '../../scripts/lib/sql.js';

test('accepts plain lowercase identifiers', () => {
  assert.equal(assertIdentifier('node_control_db'), 'node_control_db');
  assert.equal(quoteIdent('node_control_user'), '"node_control_user"');
});

test('rejects identifiers that could inject SQL', () => {
  for (const bad of ['', 'Upper', 'a"b', 'a;drop', 'x y', '1abc', 'a'.repeat(64), null]) {
    assert.throws(() => assertIdentifier(bad), TypeError, String(bad));
  }
});

test('quoteLiteral doubles single quotes and rejects NUL', () => {
  assert.equal(quoteLiteral("it's"), "'it''s'");
  assert.throws(() => quoteLiteral('a\0b'), TypeError);
  assert.throws(() => quoteLiteral(42), TypeError);
});

test('role is created with least privilege and a verifier', () => {
  const sql = createRoleSql('node_control_user', 'SCRAM-SHA-256$4096:c2Fs$a2V5:a2V5');
  for (const attr of ['LOGIN', 'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS']) {
    assert.match(sql, new RegExp(`\\b${attr}\\b`));
  }
  assert.match(sql, /^CREATE ROLE "node_control_user" WITH .* PASSWORD 'SCRAM-SHA-256\$/);
});

test('password change and attribute enforcement target only the given role', () => {
  assert.match(setRolePasswordSql('node_control_user', 'v'), /^ALTER ROLE "node_control_user" WITH PASSWORD 'v';$/);
  assert.match(enforceRoleAttributesSql('node_control_user'), /^ALTER ROLE "node_control_user" WITH LOGIN NOSUPERUSER/);
});

test('database is owned by the role and PUBLIC loses access', () => {
  assert.equal(
    createDatabaseSql('node_control_db', 'node_control_user'),
    `CREATE DATABASE "node_control_db" WITH OWNER "node_control_user" ENCODING 'UTF8' TEMPLATE template0;`,
  );
  const restrict = restrictDatabaseSql('node_control_db', 'node_control_user');
  assert.match(restrict, /REVOKE ALL ON DATABASE "node_control_db" FROM PUBLIC;/);
  assert.match(restrict, /GRANT CONNECT, TEMPORARY ON DATABASE "node_control_db" TO "node_control_user";/);
});
