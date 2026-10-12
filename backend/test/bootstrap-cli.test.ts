import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_USAGE, EXIT, type InputStream, readHidden, readPasswordFromStdin, runBootstrapCli } from '../src/bootstrap-cli.js';
import type { Database, QueryClient } from '../src/database.js';
import { FAKE_SECRET } from './helpers.js';

const PASSWORD = 'synthetic-Admin-Passw0rd-42';
const dbEnv = { DB_NAME: 'node_control_test_db', DB_USER: 'node_control_test_user', DB_PASS: FAKE_SECRET };

class FakeStdin extends EventEmitter implements InputStream {
  isTTY: boolean;
  rawModes: boolean[] = [];
  constructor(tty = false) { super(); this.isTTY = tty; }
  setRawMode(mode: boolean) { this.rawModes.push(mode); return this; }
  resume() { return this; }
  pause() { return this; }
}

function pipe(text: string): FakeStdin {
  const stdin = new FakeStdin(false);
  setImmediate(() => { stdin.emit('data', Buffer.from(text)); stdin.emit('end'); });
  return stdin;
}

function typed(...lines: string[]): FakeStdin {
  const stdin = new FakeStdin(true);
  let i = 0;
  const feed = () => { const line = lines[i++]; if (line !== undefined) setImmediate(() => stdin.emit('data', line)); };
  stdin.on('newListener', (event) => { if (event === 'data') feed(); });
  return stdin;
}

/** Records SQL; answers bootstrap queries according to the scenario; transaction rolls back on error. */
function fakeDb(scenario: { adminExists?: boolean; emailTaken?: boolean; failOn?: string } = {}) {
  const committed: string[][] = [];
  const db = {
    close: vi.fn(() => Promise.resolve()),
    transaction: vi.fn(async <T>(fn: (c: QueryClient) => Promise<T>): Promise<T> => {
      const sql: string[] = [];
      const client = {
        query: (text: string, values?: readonly unknown[]) => {
          sql.push(text);
          if (scenario.failOn && text.includes(scenario.failOn)) return Promise.reject(Object.assign(new Error(`boom ${FAKE_SECRET}`), { code: 'ECONNRESET' }));
          if (text.includes("role = 'admin'")) return Promise.resolve({ rows: scenario.adminExists ? [{}] : [], rowCount: 0 });
          if (text.startsWith('SELECT 1 FROM users WHERE email')) return Promise.resolve({ rows: scenario.emailTaken ? [{}] : [], rowCount: 0 });
          if (text.startsWith('INSERT INTO users')) {
            expect(values?.[1]).toMatch(/^scrypt\$v1\$/);
            expect(values).not.toContain(PASSWORD);
            return Promise.resolve({ rows: [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      } as unknown as QueryClient;
      const result = await fn(client); // throws → nothing "committed"
      committed.push(sql);
      return result;
    }),
  };
  return { db: db as unknown as Database, committed, close: db.close };
}

function run(argv: string[], stdin: InputStream, db = fakeDb(), env: Record<string, string> = dbEnv) {
  let out = '';
  let err = '';
  const promise = runBootstrapCli(argv, {
    env, stdin,
    stdout: { write: (c: string) => { out += c; } },
    stderr: { write: (c: string) => { err += c; } },
    createDatabase: () => db.db,
  });
  return promise.then((code) => ({ code, out, err, db }));
}

describe('arguments and input (fail closed)', () => {
  it.each([[[]], [['--email']], [['--email', 'x', '--password', 'p']], [['positional']], [['--email', 'not-an-email']]])('rejects %j', async (argv) => {
    const r = await run(argv, pipe(PASSWORD));
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain(BOOTSTRAP_USAGE);
    expect(r.db.committed).toEqual([]);
  });

  it('without a terminal, --password-stdin is required', async () => {
    const r = await run(['--email', 'admin@example.test'], pipe(PASSWORD));
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('no terminal: use --password-stdin');
  });

  it.each([
    ['too short', 'short-pass'],
    ['multi-line', `${PASSWORD}\nsecond`],
    ['NUL byte', `${PASSWORD}\0`],
    ['empty', ''],
  ])('stdin password %s → refused, nothing written, never echoed', async (_name, input) => {
    const r = await run(['--email', 'admin@example.test', '--password-stdin'], pipe(input));
    expect(r.code).toBe(EXIT.usage);
    expect(r.db.committed).toEqual([]);
    if (input.length > 0) expect(r.out + r.err).not.toContain(input.split('\n')[0]);
  });

  it('oversized stdin is rejected', async () => {
    await expect(readPasswordFromStdin(pipe('x'.repeat(5000)))).rejects.toThrow(/too large/);
  });

  it('readPasswordFromStdin strips exactly one trailing newline', async () => {
    await expect(readPasswordFromStdin(pipe(`${PASSWORD}\r\n`))).resolves.toBe(PASSWORD);
    await expect(readPasswordFromStdin(pipe(` ${PASSWORD} \n`))).resolves.toBe(` ${PASSWORD} `);
  });

  it('invalid DB configuration → error, keys only', async () => {
    const r = await run(['--email', 'admin@example.test', '--password-stdin'], pipe(PASSWORD), fakeDb(), { DB_PASS: FAKE_SECRET });
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toContain('DB_NAME is required');
    expect(r.err).not.toContain(FAKE_SECRET);
  });
});

describe('hidden terminal input', () => {
  it('reads without echo, supports backspace, restores raw mode', async () => {
    const stdin = typed(`${PASSWORD}x\u007f\r`);
    let err = '';
    await expect(readHidden(stdin, { write: (c: string) => { err += c; } }, 'Password: ')).resolves.toBe(PASSWORD);
    expect(err).toBe('Password: \n');
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it('Ctrl-C aborts and restores raw mode', async () => {
    const stdin = typed('abc\u0003');
    await expect(readHidden(stdin, { write: () => undefined }, 'P: ')).rejects.toThrow('aborted');
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it('TTY: password entered twice; mismatch refuses', async () => {
    const ok = await run(['--email', 'admin@example.test'], typed(`${PASSWORD}\r`, `${PASSWORD}\r`));
    expect(ok.code).toBe(EXIT.created);
    expect(ok.out + ok.err).not.toContain(PASSWORD);
    const mismatch = await run(['--email', 'admin@example.test'], typed(`${PASSWORD}\r`, `${PASSWORD}-other\r`));
    expect(mismatch.code).toBe(EXIT.usage);
    expect(mismatch.err).toContain('passwords do not match');
    expect(mismatch.db.committed).toEqual([]);
  });
});

describe('bootstrap transaction outcomes', () => {
  const args = ['--email', ' Admin@Example.TEST ', '--password-stdin'];

  it('creates the admin: lock → checks → insert → audit, in one transaction', async () => {
    const r = await run(args, pipe(`${PASSWORD}\n`));
    expect(r.code).toBe(EXIT.created);
    expect(r.out).toBe('[bootstrap-admin] created administrator 00000000-0000-4000-8000-000000000001\n');
    expect(r.err).toContain('target node_control_test_user@127.0.0.1:5432/node_control_test_db');
    expect(r.db.committed).toHaveLength(1);
    const sql = r.db.committed[0] ?? [];
    expect(sql[0]).toBe('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    expect(sql.at(-1)).toMatch(/^INSERT INTO audit_log/);
    expect(r.db.close).toHaveBeenCalledOnce();
  });

  it('refuses when an admin exists (no reset) or the email is taken (no promotion)', async () => {
    const exists = await run(args, pipe(PASSWORD), fakeDb({ adminExists: true }));
    expect(exists.code).toBe(EXIT.refused);
    expect(exists.err).toContain('an administrator already exists');
    expect((exists.db.committed[0] ?? []).some((q) => q.startsWith('INSERT'))).toBe(false);
    const taken = await run(args, pipe(PASSWORD), fakeDb({ emailTaken: true }));
    expect(taken.code).toBe(EXIT.refused);
    expect(taken.err).toContain('no promotion');
  });

  it('audit failure → error, transaction not committed, metadata only', async () => {
    const r = await run(args, pipe(PASSWORD), fakeDb({ failOn: 'INSERT INTO audit_log' }));
    expect(r.code).toBe(EXIT.error);
    expect(r.db.committed).toEqual([]);
    expect(r.err).toBe('[bootstrap-admin] target node_control_test_user@127.0.0.1:5432/node_control_test_db\n[bootstrap-admin] failed (category=system code=ECONNRESET); nothing was committed\n');
    expect(r.db.close).toHaveBeenCalledOnce();
  });
});
