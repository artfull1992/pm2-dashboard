import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBroker, listenBroker, loadBrokerConfig, realDeps } from '../src/control/broker.js';
import { brokerRequest } from '../src/control/client.js';
import { fingerprintOf, stateOf, viewOf } from '../src/control/identity.js';

// Opt-in (npm run test:agent:pm2): the real broker against a REAL, disposable PM2 daemon in a temporary PM2_HOME —
// never a user's PM2. pm2 is fetched by npx (pinned) only for this test; it is not a project dependency (AGPL).

const enabled = process.env.NC_TEST_REAL_PM2 === '1';
const PM2 = 'pm2@7.0.4';
const SECRET = 'SYNTHETIC_REAL_CONTROL_SECRET_77aa';
const base = enabled ? mkdtempSync(join(tmpdir(), 'ncctl-')) : '';
const home = join(base, 'h');
const run = join(base, 'run');
const state = join(base, 'state');
if (enabled) {
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(run, { mode: 0o750 });
  mkdirSync(state, { mode: 0o700 });
}

function pm2(...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_')));
  const r = spawnSync('npx', ['-y', PM2, ...args], { env: { ...env, PM2_HOME: home, NC_E2E_SECRET: SECRET }, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`pm2 ${args[0] ?? ''} failed (exit ${String(r.status)})`);
}

afterAll(() => {
  if (enabled && existsSync(join(home, 'rpc.sock'))) {
    try { pm2('kill'); } catch { /* best effort */ }
  }
  if (base) rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!enabled)('broker against a real PM2 daemon (disposable PM2_HOME)', () => {
  it('start/stop/restart only the allowlisted process; dedup; other process untouched; no daemon → no auto-start', async () => {
    const script = join(base, 'app.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    pm2('start', script, '--name', 'nc-allowed', '--', '--token', SECRET);
    pm2('start', script, '--name', 'nc-other');
    await new Promise((r) => setTimeout(r, 1500));

    const allowlist = join(base, 'allowlist.json');
    const config = loadBrokerConfig({
      NC_PM2_HOME: home, NC_BROKER_SOCKET: join(run, 'broker.sock'), NC_BROKER_ALLOWLIST: allowlist, NC_BROKER_JOURNAL_DIR: state,
      NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST: 'true',
    });
    const deps = realDeps(config);
    const rawBefore = await deps.list();
    const views = rawBefore.map(viewOf);
    const allowed = views.find((v) => v?.name === 'nc-allowed');
    const other = views.find((v) => v?.name === 'nc-other');
    if (!allowed || !other) throw new Error('test processes missing');
    const otherBefore = stateOf(other);
    writeFileSync(allowlist, JSON.stringify({ version: 1, targets: [{ id: 'allowed', name: 'nc-allowed', actions: ['start', 'stop', 'restart'], fingerprint: fingerprintOf(allowed) }] }), { mode: 0o644 });

    const { server } = createBroker(deps, { info: () => undefined, warn: () => undefined });
    await listenBroker(server, config.socketPath);
    try {
      const sock = config.socketPath;
      const exec = (targetKey: string, action: 'start' | 'stop' | 'restart', commandId = randomUUID()) =>
        brokerRequest(sock, { v: 1, op: 'execute', commandId, targetKey, action, deadlineAt: new Date(Date.now() + 60_000).toISOString() }, 60_000);
      const statusOf = async (name: string) => {
        const v = (await deps.list()).map(viewOf).find((x) => x?.name === name);
        return v ? stateOf(v) : null;
      };

      expect(await brokerRequest(sock, { v: 1, op: 'list' }, 10_000)).toMatchObject({ daemon: 'ok', allowlist: 'ok', targets: [{ targetKey: 'allowed', matchStatus: 'ok', pmId: allowed.pmId }] });
      expect(await exec('allowed', 'stop')).toMatchObject({ outcome: 'succeeded', before: { status: 'online' }, after: { status: 'stopped' } });
      expect((await statusOf('nc-allowed'))?.status).toBe('stopped');
      expect(await exec('allowed', 'start')).toMatchObject({ outcome: 'succeeded', after: { status: 'online' } });
      const beforeRestart = await statusOf('nc-allowed');
      const restartId = randomUUID();
      const restart = await exec('allowed', 'restart', restartId);
      expect(restart).toMatchObject({ outcome: 'succeeded', after: { status: 'online' } });
      const afterRestart = await statusOf('nc-allowed');
      expect((afterRestart?.restarts ?? 0)).toBeGreaterThan(beforeRestart?.restarts ?? 0);
      // Redelivery of the same command: stored result, no second restart.
      expect(await exec('allowed', 'restart', restartId)).toEqual(restart);
      expect((await statusOf('nc-allowed'))?.restarts).toBe(afterRestart?.restarts);
      // start of an online process is refused before PM2 is touched.
      expect(await exec('allowed', 'start')).toMatchObject({ outcome: 'rejected', reason: 'invalid_state' });
      // Not allowlisted → refused; the other process is unchanged.
      expect(await exec('other', 'stop')).toMatchObject({ outcome: 'rejected', reason: 'not_allowlisted' });
      const otherAfter = await statusOf('nc-other');
      expect(otherAfter).toEqual(otherBefore);
      expect(JSON.stringify(restart)).not.toContain(SECRET);

      pm2('kill');
      expect(existsSync(join(home, 'rpc.sock'))).toBe(false);
      expect(await exec('allowed', 'restart')).toMatchObject({ outcome: 'failed', reason: 'daemon_unavailable' });
      await new Promise((r) => setTimeout(r, 1000));
      expect(existsSync(join(home, 'rpc.sock'))).toBe(false);
      expect(existsSync(join(home, 'pm2.pid'))).toBe(false);
      expect(readdirSync(state).every((f) => f.endsWith('.json'))).toBe(true);
    } finally {
      await new Promise((r) => { server.close(r); });
    }
  }, 300_000);
});
