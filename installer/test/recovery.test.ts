import { describe, expect, it } from 'vitest';
import { agentMain } from '../src/agent.js';
import type { SecretInput } from '../src/secrets.js';
import { serverMain } from '../src/server.js';
import { capture, FakeHost, REV } from './fake-host.js';

// Review ADR-027 (2026-10-20): (1) a needed daemon-reload/restart survives a failed or interrupted run; (2) the Agent
// connection is confirmed only by its CURRENT run; (3) a service account resolving to UID 0 is refused before changes.

const noTty: SecretInput = { isTTY: false, readAll: () => Promise.resolve(''), hidden: () => Promise.reject(new Error('no tty')) };
const STATE_DIR = '/var/lib/node-control-install';
const DB_PASS = 'Synthetic-db-Secret-0123456789';
const TOKEN = `ncag_${'T'.repeat(43)}`;

function serverHost(): FakeHost {
  const h = new FakeHost();
  h.artifact('api');
  h.file('/root/db.env', `DB_NAME=node_control_db\nDB_USER=node_control_user\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASS=${DB_PASS}\n`, 0o600);
  return h;
}
const SERVER = ['--artifact', `/transfer/node-control-api-${REV}.tar.gz`, '--db-env', '/root/db.env', '--public-url', 'https://control.example.com'];
async function server(h: FakeHost, argv: string[]) {
  const c = capture();
  const code = await serverMain(argv, { host: h, out: c.out, input: noTty, cwd: '/root', releaseTool: '/transfer/server-release.js' });
  return { code, all: c.all };
}

const heartbeat = (outcome: string) => `{"level":"info","msg":"heartbeat","outcome":"${outcome}","nextInSeconds":30}`;
function agentHost(): FakeHost {
  const h = new FakeHost();
  h.artifact('agent');
  h.file('/root/agent.token', `${TOKEN}\n`, 0o600);
  h.http.set('https://control.example.com/api/auth/me', 401);
  const deploy = h.addUser('deploy', 1000);
  h.dir('/home/deploy', 0o750, deploy.uid, deploy.gid);
  h.dir('/home/deploy/.pm2', 0o775, deploy.uid, deploy.gid);
  h.files.set('/home/deploy/.pm2/rpc.sock', { kind: 'socket', mode: 0o775, uid: deploy.uid, gid: deploy.gid });
  h.agentLogs = (_inv, _n) => heartbeat('accepted');
  return h;
}
const AGENT = ['--artifact', `/transfer/node-control-agent-${REV}.tar.gz`, '--api-url', 'https://control.example.com', '--token-file', '/root/agent.token'];
const PM2 = ['--pm2-owner', 'deploy', '--pm2-home', '/home/deploy/.pm2'];
async function agent(h: FakeHost, argv: string[]) {
  const c = capture();
  const code = await agentMain(argv, { host: h, out: c.out, input: noTty, cwd: '/root', releaseTool: '/transfer/server-release.js' });
  return { code, all: c.all };
}
const restarts = (h: FakeHost, unit: string) => h.changes.filter((c) => c === `systemctl restart ${unit}` || c === `systemctl start ${unit}`).length;

describe('P2: a needed restart/reload is not lost after a failed or interrupted run', () => {
  it('API: config written, then a failure before the restart → the next apply restarts the API (and only once)', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    h.changes = [];
    h.fail('migrate.js status', '[migrate] status failed (category=database code=ECONNREFUSED)', true);
    const failed = await server(h, ['apply', ...SERVER, '--behind-nginx']);
    expect(failed.code).toBe(1);
    expect(h.text('/etc/node-control/api.env')).toMatch(/^API_TRUSTED_PROXIES=127\.0\.0\.1$/m);
    expect(h.changes).not.toContain('systemctl restart node-control-api.service');
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    expect(h.changes).toEqual(['systemctl restart node-control-api.service']);
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    expect(h.changes).toEqual([]); // completed and unchanged: no extra restart
  });

  it('the intent is recorded BEFORE the change: a failed config write still leads to exactly one restart later', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    h.changes = [];
    h.failWrite('/etc/node-control/api.env');
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(1);
    expect(h.text(`${STATE_DIR}/server.json`)).toMatch(/restart-api/);
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    expect(h.changes.filter((c) => c.includes('restart'))).toEqual(['systemctl restart node-control-api.service']);
  });

  it('order on disk: intent (state with restart-api) → api.env change → restart → state cleared', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    h.changes = [];
    h.stateOps = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    const config = h.changes.indexOf('write /etc/node-control/api.env');
    const restart = h.changes.indexOf('systemctl restart node-control-api.service');
    const intent = h.stateOps.find((o) => o.content.includes('restart-api'));
    const cleared = h.stateOps.at(-1);
    expect(intent?.at).toBeLessThanOrEqual(config - 1); // written before the backup + config writes
    expect(cleared?.content).toBe('{"version":1,"pending":[]}\n');
    expect(cleared?.at).toBeGreaterThan(restart);
  });

  it('the intent cannot be recorded (state write fails) → the resource is not changed at all', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    const env = h.text('/etc/node-control/api.env');
    h.changes = [];
    h.failWrite(`${STATE_DIR}/server.json`);
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(1);
    expect(h.text('/etc/node-control/api.env')).toBe(env);
    expect(h.changes).toEqual([]);
  });

  it('a failed restart stays pending until it succeeds', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    h.fail('systemctl restart node-control-api.service', 'Job failed', true);
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(1);
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    expect(h.changes).toEqual(['systemctl restart node-control-api.service']);
  });

  it('restart done but the state could not be cleared (crash at that point): one more restart, then none', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    let writes = 0;
    h.writeFailures.push({ match: (p) => p.startsWith(`${STATE_DIR}/server.json`) && ++writes === 2, once: true }); // 1st: intent, 2nd: clear
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(1);
    expect(restarts(h, 'node-control-api.service')).toBeGreaterThanOrEqual(1);
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    expect(h.changes).toEqual(['systemctl restart node-control-api.service']);
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(0);
    expect(h.changes).toEqual([]);
  });

  it('unit written but daemon-reload failed → the next apply reloads before activation and start', async () => {
    const h = serverHost();
    h.fail('systemctl daemon-reload', 'Failed to reload', true);
    expect((await server(h, ['apply', ...SERVER])).code).toBe(1);
    expect(h.stat('/etc/systemd/system/node-control-api.service')).not.toBeNull();
    h.changes = [];
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    const order = h.changes;
    expect(order[0]).toBe('systemctl daemon-reload');
    expect(order.indexOf('systemctl daemon-reload')).toBeLessThan(order.indexOf(`activate ${REV}`));
    expect(order.indexOf(`activate ${REV}`)).toBeLessThan(order.indexOf('systemctl start node-control-api.service'));
  });

  it('plan shows the unfinished action and changes nothing (state included)', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    h.fail('migrate.js status', 'x', true);
    expect((await server(h, ['apply', ...SERVER, '--behind-nginx'])).code).toBe(1);
    const state = h.text(`${STATE_DIR}/server.json`);
    h.changes = [];
    const plan = await server(h, ['plan', ...SERVER, '--behind-nginx']);
    expect(plan.code).toBe(0);
    expect(plan.all).toMatch(/незавершен.*restart-api|restart-api.*незавершен/s);
    expect(plan.all).toMatch(/служба node-control-api\.service: буде виконано — restart/);
    expect(h.changes).toEqual([]);
    expect(h.text(`${STATE_DIR}/server.json`)).toBe(state);
    // A plan on a fresh host creates no state at all.
    const fresh = serverHost();
    await server(fresh, ['plan', ...SERVER]);
    expect(fresh.stat(STATE_DIR)).toBeNull();
  });

  it('state: root-only, no secrets; a foreign or damaged state stops before any change', async () => {
    const h = serverHost();
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    expect(h.stat(STATE_DIR)).toMatchObject({ kind: 'dir', mode: 0o700, uid: 0 });
    expect(h.stat(`${STATE_DIR}/server.json`)).toMatchObject({ kind: 'file', mode: 0o600, uid: 0 });
    const text = h.text(`${STATE_DIR}/server.json`);
    expect(text).not.toContain(DB_PASS);
    expect(text).not.toMatch(/ALERTS_SECRET_KEY|DB_PASS|ncag_/);
    for (const [arrange, message] of [
      [(x: FakeHost) => { x.file(`${STATE_DIR}/server.json`, '{not json', 0o600); }, /пошкоджен/],
      [(x: FakeHost) => { x.files.set(`${STATE_DIR}/server.json`, { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target: '/etc/shadow' }); }, /не є звичайним файлом/],
      [(x: FakeHost) => { x.file(`${STATE_DIR}/server.json`, '{"version":1,"pending":[]}', 0o644, 1000, 1000); }, /root/],
      [(x: FakeHost) => { x.files.set(STATE_DIR, { kind: 'dir', mode: 0o777, uid: 1000, gid: 1000 }); }, /root/],
    ] as const) {
      const x = serverHost();
      x.dir(STATE_DIR, 0o700);
      arrange(x);
      const r = await server(x, ['apply', ...SERVER]);
      expect(r.code).toBe(1);
      expect(r.all).toMatch(message);
      expect(x.changes).toEqual([]);
    }
  });

  it('Agent: capabilities and groups added, failure before the Agent restart → the next apply restarts the Agent', async () => {
    const h = agentHost();
    expect((await agent(h, ['apply', ...AGENT])).code).toBe(0);
    h.changes = [];
    h.fail('systemctl start node-control-pm2-exporter@deploy.service', 'exit 2', true);
    expect((await agent(h, ['apply', ...AGENT, ...PM2])).code).toBe(1);
    expect(h.groupsOf('nodecontrol-agent')).toContain('nc-pm2-inventory');
    expect(h.changes).not.toContain('systemctl restart node-control-agent.service');
    h.changes = [];
    expect((await agent(h, ['apply', ...AGENT, ...PM2])).code).toBe(0);
    expect(h.changes).toContain('systemctl restart node-control-agent.service');
    h.changes = [];
    expect((await agent(h, ['apply', ...AGENT, ...PM2])).code).toBe(0);
    expect(h.changes).toEqual([]);
  });
});

describe('P2: only the CURRENT Agent run confirms the connection', () => {
  it('a historical accepted without a current heartbeat is not a confirmation (bounded wait, exit 1)', async () => {
    const h = agentHost();
    h.historical(heartbeat('accepted'));
    h.agentLogs = null;
    const r = await agent(h, ['apply', ...AGENT]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/зв'язок Agent НЕ підтверджено/);
    expect(r.all).not.toMatch(/зв'язок Agent підтверджено/);
  });

  it('historical accepted + current unauthorized → failure; historical unauthorized + current accepted → success', async () => {
    const bad = agentHost();
    bad.historical(heartbeat('accepted'));
    bad.agentLogs = () => heartbeat('unauthorized');
    const r1 = await agent(bad, ['apply', ...AGENT]);
    expect(r1.code).toBe(1);
    expect(r1.all).toMatch(/API відхилив ключ/);
    const good = agentHost();
    good.historical(heartbeat('unauthorized'));
    const r2 = await agent(good, ['apply', ...AGENT]);
    expect(r2.code).toBe(0);
    expect(r2.all).toMatch(/зв'язок Agent підтверджено/);
  });

  it('waits for the first heartbeat of the new run', async () => {
    const h = agentHost();
    h.agentLogs = (_inv, n) => (n < 3 ? null : heartbeat('accepted'));
    const r = await agent(h, ['apply', ...AGENT]);
    expect(r.code).toBe(0);
  });

  it('a repeated apply on an unchanged running Agent: no restart; its current run already confirmed the connection', async () => {
    const h = agentHost();
    expect((await agent(h, ['apply', ...AGENT])).code).toBe(0);
    h.agentLogs = null; // nothing new is logged (the Agent logs only changes)
    h.changes = [];
    const r = await agent(h, ['apply', ...AGENT]);
    expect(r.code).toBe(0);
    expect(h.changes).toEqual([]);
    expect(r.all).toMatch(/зв'язок Agent підтверджено/);
  });

  it('the run changes during the check (crash + systemd restart): only the new run counts', async () => {
    const h = agentHost();
    h.agentLogs = (inv, n) => {
      if (n === 0) { h.invocations.set('node-control-agent.service', 'run-crashed-and-restarted'); return heartbeat('accepted'); } // logged by the OLD run
      return inv === 'run-crashed-and-restarted' && n >= 2 ? heartbeat('unauthorized') : null;
    };
    const r = await agent(h, ['apply', ...AGENT]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/API відхилив ключ/);
  });

  it('journal not readable → not confirmed; no raw journal, env or key in the output', async () => {
    const h = agentHost();
    h.journalFails = true;
    const r = await agent(h, ['apply', ...AGENT]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/журнал/);
    expect(r.all).not.toContain(TOKEN);
    expect(r.all).not.toContain('"msg"');
  });
});

describe('P2: a service account that resolves to UID 0 is refused before any change', () => {
  it.each([
    ['nodecontrol uid 0', (h: FakeHost) => { h.addUser('nodecontrol', 0, { shell: '/usr/sbin/nologin', primary: 'nodecontrol' }); }],
    ['nodecontrol in the root group (gid 0)', (h: FakeHost) => { h.addUser('nodecontrol', 991, { shell: '/usr/sbin/nologin', primary: 'root' }); }],
    ['a regular login user named nodecontrol', (h: FakeHost) => { h.addUser('nodecontrol', 1001); }],
  ])('server: %s', async (_n, arrange) => {
    const h = serverHost();
    arrange(h);
    const r = await server(h, ['apply', ...SERVER]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/nodecontrol/);
    expect(h.changes).toEqual([]);
    expect(h.stat(STATE_DIR)).toBeNull();
  });

  it('agent: nodecontrol-agent uid 0, and a PM2 owner name that resolves to UID 0', async () => {
    const a = agentHost();
    a.addUser('nodecontrol-agent', 0, { shell: '/usr/sbin/nologin', primary: 'nodecontrol-agent' });
    const r1 = await agent(a, ['apply', ...AGENT]);
    expect(r1.code).toBe(1);
    expect(r1.all).toMatch(/UID 0/);
    expect(a.changes).toEqual([]);
    const b = agentHost();
    b.addUser('toor', 0, { shell: '/bin/bash', primary: 'root' });
    b.dir('/home/toor/.pm2', 0o775, 0, 0);
    const r2 = await agent(b, ['apply', ...AGENT, '--pm2-owner', 'toor', '--pm2-home', '/home/toor/.pm2']);
    expect(r2.code).toBe(1);
    expect(r2.all).toMatch(/root не підтримується/);
    expect(b.changes).toEqual([]);
  });

  it('a non-root system account left by an earlier attempt is accepted', async () => {
    const h = serverHost();
    h.addUser('nodecontrol', 993, { shell: '/usr/sbin/nologin' });
    expect((await server(h, ['apply', ...SERVER])).code).toBe(0);
    expect(h.changes).not.toContain('useradd nodecontrol');
  });
});
