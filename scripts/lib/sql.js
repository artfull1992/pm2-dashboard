// SQL builders for the setup script. Identifiers are whitelisted, literals are quoted.

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

export function assertIdentifier(name) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new TypeError(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

export function quoteIdent(name) {
  return `"${assertIdentifier(name)}"`;
}

export function quoteLiteral(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('SQL literal must be a string without NUL bytes');
  }
  // standard_conforming_strings is on by default (PostgreSQL >= 9.1): only quotes need doubling.
  return `'${value.replaceAll("'", "''")}'`;
}

export function createRoleSql(role, verifier) {
  return `CREATE ROLE ${quoteIdent(role)} WITH ${ROLE_ATTRIBUTES} PASSWORD ${quoteLiteral(verifier)};`;
}

export function setRolePasswordSql(role, verifier) {
  return `ALTER ROLE ${quoteIdent(role)} WITH PASSWORD ${quoteLiteral(verifier)};`;
}

export function enforceRoleAttributesSql(role) {
  return `ALTER ROLE ${quoteIdent(role)} WITH ${ROLE_ATTRIBUTES};`;
}

export function createDatabaseSql(database, owner) {
  return `CREATE DATABASE ${quoteIdent(database)} WITH OWNER ${quoteIdent(owner)} ENCODING 'UTF8' TEMPLATE template0;`;
}

// Only the owner role may connect; PUBLIC (every other role on the cluster) loses CONNECT/TEMP.
export function restrictDatabaseSql(database, role) {
  return [
    `REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM PUBLIC;`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(role)};`,
  ].join('\n');
}
