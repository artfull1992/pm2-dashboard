import { describe, expect, it } from 'vitest';
import { AGENT, agentMain } from '../src/agent.js';
import type { SecretInput } from '../src/secrets.js';
import { capture, FakeHost, REV } from './fake-host.js';

// Agent installer against an in-memory host: heartbeat-only by default; inventory and control only when asked;
// PM2 is never invoked; existing configuration and allowlists are never rewritten; the key is never printed.

const TOKEN = `ncag_${'T'.repeat(43)}`;
const heartbeat = (outcome: string) => `{"level":"info","time":"2026-10-20T10:00:00.000Z","msg":"heartbeat","outcome":"${outcome}","nextInSeconds":30}`;
const INVENTORY_OK = '{"level":"info","msg":"inventory","outcome":"accepted","state":"ok"}';
/** The Agent's log per run: the given lines, one per journal read, starting with the run's first read. */
function logs(...lines: string[]) {
  const seen = new Map<string, number>();
  return (invocation: string) => {
    const n = seen.get(invocation) ?? 0;
    seen.set(invocation, n + 1);
    return lines[n] ?? null;
  };
}
const input = (over: Partial<SecretInput> = {}): SecretInput => ({ isTTY: false, readAll: () => Promise.resolve(''), hidden: () => Promise.reject(new Error('no tty')), ...over });

function host(): FakeHost {
  const h = new FakeHost();
  h.artifact('agent');
  h.file('/root/agent.token', `${TOKEN}\n`, 0o600);
  h.http.set('https://control.example.com/api/auth/me', 401);
  h.agentLogs = logs(`${heartbeat('accepted')}\n${INVENTORY_OK}`);
  const deploy = h.addUser('deploy', 1000);
  h.dir('/home/deploy', 0o750, deploy.uid, deploy.gid);
  h.dir('/home/deploy/.pm2', 0o775, deploy.uid, deploy.gid);
  h.files.set('/home/deploy/.pm2/rpc.sock', { kind: 'socket', mode: 0o775, uid: deploy.uid, gid: deploy.gid });
  return h;
}
const BASE = ['--artifact', `/transfer/node-control-agent-${REV}.tar.gz`, '--api-url', 'https://control.example.com', '--token-file', '/root/agent.token'];
const PM2 = ['--pm2-owner', 'deploy', '--pm2-home', '/home/deploy/.pm2'];

async function run(h: FakeHost, argv: string[], i: SecretInput = input()) {
  const c = capture();
  const code = await agentMain(argv, { host: h, out: c.out, input: i, cwd: '/root', releaseTool: '/transfer/server-release.js' });
  return { code, ...c, all: c.all };
}
/** No PM2 executable is ever run (unit names may contain "pm2"; commands may not). */
const pm2Commands = (h: FakeHost) => h.calls.filter((c) => /(^|\/)pm2$/.test(c.command) || c.args.some((a) => /(^|\/)pm2$/.test(a)));

describe('agent installer: heartbeat only (default)', () => {
  it('plan changes nothing; apply creates user → dirs → release → config → unit → service, and confirms the heartbeat', async () => {
    const h = host();
    const plan = await run(h, ['plan', ...BASE]);
    expect(plan.code).toBe(0);
    expect(h.changes).toEqual([]);
    expect(plan.all).toMatch(/PM2 inventory не вмикається/);
    const r = await run(h, ['apply', ...BASE]);
    expect(r.code).toBe(0);
    expect(h.changes).toEqual([
      'useradd nodecontrol-agent',
      'mkdir /opt/node-control-agent',
      `prepare /opt/node-control-agent/releases/${REV}`,
      `activate ${REV}`,
      'mkdir /etc/node-control-agent',
      'write /etc/node-control-agent/agent.env',
      'write /etc/systemd/system/node-control-agent.service',
      'systemctl daemon-reload',
      'systemctl enable node-control-agent.service',
      'systemctl start node-control-agent.service',
    ]);
    const user = h.user(AGENT.user);
    expect(h.stat(AGENT.configDir)).toMatchObject({ mode: 0o750, uid: 0, gid: user?.gid });
    expect(h.stat(AGENT.config)).toMatchObject({ mode: 0o600, uid: user?.uid });
    expect(h.text(AGENT.config)).toMatch(/^NC_AGENT_API_URL=https:\/\/control\.example\.com$/m);
    expect(h.text(AGENT.config)).toContain(`NC_AGENT_TOKEN=${TOKEN}`);
    expect(h.text(AGENT.config)).not.toMatch(/INVENTORY|CONTROL_SOCKET/);
    expect(r.all).toMatch(/зв'язок Agent підтверджено/);
    expect(pm2Commands(h)).toEqual([]);
  });

  it('the key is never printed nor put in argv — file, stdin and the hidden prompt', async () => {
    for (const [argv, i] of [
      [BASE, input()],
      [[...BASE.slice(0, 4), '--token-stdin'], input({ readAll: () => Promise.resolve(`${TOKEN}\n`) })],
      [BASE.slice(0, 4), input({ isTTY: true, hidden: () => Promise.resolve(TOKEN) })],
    ] as const) {
      const h = host();
      const r = await run(h, [...['apply'], ...argv], i);
      expect(r.code).toBe(0);
      expect(r.all).not.toContain(TOKEN);
      expect(h.calls.flatMap((c) => [...c.args, c.input ?? '']).join(' ')).not.toContain(TOKEN);
      expect(h.text(AGENT.config)).toContain(TOKEN);
    }
  });

  it('a wrong key format or an unprotected key file stops before any change (value not echoed)', async () => {
    const h = host();
    h.file('/root/agent.token', 'ncag_short-secret-value\n', 0o600);
    const bad = await run(h, ['apply', ...BASE]);
    expect(bad.code).toBe(1);
    expect(bad.all).toMatch(/неправильний формат/);
    expect(bad.all).not.toContain('short-secret-value');
    const open = host();
    open.file('/root/agent.token', `${TOKEN}\n`, 0o644);
    expect((await run(open, ['apply', ...BASE])).all).toMatch(/chmod 600/);
    expect([...h.changes, ...open.changes]).toEqual([]);
  });

  it('no terminal and no key source → stop (never an empty token)', async () => {
    const h = host();
    const r = await run(h, ['apply', ...BASE.slice(0, 4)]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/--token-file .* або --token-stdin/);
    expect(h.changes).toEqual([]);
  });

  it('API unreachable or TLS not trusted → stop before any change', async () => {
    const h = host();
    h.http.set('https://control.example.com/api/auth/me', null);
    const r = await run(h, ['apply', ...BASE]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/недоступний: DNS, мережа, вихідний HTTPS або недовірений TLS-сертифікат/);
    expect(h.changes).toEqual([]);
  });

  it.each([
    ['unauthorized', /API відхилив ключ/],
    ['network', /немає з'єднання з API/],
  ])('heartbeat %s → installed but connection NOT confirmed, exit 1 with advice', async (outcome, advice) => {
    const h = host();
    h.agentLogs = logs(heartbeat(outcome));
    const r = await run(h, ['apply', ...BASE]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/✓ служба node-control-agent\.service запущена/);
    expect(r.all).toMatch(advice);
    expect(r.all).not.toMatch(/Готово/);
  });

  it('a repeated apply keeps agent.env (no rotation, even with a new key) and changes nothing', async () => {
    const h = host();
    expect((await run(h, ['apply', ...BASE])).code).toBe(0);
    const env = h.text(AGENT.config);
    h.changes = [];
    h.file('/root/agent.token', `ncag_${'N'.repeat(43)}\n`, 0o600);
    const again = await run(h, ['apply', ...BASE]);
    expect(again.code).toBe(0);
    expect(again.all).toMatch(/ключ проігноровано/);
    expect(h.text(AGENT.config)).toBe(env);
    expect(h.changes).toEqual([]);
  });
});

describe('agent installer: PM2 inventory and control (explicit)', () => {
  it('inventory: group, membership, snapshot dir, exporter config/units, one run + timer; Agent gets the key and restarts', async () => {
    const h = host();
    const r = await run(h, ['apply', ...BASE, ...PM2]);
    expect(r.code).toBe(0);
    const deploy = h.user('deploy');
    const inv = h.group(AGENT.inventoryGroup);
    expect(h.stat(AGENT.snapshotDir)).toMatchObject({ mode: 0o2750, uid: deploy?.uid, gid: inv?.gid });
    expect(h.text('/etc/node-control-pm2-exporter/deploy.env')).toBe('NC_PM2_HOME=/home/deploy/.pm2\nNC_PM2_SNAPSHOT_FILE=/var/lib/node-control-pm2/inventory.json\nNC_PM2_SOURCE=pm2\n');
    expect(h.groupsOf(AGENT.user)).toContain(AGENT.inventoryGroup);
    expect(h.text(AGENT.config)).toMatch(/^NC_AGENT_INVENTORY_FILE=\/var\/lib\/node-control-pm2\/inventory\.json$/m);
    const order = h.changes;
    expect(order.indexOf('systemctl start node-control-pm2-exporter@deploy.service')).toBeLessThan(order.indexOf('systemctl start node-control-agent.service'));
    expect(order.indexOf('usermod -aG nc-pm2-inventory nodecontrol-agent')).toBeLessThan(order.indexOf('systemctl start node-control-agent.service'));
    expect(order).toContain('systemctl enable --now node-control-pm2-exporter@deploy.timer');
    expect(r.all).toMatch(/inventory: accepted, стан ok/);
    expect(pm2Commands(h)).toEqual([]);
    // The PM2 owner's files are never written.
    expect(order.some((c) => c.includes('/home/deploy'))).toBe(false);
  });

  it('control: broker config, EMPTY root-owned allowlist, broker service, Agent socket + group; nothing allowed yet', async () => {
    const h = host();
    const r = await run(h, ['apply', ...BASE, ...PM2, '--enable-control']);
    expect(r.code).toBe(0);
    expect(h.text('/etc/node-control-pm2-broker/deploy.allowlist.json')).toBe('{"version":1,"targets":[]}\n');
    expect(h.stat('/etc/node-control-pm2-broker/deploy.allowlist.json')).toMatchObject({ mode: 0o644, uid: 0, gid: 0 });
    expect(h.units.get('node-control-pm2-broker@deploy.service')).toEqual({ enabled: true, active: true });
    expect(h.groupsOf(AGENT.user)).toContain(AGENT.controlGroup);
    expect(h.text(AGENT.config)).toMatch(/^NC_AGENT_CONTROL_SOCKET=\/run\/node-control-pm2-broker\/broker\.sock$/m);
    expect(r.all).toMatch(/Керування й логи ще ВИМКНЕНІ: allowlist порожній/);
    expect(pm2Commands(h)).toEqual([]);
  });

  it('an existing allowlist with targets is never touched; inventory added to an existing install only appends keys', async () => {
    const h = host();
    expect((await run(h, ['apply', ...BASE])).code).toBe(0);
    const env = h.text(AGENT.config);
    h.dir('/etc/node-control-pm2-broker');
    const allowlist = '{"version":1,"targets":[{"id":"api-prod","name":"api","actions":["restart"],"fingerprint":"sha256:x"}]}\n';
    h.file('/etc/node-control-pm2-broker/deploy.allowlist.json', allowlist);
    h.changes = [];
    expect((await run(h, ['apply', ...BASE, ...PM2, '--enable-control'])).code).toBe(0);
    expect(h.text('/etc/node-control-pm2-broker/deploy.allowlist.json')).toBe(allowlist);
    expect(h.text(AGENT.config).startsWith(env)).toBe(true);
    expect(h.changes).toContain('systemctl restart node-control-agent.service');
    expect(h.changes.filter((c) => c.startsWith('write /etc/node-control-agent/agent.env.bak-'))).toHaveLength(1);
  });

  it('a different exporter config is a conflict (kept), not overwritten', async () => {
    const h = host();
    h.dir('/etc/node-control-pm2-exporter');
    h.file('/etc/node-control-pm2-exporter/deploy.env', 'NC_PM2_HOME=/srv/pm2\n');
    const r = await run(h, ['apply', ...BASE, ...PM2]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/уже існує з іншим вмістом/);
    expect(h.text('/etc/node-control-pm2-exporter/deploy.env')).toBe('NC_PM2_HOME=/srv/pm2\n');
  });

  it('failed exporter run: stop (PM2 untouched); the next apply continues', async () => {
    const h = host();
    h.fail('systemctl start node-control-pm2-exporter@deploy.service', 'exit 2', true);
    const first = await run(h, ['apply', ...BASE, ...PM2]);
    expect(first.code).toBe(1);
    expect(first.all).toMatch(/PM2 не змінювався/);
    h.changes = [];
    expect((await run(h, ['apply', ...BASE, ...PM2])).code).toBe(0);
    expect(h.changes[0]).toBe('systemctl start node-control-pm2-exporter@deploy.service');
  });

  it.each([
    ['owner missing', (h: FakeHost) => { h.users.delete('deploy'); }, /користувача deploy немає/],
    ['PM2_HOME missing', (h: FakeHost) => { h.files.delete('/home/deploy/.pm2'); }, /PM2_HOME .* не існує/],
    ['Agent in the owner primary group', (h: FakeHost) => { h.addUser('nodecontrol-agent', 995, { shell: '/usr/sbin/nologin', primary: 'deploy' }); }, /основної групи deploy/],
  ])('%s → stop before any change', async (_n, arrange, message) => {
    const h = host();
    arrange(h);
    const r = await run(h, ['apply', ...BASE, ...PM2]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(message);
    expect(h.changes).toEqual([]);
  });

  it('PM2 daemon not running: a warning, still no PM2 command', async () => {
    const h = host();
    h.files.delete('/home/deploy/.pm2/rpc.sock');
    const r = await run(h, ['plan', ...BASE, ...PM2]);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/зараз не працює .* PM2 не запускається/);
    expect(pm2Commands(h)).toEqual([]);
  });
});

describe('agent installer: arguments', () => {
  it.each([
    [[...BASE, '--pm2-owner', 'root', '--pm2-home', '/root/.pm2']],
    [[...BASE, '--pm2-owner', 'deploy']],
    [[...BASE, '--enable-control']],
    [[...BASE, ...PM2.slice(0, 2), '--pm2-home', '/home/deploy/../root/.pm2']],
    [[...BASE, ...PM2.slice(0, 2), '--pm2-home', '/home/deploy/.pm2\nNC_EVIL=1']],
    [[...BASE.slice(0, 2), '--api-url', 'https://203.0.113.10']],
    [[...BASE, '--token-stdin']],
  ])('%j → exit 2', async (argv) => {
    const h = host();
    expect((await run(h, ['apply', ...argv])).code).toBe(2);
    expect(h.changes).toEqual([]);
  });
});
