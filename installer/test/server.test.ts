import { describe, expect, it } from 'vitest';
import type { SecretInput } from '../src/secrets.js';
import { API, serverMain } from '../src/server.js';
import { capture, FakeHost, REV, UNIT_TEXT } from './fake-host.js';

// Central API installer against an in-memory host (FakeHost): order of changes, owners/modes, preflight before any
// change, plan without changes, conflicts, resumable apply after a failure, secrets never printed or put in argv.

const DB_PASS = 'Synthetic-db-Secret-0123456789';
const ADMIN_PASSWORD = 'Synthetic admin pass phrase 42';
const noTty: SecretInput = { isTTY: false, readAll: () => Promise.resolve(''), hidden: () => Promise.reject(new Error('no tty')) };

function host(): FakeHost {
  const h = new FakeHost();
  h.artifact('api');
  h.file('/root/db.env', `DB_NAME=node_control_db\nDB_USER=node_control_user\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASS=${DB_PASS}\n`, 0o600);
  return h;
}
const ARGS = ['--artifact', `/transfer/node-control-api-${REV}.tar.gz`, '--db-env', '/root/db.env', '--public-url', 'https://control.example.com'];

async function run(h: FakeHost, argv: string[], input: SecretInput = noTty) {
  const c = capture();
  const code = await serverMain(argv, { host: h, out: c.out, input, cwd: '/root', releaseTool: '/transfer/server-release.js' });
  return { code, ...c, all: c.all };
}
const mutatingCalls = (h: FakeHost) => h.calls.filter((c) => !['is-active', 'is-enabled', '--version', 'status'].includes(c.args.at(c.command === 'runuser' ? -1 : 0) ?? '') && !['ss', 'id', 'journalctl'].includes(c.command));

describe('server installer: first installation', () => {
  it('plan inspects only: no change, no mutating command; lists what apply would do', async () => {
    const h = host();
    const r = await run(h, ['plan', ...ARGS]);
    expect(r.code).toBe(0);
    expect(h.changes).toEqual([]);
    expect(mutatingCalls(h)).toEqual([]);
    expect(r.all).toMatch(/буде виконано — useradd --system/);
    expect(r.all).toMatch(/Нічого не змінено/);
  });

  it('apply: user → release → config → keys → migrations → unit → activate → service; then health is verified', async () => {
    const h = host();
    const r = await run(h, ['apply', ...ARGS]);
    expect(r.code).toBe(0);
    expect(h.changes).toEqual([
      'useradd nodecontrol',
      'mkdir /opt/node-control-runtime',
      'mkdir /opt/node-control-runtime/bin',
      'symlink /opt/node-control-runtime/bin/node -> /usr/bin/node',
      `prepare /opt/node-control/releases/${REV}`,
      'config /etc/node-control/api.env',
      'write /etc/node-control/api.env.bak-20261020T100000Z',
      'write /etc/node-control/api.env',
      'migrate up',
      'write /etc/systemd/system/node-control-api.service',
      'systemctl daemon-reload',
      `activate ${REV}`,
      'systemctl enable node-control-api.service',
      'systemctl start node-control-api.service',
    ]);
    const user = h.user('nodecontrol');
    expect(user).toMatchObject({ shell: '/usr/sbin/nologin' });
    expect(h.stat(API.config)).toMatchObject({ mode: 0o600, uid: user?.uid });
    expect(h.stat(`${API.config}.bak-20261020T100000Z`)).toMatchObject({ mode: 0o600, uid: user?.uid });
    expect(h.stat('/etc/systemd/system/node-control-api.service')).toMatchObject({ mode: 0o644, uid: 0 });
    const env = h.text(API.config);
    expect(env).toMatch(/^AUTH_COOKIE_SECURE=true$/m);
    expect(env).toMatch(/^AUTH_ALLOWED_ORIGINS=https:\/\/control\.example\.com$/m);
    expect(env).toMatch(/^ALERTS_PUBLIC_URL=https:\/\/control\.example\.com$/m);
    expect(env).toMatch(/^ALERTS_SECRET_KEY=[A-Za-z0-9+/]{43}=$/m);
    expect(env).not.toMatch(/API_TRUSTED_PROXIES|PM2_CONTROL_ENABLED/);
    expect(r.all).toMatch(/служба node-control-api\.service запущена/);
    expect(r.all).toMatch(/\/health\/ready — 200 .*health пройдено/);
  });

  it('a repeated apply changes nothing: no new user, release, key, migration or restart', async () => {
    const h = host();
    expect((await run(h, ['apply', ...ARGS])).code).toBe(0);
    const env = h.text(API.config);
    h.changes = [];
    const again = await run(h, ['apply', ...ARGS]);
    expect(again.code).toBe(0);
    expect(h.changes).toEqual([]);
    expect(h.text(API.config)).toBe(env);
    expect(again.all).toMatch(/нічого не змінено/);
    expect(again.all).toMatch(/--db-env проігноровано/);
  });

  it('secrets are never printed nor passed in argv (DB password, generated key, admin password)', async () => {
    const h = host();
    h.file('/root/admin.pass', `${ADMIN_PASSWORD}\n`, 0o600);
    const r = await run(h, ['apply', ...ARGS, '--admin-email', 'admin@example.com', '--admin-password-file', '/root/admin.pass']);
    expect(r.code).toBe(0);
    const key = /^ALERTS_SECRET_KEY=(.+)$/m.exec(h.text(API.config))?.[1] ?? '';
    expect(key).not.toBe('');
    for (const secret of [DB_PASS, key, ADMIN_PASSWORD]) {
      expect(r.all).not.toContain(secret);
      expect(h.calls.flatMap((c) => c.args).join(' ')).not.toContain(secret);
    }
    // The admin password reaches bootstrap-admin.js only through stdin.
    const bootstrap = h.calls.find((c) => c.args.some((a) => a.endsWith('bootstrap-admin.js')));
    expect(bootstrap?.args).toContain('--password-stdin');
    expect(bootstrap?.input).toBe(`${ADMIN_PASSWORD}\n`);
    expect(h.admins).toBe(1);
  });

  it('bootstrap again with --admin-email: the existing administrator is kept (exit 3 of the CLI is not a failure)', async () => {
    const h = host();
    h.file('/root/admin.pass', 'x-pass-1234567890\n', 0o600);
    const args = ['apply', ...ARGS, '--admin-email', 'admin@example.com', '--admin-password-file', '/root/admin.pass'];
    expect((await run(h, args)).code).toBe(0);
    const again = await run(h, args);
    expect(again.code).toBe(0);
    expect(again.all).toMatch(/адміністратор уже існує/);
    expect(h.admins).toBe(1);
    // Ubuntu run 2026-10-20: the refused bootstrap is not reported as a change.
    expect(again.all).toMatch(/перший адміністратор \(admin@example\.com\): нічого не змінено/);
    expect(again.all).toMatch(/Усі кроки вже були виконані раніше — нічого не змінено/);
    expect(again.all).not.toMatch(/Змінено: \d/);
  });

  it('next steps: only what is still open, numbered without gaps', async () => {
    const h = host();
    h.file('/root/admin.pass', 'x-pass-1234567890\n', 0o600);
    const first = await run(h, ['apply', ...ARGS]);
    expect(first.all).toMatch(/ {2}1\. Nginx \+ TLS[\s\S]* {2}2\. Перший адміністратор[\s\S]* {2}3\. Сервери/);
    const done = await run(h, ['apply', ...ARGS, '--behind-nginx', '--admin-email', 'admin@example.com', '--admin-password-file', '/root/admin.pass']);
    expect(done.all).toMatch(/ {2}1\. Сервери/);
    expect(done.all).not.toMatch(/повторити apply з --behind-nginx|Перший адміністратор:| 2\. /);
  });

  it('--behind-nginx later: only API_TRUSTED_PROXIES is added (existing lines byte for byte), with a backup, and the API restarts', async () => {
    const h = host();
    expect((await run(h, ['apply', ...ARGS])).code).toBe(0);
    const before = h.text(API.config);
    h.clock = new Date('2026-10-20T11:00:00.000Z');
    h.changes = [];
    expect((await run(h, ['apply', ...ARGS, '--behind-nginx'])).code).toBe(0);
    expect(h.text(API.config)).toBe(`${before}API_TRUSTED_PROXIES=127.0.0.1\n`);
    expect(h.text(`${API.config}.bak-20261020T110000Z`)).toBe(before);
    expect(h.changes).toEqual(['write /etc/node-control/api.env.bak-20261020T110000Z', 'write /etc/node-control/api.env', 'systemctl restart node-control-api.service']);
  });

  it('an existing api.env with other values is kept: no overwrite, a warning instead', async () => {
    const h = host();
    expect((await run(h, ['apply', ...ARGS])).code).toBe(0);
    const env = h.text(API.config);
    const r = await run(h, ['apply', ...ARGS.slice(0, 4), '--public-url', 'https://other.example.org']);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/AUTH_ALLOWED_ORIGINS в api\.env відрізняється.*НЕ змінюється/);
    expect(h.text(API.config)).toBe(env);
  });
});

describe('server installer: preflight stops before any change', () => {
  it.each([
    ['damaged artifact (checksum mismatch)', (h: FakeHost) => { h.file(`/transfer/node-control-api-${REV}.tar.gz`, 'tampered'); }, /SHA-256 артефакту не збігається/],
    ['not root', (h: FakeHost) => { h.euidValue = 1000; }, /потрібен root/],
    ['not Ubuntu', (h: FakeHost) => { h.file('/etc/os-release', 'ID=fedora\n'); }, /лише Ubuntu/],
    ['db credentials readable by others', (h: FakeHost) => { h.file('/root/db.env', 'DB_PASS=x\n', 0o644); }, /chmod 600/],
    ['db credentials with unsafe characters', (h: FakeHost) => { h.file('/root/db.env', 'DB_NAME=a\nDB_USER=b\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASS="x;y z"\n', 0o600); }, /DB_PASS містять недопустимі символи/],
    ['PostgreSQL not reachable', (h: FakeHost) => { h.tcp = false; }, /PostgreSQL недоступний/],
    ['foreign content in /opt/node-control', (h: FakeHost) => { h.dir('/opt/node-control'); h.file('/opt/node-control/app.js', 'x'); }, /сторонні файли/],
    ['another revision already active', (h: FakeHost) => { h.dir('/opt/node-control'); h.files.set('/opt/node-control/current', { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target: `releases/${'b'.repeat(40)}` }); }, /уже активний інший реліз/],
  ])('%s', async (_n, arrange, message) => {
    const h = host();
    arrange(h);
    const r = await run(h, ['apply', ...ARGS]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(message);
    expect(r.all).toMatch(/Зупинено до будь-яких змін/);
    expect(h.changes).toEqual([]);
  });

  it('missing --db-env / --public-url on a first installation', async () => {
    const h = host();
    const r = await run(h, ['apply', '--artifact', `/transfer/node-control-api-${REV}.tar.gz`]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/потрібен --db-env/);
    expect(r.all).toMatch(/потрібен --public-url/);
    expect(h.changes).toEqual([]);
  });
});

describe('server installer: conflicts are never overwritten', () => {
  it('a foreign user "nodecontrol" (login shell, regular uid): stop at the first step', async () => {
    const h = host();
    h.addUser('nodecontrol', 1001);
    const r = await run(h, ['apply', ...ARGS]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/конфлікт — nodecontrol існує, але це не системний/);
    expect(h.changes).toEqual([]);
  });

  it('a different unit file already installed: stop BEFORE any change (compared with the unit inside the artifact)', async () => {
    // Ubuntu run 2026-10-20: the conflict was found only at the unit step, after user, release, config and migrations.
    const h = host();
    h.file('/etc/systemd/system/node-control-api.service', '[Service]\nExecStart=/custom\n');
    const r = await run(h, ['apply', ...ARGS]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/node-control-api\.service відрізняється від unit в артефакті/);
    expect(r.all).toMatch(/Зупинено до будь-яких змін/);
    expect(h.text('/etc/systemd/system/node-control-api.service')).toBe('[Service]\nExecStart=/custom\n');
    expect(h.changes).toEqual([]);
    // The same unit as in the artifact (an earlier, interrupted attempt) is fine.
    const same = host();
    same.file('/etc/systemd/system/node-control-api.service', UNIT_TEXT('node-control-api.service'));
    expect((await run(same, ['apply', ...ARGS])).code).toBe(0);
  });

  it('a database that already holds a schema is an upgrade: no migration by the installer', async () => {
    const h = host();
    h.migrations = { applied: 5, pending: 4, unknown: 0, reachable: true };
    const r = await run(h, ['apply', ...ARGS]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/БД уже містить схему/);
    expect(h.changes).not.toContain('migrate up');
    // A database already at this release's schema (e.g. reinstall) is fine.
    const done = host();
    done.migrations = { applied: 9, pending: 0, unknown: 0, reachable: true };
    expect((await run(done, ['apply', ...ARGS])).code).toBe(0);
    expect(done.changes).not.toContain('migrate up');
  });
});

describe('server installer: partial failure and continuation', () => {
  it('failed migration: stop with recovery advice, not activated; the next apply continues from the migration', async () => {
    const h = host();
    h.fail('migrate.js up', '[migrate] up failed (category=database code=42P07); nothing was committed by a failed up', true);
    const first = await run(h, ['apply', ...ARGS]);
    expect(first.code).toBe(1);
    expect(first.all).toMatch(/схема БД .* не вдалося/);
    expect(first.all).toMatch(/Встановлення НЕ завершене/);
    expect(first.all).not.toMatch(/Готово/);
    expect(h.changes.some((c) => c.startsWith('activate'))).toBe(false);
    h.changes = [];
    const second = await run(h, ['apply', ...ARGS]);
    expect(second.code).toBe(0);
    expect(h.changes[0]).toBe('migrate up');
    expect(h.changes).not.toContain('useradd nodecontrol');
  });

  it('failed start: "not started" is reported, never "installed"; a re-run starts it', async () => {
    const h = host();
    h.fail('systemctl start node-control-api.service', 'Job failed', true);
    const first = await run(h, ['apply', ...ARGS]);
    expect(first.code).toBe(1);
    expect(first.all).toMatch(/служба node-control-api\.service: не вдалося/);
    expect(first.all).not.toMatch(/health пройдено/);
    expect((await run(h, ['apply', ...ARGS])).code).toBe(0);
  });

  it('service runs but health fails: three distinct results, exit 1', async () => {
    const h = host();
    h.http.set('http://127.0.0.1:3100/health/ready', 503);
    const r = await run(h, ['apply', ...ARGS]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/✓ служба node-control-api\.service запущена/);
    expect(r.all).toMatch(/✓ \/health\/live — 200/);
    expect(r.all).toMatch(/✗ \/health\/ready — 503/);
    expect(r.all).toMatch(/НЕ підтверджене/);
  });
});

describe('server installer: arguments', () => {
  it.each([
    [['apply', '--artifact', '/x/node-control-api-123.tar.gz']],
    [['apply', ...ARGS.slice(0, 4), '--public-url', 'https://x.example.com/$(id)']],
    [['apply', ...ARGS.slice(0, 4), '--public-url', 'http://control.example.com']],
    [['apply', ...ARGS, '--admin-email', 'a@b.example;reboot']],
    [['apply', ...ARGS, '--unknown']],
    [['install', ...ARGS]],
  ])('%j → exit 2, nothing inspected', async (argv) => {
    const h = host();
    const r = await run(h, argv);
    expect(r.code).toBe(2);
    expect(h.changes).toEqual([]);
  });

  it('--help prints the usage; nginx-config renders a site without touching the host', async () => {
    const h = host();
    expect((await run(h, ['--help'])).all).toMatch(/node install\/server\.js plan/);
    const r = await run(h, ['nginx-config', '--server-name', 'control.example.com', '--certificate', '/etc/ssl/nc/fullchain.pem', '--certificate-key', '/etc/ssl/nc/privkey.pem']);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3100;/);
    expect(r.all).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(r.all).toMatch(/root {2}\/opt\/node-control\/current\/frontend\/dist;/);
    expect(h.calls).toEqual([]);
    expect((await run(h, ['nginx-config', '--server-name', 'evil;}', '--certificate', '/a', '--certificate-key', '/b'])).code).toBe(2);
  });
});
