import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_PATH = join(PROJECT_ROOT, '.env');

export const DB_DEFAULTS = Object.freeze({
  DB_NAME: 'node_control_db',
  DB_USER: 'node_control_user',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
});

// The only pg_hba.conf rule this project adds: TLS-only, SCRAM-only, scoped to its own DB and role.
export const HBA_RULE = Object.freeze({
  type: 'hostssl',
  database: DB_DEFAULTS.DB_NAME,
  user: DB_DEFAULTS.DB_USER,
  address: '0.0.0.0/0',
  method: 'scram-sha-256',
});

export const HBA_RULE_COMMENT = 'GOIT Node Control: remote TLS access, scoped to node_control_db/node_control_user only';
