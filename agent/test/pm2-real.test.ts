import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectInventory, loadExporterConfig, runExporter } from '../src/pm2/exporter.js';

// Opt-in (npm run test:agent:pm2): a REAL, disposable PM2 daemon in a temporary PM2_HOME — never the user's PM2.
// pm2 is not a project dependency (AGPL); it is fetched by npx at a pinned version only for this test.
// Evidence for ADR-016: the exporter does not start a daemon when none runs, reads a running one without leaking
// secrets, and after `pm2 kill` reports daemon_not_running without resurrecting it.

const enabled = process.env.NC_TEST_REAL_PM2 === '1';
const PM2 = 'pm2@7.0.4';
const SECRET = 'SYNTHETIC_REAL_PM2_SECRET_51f0';
const base = mkdtempSync(join(tmpdir(), 'ncpm2-'));
const home = join(base, 'h');
const out = join(base, 'out');
mkdirSync(home, { mode: 0o700 });
mkdirSync(out, { mode: 0o750 });

function pm2(...args: string[]) {
  const r = spawnSync('npx', ['-y', PM2, ...args], { env: { ...process.env, PM2_HOME: home, NC_E2E_SECRET: SECRET }, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`pm2 ${args[0] ?? ''} failed (exit ${String(r.status)})`);
}

afterAll(() => {
  if (enabled && existsSync(join(home, 'rpc.sock'))) {
    try { pm2('kill'); } catch { /* best effort */ }
  }
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!enabled)('real PM2 daemon (disposable PM2_HOME)', () => {
  const config = () => loadExporterConfig({ NC_PM2_HOME: home, NC_PM2_SNAPSHOT_FILE: join(out, 'inventory.json'), NC_PM2_TIMEOUT_SECONDS: '10' });

  it('no daemon → daemon_not_running and NOTHING is started or created in PM2_HOME', async () => {
    const result = await collectInventory(config());
    expect(result).toMatchObject({ state: 'unavailable', reason: 'daemon_not_running' });
    await new Promise((r) => setTimeout(r, 1000));
    expect(readdirSync(home)).toEqual([]);
  });

  it('running daemon → sanitised inventory, no env secret in the snapshot; then kill → no resurrection', async () => {
    const script = join(base, 'app.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    pm2('start', script, '--name', 'nc-real-app', '--', '--token', SECRET);
    await new Promise((r) => setTimeout(r, 2000));
    const { snapshot } = await runExporter(config());
    expect(snapshot.state).toBe('ok');
    expect(snapshot.processes).toEqual([expect.objectContaining({ pmId: 0, name: 'nc-real-app', status: 'online', execMode: 'fork' })]);
    const disk = readFileSync(join(out, 'inventory.json'), 'utf8');
    expect(disk).not.toContain(SECRET);
    expect(disk).not.toContain(base);

    pm2('kill');
    expect(existsSync(join(home, 'rpc.sock'))).toBe(false);
    const after = await collectInventory(config());
    expect(after).toMatchObject({ state: 'unavailable', reason: 'daemon_not_running' });
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(join(home, 'rpc.sock'))).toBe(false);
    expect(existsSync(join(home, 'pm2.pid'))).toBe(false);
  }, 180_000);
});
