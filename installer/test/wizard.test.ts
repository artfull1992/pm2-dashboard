import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentMain } from '../src/agent.js';
import { serverMain } from '../src/server.js';
import { type Prompter, wizardMain } from '../src/wizard.js';
import { capture, FakeHost, REV } from './fake-host.js';

// Guided installer (install.sh → wizard) on FakeHost with the REAL installers behind it: component choice, answers,
// plan without changes, explicit confirmation, apply, cancel/EOF, no TTY, release/bundle checks, PM2 owner discovery
// separate from the invoking user, secrets never in output or argv, recovery by running the wizard again.

const RELEASE = '/srv/node control/releases/r1'; // spaces on purpose
const BUNDLE = `${RELEASE}/server-bundle`;
const DB_PASS = 'Synthetic-db-Secret-0123456789';
const TOKEN = `ncag_${'W'.repeat(43)}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function mkdirp(h: FakeHost, path: string, mode = 0o755, uid = 0, gid = 0) {
  const parts = path.split('/').filter((x) => x !== '');
  let cur = '';
  for (const part of parts) { cur += `/${part}`; if (!h.files.has(cur)) h.dir(cur, mode, uid, gid); }
}

/** A prepared release as build-release.js writes it: artifacts + .sha256 + server-bundle with BUNDLE.json. */
function release(h: FakeHost, options: { revision?: string; agent?: boolean; api?: boolean } = {}) {
  const revision = options.revision ?? REV;
  mkdirp(h, `${BUNDLE}/install`);
  const files: Record<string, string> = {};
  for (const [path, content] of [['server-release.js', 'tool'], ['install/wizard.js', 'wizard'], ['install/server.js', 'server'], ['install/agent.js', 'agent']]) {
    h.file(`${BUNDLE}/${path ?? ''}`, content ?? '');
    files[path ?? ''] = sha(content ?? '');
  }
  h.file(`${BUNDLE}/BUNDLE.json`, JSON.stringify({ revision, files }));
  for (const kind of ['api', 'agent'] as const) {
    if (options[kind] === false) continue;
    const name = `node-control-${kind}-${REV}.tar.gz`;
    h.file(`${RELEASE}/${name}`, `artifact-${kind}`);
    h.file(`${RELEASE}/${name}.sha256`, `${sha(`artifact-${kind}`)}  ${name}\n`);
  }
}

function host(): FakeHost {
  const h = new FakeHost();
  release(h);
  mkdirp(h, '/root/my secrets', 0o700);
  h.file('/root/my secrets/db.env', `DB_NAME=node_control_db\nDB_USER=node_control_user\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASS=${DB_PASS}\n`, 0o600);
  h.http.set('https://control.example.com/api/auth/me', 401);
  h.agentLogs = () => '{"level":"info","msg":"heartbeat","outcome":"accepted"}\n{"level":"info","msg":"inventory","outcome":"accepted","state":"ok"}';
  return h;
}

function prompter(answers: (string | null)[], hidden: (string | null)[] = [], isTTY = true) {
  const asked: string[] = [];
  const p: Prompter = {
    isTTY,
    ask: (q) => { asked.push(q); return Promise.resolve(answers.length > 0 ? answers.shift() ?? null : null); },
    hidden: (q) => { asked.push(q); return Promise.resolve(hidden.length > 0 ? hidden.shift() ?? null : null); },
  };
  return { p, asked };
}

async function run(h: FakeHost, p: Prompter, env: Record<string, string> = { SUDO_USER: 'admin' }, argv = ['--release', RELEASE]) {
  const c = capture();
  const runs: { argv: string[]; changesBefore: number; changesAfter: number }[] = [];
  const track = (main: typeof serverMain): typeof serverMain => async (a, deps) => {
    const r = { argv: [...a], changesBefore: h.changes.length, changesAfter: 0 };
    runs.push(r);
    const code = await main(a, deps);
    r.changesAfter = h.changes.length;
    return code;
  };
  const code = await wizardMain(argv, { host: h, out: c.out, prompter: p, env, bundleDir: BUNDLE, server: track(serverMain), agent: track(agentMain) });
  return { code, all: c.all, runs };
}

const SERVER_ANSWERS = ['1', '/root/my secrets/db.env', 'https://control.example.com', '', '', '', 'так'];

describe('wizard: basics', () => {
  it('--help needs neither root nor a terminal', async () => {
    const h = host();
    h.euidValue = 1000;
    const r = await run(h, prompter([], [], false).p, {}, ['--help']);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/sudo \.\/install\.sh/);
    expect(h.calls).toEqual([]);
  });

  it('no terminal → refused with the non-interactive CLI route; nothing inspected or changed', async () => {
    const h = host();
    const r = await run(h, prompter([], [], false).p);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/лише в терміналі[\s\S]*server\.js plan\|apply[\s\S]*agent\.js plan\|apply/);
    expect(h.changes).toEqual([]);
    expect(r.runs).toEqual([]);
  });

  it('not root → refused after the (read-only) release check', async () => {
    const h = host();
    h.euidValue = 1000;
    const r = await run(h, prompter(['1']).p);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/потрібен root/);
    expect(r.runs).toEqual([]);
  });

  it.each([
    ['a bundle file changed', (h: FakeHost) => { h.file(`${BUNDLE}/install/server.js`, 'other build'); }, /install\/server\.js: вміст змінено/],
    ['an extra file in the bundle (stale installer/dist)', (h: FakeHost) => { h.file(`${BUNDLE}/install/old.js`, 'x'); }, /install\/old\.js: зайвий файл/],
    ['no BUNDLE.json', (h: FakeHost) => { h.files.delete(`${BUNDLE}/BUNDLE.json`); }, /немає BUNDLE\.json/],
    ['artifacts of another revision', (h: FakeHost) => { const n = `node-control-agent-${'b'.repeat(40)}.tar.gz`; h.file(`${RELEASE}/${n}`, 'x'); h.file(`${RELEASE}/${n}.sha256`, 'x'); }, /артефакт іншої ревізії/],
    ['a symlink in the bundle', (h: FakeHost) => { h.files.set(`${BUNDLE}/install/link.js`, { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target: '/etc/passwd' }); }, /не звичайний файл/],
  ])('release check: %s → refused before any question or change', async (_n, arrange, message) => {
    const h = host();
    arrange(h);
    const s = prompter(['1']);
    const r = await run(h, s.p);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(message);
    expect(s.asked).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it('--release through a symlinked path to the same release is accepted (canonical paths are compared)', async () => {
    const h = host();
    h.aliases.set('/var/rel-link', RELEASE);
    const r = await run(h, prompter([...SERVER_ANSWERS]).p, {}, ['--release', '/var/rel-link']);
    expect(r.code).toBe(0);
  });

  // Review 2026-10-21 (P2): BUNDLE.json is external input — validated at runtime, a controlled refusal, no TypeError.
  it.each([
    ['not JSON', '{bad'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['a number', '42'],
    ['no revision', JSON.stringify({ files: {} })],
    ['a short revision', JSON.stringify({ revision: 'abc', files: {} })],
    ['files is null', JSON.stringify({ revision: REV, files: null })],
    ['files is an array', JSON.stringify({ revision: REV, files: [] })],
    ['a hash that is not a string', JSON.stringify({ revision: REV, files: { 'server-release.js': 1 } })],
    ['a malformed hash', JSON.stringify({ revision: REV, files: { 'server-release.js': 'zz' } })],
    ['a path outside the bundle', JSON.stringify({ revision: REV, files: { '../evil.js': sha('x') } })],
  ])('BUNDLE.json %s → controlled refusal before any question or change', async (_n, content) => {
    const h = host();
    h.file(`${BUNDLE}/BUNDLE.json`, content);
    const s = prompter(['1']);
    const r = await run(h, s.p);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/BUNDLE\.json/);
    expect(r.all).not.toMatch(/TypeError|Cannot read properties/);
    expect(s.asked).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it('wizard started from another place than the release bundle (e.g. a checkout installer/dist) → refused', async () => {
    const h = host();
    const c = capture();
    const code = await wizardMain(['--release', RELEASE], { host: h, out: c.out, prompter: prompter(['1']).p, bundleDir: '/home/u/node-control/installer/dist/..' });
    expect(code).toBe(1);
    expect(c.all).toMatch(/не з бандла цього релізу/);
  });
});

describe('wizard: Central Server', () => {
  it('answers → summary without secrets → plan (no change) → "так" → apply with the same arguments', async () => {
    const h = host();
    const r = await run(h, prompter([...SERVER_ANSWERS]).p);
    expect(r.code).toBe(0);
    expect(r.runs.map((x) => x.argv[0])).toEqual(['plan', 'apply']);
    expect(r.runs[0]?.argv.slice(1)).toEqual(r.runs[1]?.argv.slice(1));
    expect(r.runs[0]?.argv).toEqual(['plan', '--artifact', `${RELEASE}/node-control-api-${REV}.tar.gz`, '--db-env', '/root/my secrets/db.env', '--public-url', 'https://control.example.com']);
    expect(r.runs[0]?.changesAfter).toBe(0); // the plan changed nothing
    expect(h.changes).toContain('useradd nodecontrol');
    expect(r.all).toMatch(/Параметри \(секрети не показуються\)[\s\S]*DB credentials: \/root\/my secrets\/db\.env \(вміст не показується\)/);
    expect(r.all).not.toContain(DB_PASS);
    expect(h.calls.flatMap((c) => c.args).join(' ')).not.toContain(DB_PASS);
    // The installer ran from the release bundle (its server-release.js), not from a checkout.
    expect(h.calls.some((c) => c.args[0] === `${BUNDLE}/server-release.js` && c.args[1] === 'prepare')).toBe(true);
  });

  it('anything but «так» at the confirmation → cancelled after the plan, nothing changed', async () => {
    for (const answer of ['ні', 'y', '', 'tak']) {
      const h = host();
      const r = await run(h, prompter([...SERVER_ANSWERS.slice(0, -1), answer]).p);
      expect(r.code, answer).toBe(130);
      expect(r.runs.map((x) => x.argv[0])).toEqual(['plan']);
      expect(h.changes).toEqual([]);
      expect(r.all).toMatch(/Скасовано\. Нічого не змінено/);
    }
  });

  it('EOF / Ctrl+C at any question → cancelled without a stack trace, nothing changed', async () => {
    for (let cut = 0; cut < SERVER_ANSWERS.length - 1; cut++) {
      const h = host();
      const r = await run(h, prompter([...SERVER_ANSWERS.slice(0, cut), null]).p);
      expect(r.code, String(cut)).toBe(130);
      expect(h.changes).toEqual([]);
      expect(r.all).not.toMatch(/Error|at .*\(/);
    }
    // «0» in a menu cancels as well.
    expect((await run(host(), prompter(['0']).p)).code).toBe(130);
  });

  it('invalid answers are asked again (URL, db file), never passed on', async () => {
    const h = host();
    h.file('/root/open.env', 'DB_PASS=x\n', 0o644);
    const r = await run(h, prompter(['1', '/root/open.env', '/root/my secrets/db.env', 'http://control.example.com', 'https://control.example.com/x', 'https://control.example.com', 'a@b;reboot', '', '', '', 'так']).p);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/chmod 600/);
    expect(r.all.match(/спробуйте ще раз/g)?.length).toBe(4);
    expect(r.runs[1]?.argv).not.toContain('/root/open.env');
  });

  it('a plan with blockers stops before the confirmation question', async () => {
    const h = host();
    h.tcp = false; // PostgreSQL not reachable
    const s = prompter([...SERVER_ANSWERS]);
    const r = await run(h, s.p);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/План має блокувальні проблеми/);
    expect(s.asked.some((q) => q.includes('Виконати встановлення'))).toBe(false);
    expect(h.changes).toEqual([]);
  });

  it('partial failure, then the wizard again with the same answers: resumes (pending restart honoured)', async () => {
    const h = host();
    h.fail('migrate.js up', 'failed', true);
    const first = await run(h, prompter([...SERVER_ANSWERS]).p);
    expect(first.code).toBe(1);
    expect(first.all).toMatch(/запустіть майстер ще раз з тими самими відповідями/);
    h.changes = [];
    const second = await run(h, prompter([...SERVER_ANSWERS]).p);
    expect(second.code).toBe(0);
    expect(h.changes[0]).toBe('migrate up');
    expect(h.changes).not.toContain('useradd nodecontrol');
  });

  it('an error after apply started is reported as a possibly partial change (never "nothing changed"), no stack trace', async () => {
    const h = host();
    const c = capture();
    let calls = 0;
    const failing: typeof serverMain = async (a, deps) => { calls += 1; if (a[0] === 'apply') throw new Error('interrupted'); return serverMain(a, deps); };
    const code = await wizardMain(['--release', RELEASE], { host: h, out: c.out, prompter: prompter([...SERVER_ANSWERS]).p, bundleDir: BUNDLE, server: failing });
    expect(code).toBe(1);
    expect(calls).toBe(2);
    expect(c.all).toMatch(/частину змін могло бути вже застосовано/);
    expect(c.all).not.toMatch(/Скасовано\. Нічого не змінено/);
  });

  it('existing api.env: no db file asked, URL optional, credentials kept', async () => {
    const h = host();
    expect((await run(h, prompter([...SERVER_ANSWERS]).p)).code).toBe(0);
    const s = prompter(['1', '', '', '', '', 'так']);
    const r = await run(h, s.p);
    expect(r.code).toBe(0);
    expect(s.asked.some((q) => q.includes('DB_*'))).toBe(false);
    expect(r.runs[1]?.argv).toEqual(['apply', '--artifact', `${RELEASE}/node-control-api-${REV}.tar.gz`]);
  });
});

describe('wizard: Agent and the PM2 owner', () => {
  function withDaemon(h: FakeHost, owner: string, uid: number, pm2Home: string) {
    const u = h.addUser(owner, uid, { home: `/srv/home-${owner}` });
    mkdirp(h, pm2Home, 0o775, u.uid, u.gid);
    h.files.set(`${pm2Home}/rpc.sock`, { kind: 'socket', mode: 0o775, uid: u.uid, gid: u.gid });
    h.procs.push({ pid: 4000 + uid, uid, title: `PM2 v7.0.4: God Daemon (${pm2Home})` });
  }

  it('detected daemon of ANOTHER user than the one who ran sudo, non-standard PM2_HOME; key hidden, never printed or in argv', async () => {
    const h = host();
    h.addUser('admin', 1001);
    withDaemon(h, 'deploy', 1000, '/srv/apps/deploy-pm2');
    const r = await run(h, prompter(['2', 'https://control.example.com', '2', '1', 'так', 'так'], [TOKEN]).p, { SUDO_USER: 'admin' });
    expect(r.code).toBe(0);
    expect(r.runs[1]?.argv).toEqual(['apply', '--artifact', `${RELEASE}/node-control-agent-${REV}.tar.gz`, '--api-url', 'https://control.example.com', '--token-stdin', '--pm2-owner', 'deploy', '--pm2-home', '/srv/apps/deploy-pm2']);
    expect(r.all).toMatch(/deploy: PM2_HOME \/srv\/apps\/deploy-pm2 \(pid 5000\)/);
    expect(r.all).toMatch(/Ключ Agent: введено \(приховано\)/);
    expect(r.all).not.toContain(TOKEN);
    expect(h.calls.flatMap((c) => [...c.args, c.input ?? '']).join(' ')).not.toContain(TOKEN);
    expect(h.text('/etc/node-control-agent/agent.env')).toContain(TOKEN);
    expect(h.calls.filter((c) => /(^|\/)pm2$/.test(c.command))).toEqual([]);
  });

  it('several daemons → explicit choice; a root-owned daemon is listed but cannot be chosen', async () => {
    const h = host();
    withDaemon(h, 'deploy', 1000, '/srv/apps/deploy-pm2');
    withDaemon(h, 'shop', 1002, '/home/shop/.pm2');
    h.procs.push({ pid: 1, uid: 0, title: 'PM2 v7.0.4: God Daemon (/root/.pm2)' });
    const r = await run(h, prompter(['2', 'https://control.example.com', '2', '2', 'так', 'так'], [TOKEN]).p);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/root: PM2_HOME \/root\/\.pm2 \(pid 1\) — від root: не підтримується/);
    expect(r.all).toMatch(/1\) власник deploy[\s\S]*2\) власник shop[\s\S]*3\) Вказати власника й PM2_HOME вручну/);
    expect(r.runs[1]?.argv).toContain('shop');
  });

  it('no daemon → manual entry: SUDO_USER is only a hint, home from the account, <home>/.pm2 only after confirmation', async () => {
    const h = host();
    const u = h.addUser('deploy', 1000, { home: '/srv/home-deploy' });
    mkdirp(h, '/srv/home-deploy/.pm2', 0o775, u.uid, u.gid);
    h.addUser('admin', 1001);
    // Enter would take the hint "admin" — the operator types "deploy" instead; Enter accepts /srv/home-deploy/.pm2.
    const s = prompter(['2', 'https://control.example.com', '2', '1', 'deploy', '', 'так', 'так'], [TOKEN]);
    const r = await run(h, s.p, { SUDO_USER: 'admin' });
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/Працюючих PM2 daemon не знайдено/);
    expect(s.asked.some((q) => q.includes('Enter — admin, користувач, що запустив sudo; це лише підказка'))).toBe(true);
    expect(s.asked.some((q) => q.includes('Enter — /srv/home-deploy/.pm2: типове місце, НЕ перевірений факт'))).toBe(true);
    expect(r.runs[1]?.argv).toEqual(expect.arrayContaining(['--pm2-owner', 'deploy', '--pm2-home', '/srv/home-deploy/.pm2']));
  });

  it('manual owner root or a missing user is refused and asked again; declining the PM2 owner cancels', async () => {
    const h = host();
    withDaemon(h, 'deploy', 1000, '/srv/apps/deploy-pm2');
    const r = await run(h, prompter(['2', 'https://control.example.com', '2', '2', 'root', 'ghost', 'deploy', '/srv/apps/deploy-pm2', 'ні'], [TOKEN]).p);
    expect(r.code).toBe(130);
    expect(r.all).toMatch(/root не підтримується/);
    expect(r.all).toMatch(/користувача ghost немає/);
    expect(r.runs).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it('broker auto mode: access decided by the API, no allowlist', async () => {
    const h = host();
    withDaemon(h, 'deploy', 1000, '/srv/apps/deploy-pm2');
    const r = await run(h, prompter(['2', 'https://control.example.com', '3', '1', 'так', 'так'], [TOKEN]).p);
    expect(r.code).toBe(0);
    expect(r.runs[1]?.argv).toEqual(expect.arrayContaining(['--enable-control', '--control-mode', 'auto']));
    expect(h.text('/etc/node-control-pm2-broker/deploy.env')).toMatch(/^NC_BROKER_MODE=auto$/m);
    expect(h.stat('/etc/node-control-pm2-broker/deploy.allowlist.json')).toBeNull();
  });

  it('broker allowlist mode: empty allowlist, nothing allowed', async () => {
    const h = host();
    withDaemon(h, 'deploy', 1000, '/srv/apps/deploy-pm2');
    const r = await run(h, prompter(['2', 'https://control.example.com', '4', '1', 'так', 'так'], [TOKEN]).p);
    expect(r.code).toBe(0);
    expect(r.runs[1]?.argv).toEqual(expect.arrayContaining(['--enable-control', '--control-mode', 'allowlist']));
    expect(h.text('/etc/node-control-pm2-broker/deploy.allowlist.json')).toBe('{"version":1,"targets":[]}\n');
  });

  it('wrong key format asked again (value not echoed); existing agent.env → no key, no URL, nothing rotated', async () => {
    const h = host();
    const s = prompter(['2', 'https://control.example.com', '1', 'так'], ['ncag_wrong-secret', TOKEN]);
    const first = await run(h, s.p);
    expect(first.code).toBe(0);
    expect(first.all).toMatch(/неправильний формат ключа/);
    expect(first.all).not.toContain('wrong-secret');
    const env = h.text('/etc/node-control-agent/agent.env');
    h.changes = [];
    const again = prompter(['2', '1', 'так']);
    const second = await run(h, again.p);
    expect(second.code).toBe(0);
    expect(again.asked.some((q) => q.includes('Ключ') || q.includes('HTTPS-адреса'))).toBe(false);
    expect(second.runs[1]?.argv).toEqual(['apply', '--artifact', `${RELEASE}/node-control-agent-${REV}.tar.gz`]);
    expect(h.text('/etc/node-control-agent/agent.env')).toBe(env);
    expect(h.changes).toEqual([]);
  });

  it('a release without the Agent artifact → clear refusal, nothing changed', async () => {
    const h = new FakeHost();
    release(h, { agent: false });
    const r = await run(h, prompter(['2']).p);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/немає потрібного артефакту/);
    expect(h.changes).toEqual([]);
  });
});
