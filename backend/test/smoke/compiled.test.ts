// Smoke tests of the compiled API (backend/dist). Run via `npm run test:backend:smoke`, which builds first.
// The spawned process gets a fully controlled environment and ENV_FILE pointing nowhere,
// so the developer's real .env is never read.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SECRET, freePort } from '../helpers.js';

const MAIN = join(import.meta.dirname, '..', '..', 'dist', 'main.js');
const NODE = process.env.SMOKE_NODE_BINARY ?? process.execPath;
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

beforeAll(() => {
  if (!existsSync(MAIN)) throw new Error(`${MAIN} missing — run npm run backend:build first`);
});

async function baseEnv(overrides: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? '',
    ENV_FILE: join(import.meta.dirname, 'does-not-exist.env'),
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: String(await freePort()),
    LOG_LEVEL: 'info',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(await freePort()), // nothing listens here → readiness must be 503
    DB_NAME: 'smoke_db',
    DB_USER: 'smoke_user',
    DB_PASS: FAKE_SECRET,
    ...overrides,
  };
}

function start(env: Record<string, string>) {
  const child = spawn(NODE, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => { resolve(code); }));
  const waitFor = async (text: string, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!output.includes(text)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`"${text}" not seen; output:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { child, exited, waitFor, output: () => output };
}

describe('compiled API smoke', () => {
  it('reports the Node.js runtime under test', async () => {
    const version = spawn(NODE, ['-v']);
    let out = '';
    version.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    await new Promise((resolve) => version.on('exit', resolve));
    console.log(`smoke runtime: ${out.trim()}`);
    expect(out.trim()).toMatch(/^v\d+\./);
  });

  it('serves live 200 / ready 503 without a database and exits 0 on SIGTERM', async () => {
    const env = await baseEnv();
    const api = start(env);
    await api.waitFor('API started');
    const base = `http://127.0.0.1:${env.API_PORT}`;

    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(await ready.json()).toEqual({ status: 'unavailable' });

    expect((await fetch(`${base}/nope`)).status).toBe(404);

    api.child.kill('SIGTERM');
    api.child.kill('SIGTERM'); // repeated signal must not cause a second cleanup or crash
    expect(await api.exited).toBe(0);
    expect(api.output()).toContain('Shutdown complete');
    expect(api.output().match(/Shutdown complete/g)).toHaveLength(1);
    expect(api.output()).not.toContain(FAKE_SECRET);
    expect(api.output()).not.toMatch(/smoke_user|smoke_db/);
  });

  it('SIGINT also shuts down with exit 0', async () => {
    const api = start(await baseEnv());
    await api.waitFor('API started');
    api.child.kill('SIGINT');
    expect(await api.exited).toBe(0);
  });

  it('invalid configuration blocks startup with exit 1 and no secret values', async () => {
    const api = start(await baseEnv({ API_PORT: '70000', LOG_LEVEL: 'loud', DB_NAME: '' }));
    expect(await api.exited).toBe(1);
    const out = api.output();
    expect(out).toContain('Invalid configuration, API not started');
    expect(out).toContain('API_PORT must be an integer between 1 and 65535');
    expect(out).toContain('LOG_LEVEL must be one of');
    expect(out).toContain('DB_NAME is required');
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).not.toContain('70000');
  });

  it('port already in use → exit 1 after cleanup', async () => {
    const env = await baseEnv();
    const first = start(env);
    await first.waitFor('API started');
    const second = start(env);
    expect(await second.exited).toBe(1);
    expect(second.output()).toContain('Failed to start listener');
    expect(second.output()).toContain('Shutdown complete');
    first.child.kill('SIGTERM');
    expect(await first.exited).toBe(0);
  });
});
