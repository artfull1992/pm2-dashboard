import { parseArgs } from 'node:util';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { normalizeEmail } from './auth/email.js';
import { checkPasswordPolicy, hashPassword, PASSWORD_POLICY } from './auth/password.js';
import { ConfigError, type DbConfig, type EnvSource, loadConfig } from './config.js';
import { createDatabase, type Database } from './database.js';
import { describeError, formatErrorMeta } from './errors.js';

// One-time creation of the first administrator (ADR-011). No HTTP endpoint, no default credentials.
// The password comes from a hidden terminal prompt (entered twice) or, with --password-stdin, from stdin.
// It is never accepted as an argument and never printed.

export const BOOTSTRAP_USAGE = 'usage: bootstrap-admin.js --email <email> [--password-stdin]   (config: ENV_FILE and/or DB_*)';
export const EXIT = Object.freeze({ created: 0, error: 1, usage: 2, refused: 3 });
const MAX_STDIN_BYTES = 4096;

export interface InputStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'error', listener: (arg?: unknown) => void): unknown;
  removeAllListeners(event?: string): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface BootstrapIo {
  env: EnvSource;
  stdin: InputStream;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** Test seam (per-run schema pools). */
  createDatabase?: (db: DbConfig) => Database;
}

export class InputError extends Error {}

/** Whole stdin (bounded); exactly one optional trailing newline is removed; no other control characters allowed. */
export function readPasswordFromStdin(stdin: InputStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stdin.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_STDIN_BYTES) {
        stdin.removeAllListeners();
        reject(new InputError('stdin input too large'));
        return;
      }
      chunks.push(buf);
    });
    stdin.on('error', () => { reject(new InputError('stdin read failed')); });
    stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      if (/[\r\n\0]/.test(text)) reject(new InputError('stdin must contain the password on a single line'));
      else resolve(text);
    });
    stdin.resume();
  });
}

/** Raw-mode terminal read without echo. Ctrl-C/Ctrl-D abort; backspace edits. Raw mode is always restored. */
export function readHidden(stdin: InputStream, stderr: { write(chunk: string): unknown }, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: InputError) => {
      stdin.removeAllListeners('data');
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.on('data', (chunk) => {
      for (const char of typeof chunk === 'string' ? chunk : chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u0003' || char === '\u0004') { finish(new InputError('aborted')); return; }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join(''); // removes one code point
        else if (char >= ' ') value += char;
        if (Buffer.byteLength(value) > MAX_STDIN_BYTES) { finish(new InputError('input too large')); return; }
      }
    });
    stdin.resume();
  });
}

async function readPassword(io: BootstrapIo, fromStdin: boolean): Promise<string> {
  if (fromStdin) return readPasswordFromStdin(io.stdin);
  if (!io.stdin.isTTY || !io.stdin.setRawMode) throw new InputError('no terminal: use --password-stdin with a protected input');
  const first = await readHidden(io.stdin, io.stderr, 'New admin password: ');
  const second = await readHidden(io.stdin, io.stderr, 'Repeat password: ');
  if (first !== second) throw new InputError('passwords do not match');
  return first;
}

export async function runBootstrapCli(argv: readonly string[], io: BootstrapIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { email: { type: 'string' }, 'password-stdin': { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    io.stderr.write(`${BOOTSTRAP_USAGE}\n`);
    return EXIT.usage;
  }
  const email = values.email === undefined ? null : normalizeEmail(values.email);
  if (email === null) {
    io.stderr.write(`[bootstrap-admin] --email is required and must be a valid address\n${BOOTSTRAP_USAGE}\n`);
    return EXIT.usage;
  }

  let db: DbConfig;
  try {
    db = loadConfig(io.env).db;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`Invalid configuration, nothing done:\n${error.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return EXIT.error;
  }
  io.stderr.write(`[bootstrap-admin] target ${db.user}@${db.host}:${String(db.port)}/${db.database}\n`);

  let password: string;
  try {
    password = await readPassword(io, values['password-stdin']);
  } catch (error) {
    io.stderr.write(`[bootstrap-admin] ${error instanceof InputError ? error.message : 'input failed'}; nothing done\n`);
    return EXIT.usage;
  }
  const problem = checkPasswordPolicy(password);
  if (problem) {
    io.stderr.write(`[bootstrap-admin] password ${problem.replace('_', ' ')} (${String(PASSWORD_POLICY.minCodePoints)}–${String(PASSWORD_POLICY.maxCodePoints)} characters); nothing done\n`);
    return EXIT.usage;
  }

  const database = (io.createDatabase ?? ((cfg: DbConfig) => createDatabase(cfg, { error: () => undefined })))(db);
  try {
    const passwordHash = await hashPassword(password);
    const result = await bootstrapAdmin(database, { email, passwordHash });
    if (result.status === 'created') {
      io.stdout.write(`[bootstrap-admin] created administrator ${result.userId}\n`);
      return EXIT.created;
    }
    io.stderr.write(result.status === 'admin-exists'
      ? '[bootstrap-admin] an administrator already exists; refusing (no reset, no second bootstrap)\n'
      : '[bootstrap-admin] a user with this email already exists; refusing (no promotion)\n');
    return EXIT.refused;
  } catch (error) {
    io.stderr.write(`[bootstrap-admin] failed (${formatErrorMeta(describeError(error))}); nothing was committed\n`);
    return EXIT.error;
  } finally {
    await database.close().catch(() => undefined);
  }
}
