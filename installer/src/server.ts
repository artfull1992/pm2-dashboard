#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT, execute, type Plan, platformPreflight } from './cli.js';
import { consoleReporter, type Context, mustRun, type Preflight, type Reporter, safeMessage, type Step, systemctlState } from './engine.js';
import { appendMissing, missingKeys, parseEnvText } from './envfile.js';
import { type Host, realHost } from './host.js';
import { renderNginxSite } from './nginx.js';
import { activateStep, checkArtifact, checkBase, checkNotOtherRelease, defaultReleaseTool, prepareStep } from './release.js';
import { DAEMON_RELOAD, service, serviceAccountPreflight, systemUser, unitFile } from './resources.js';
import { loadPending } from './state.js';
import { processInput, type SecretInput, secretFileProblems } from './secrets.js';
import { artifactRef, email, filePath, httpsOrigin, InputError } from './validate.js';

// Central API installer (first installation on a clean Ubuntu host). Uses the deployment contract of
// docs/DEPLOYMENT.md as is: user nodecontrol, /opt/node-control releases via server-release.js, /etc/node-control/api.env,
// the unit from the release, migrations BEFORE activation, bootstrap through the existing CLI.

export const API = Object.freeze({
  user: 'nodecontrol',
  base: '/opt/node-control',
  configDir: '/etc/node-control',
  config: '/etc/node-control/api.env',
  unit: 'node-control-api.service',
  defaultPort: 3100,
});
const DB_KEYS = ['DB_NAME', 'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_PASS'] as const;
const PLAIN_VALUE = /^[A-Za-z0-9_.:-]+$/; // what server-release.js config accepts unquoted
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const RESTART = 'restart-api';

export const SERVER_USAGE = `Node Control — встановлення Central API (Ubuntu + systemd, Node.js 22, host PostgreSQL).

Використання (root, з каталогу переданого server-bundle):
  node install/server.js plan  --artifact <node-control-api-<sha>.tar.gz> [параметри]   перевірки й план, без змін
  node install/server.js apply --artifact <node-control-api-<sha>.tar.gz> [параметри]   виконати (повторний запуск безпечний)
  node install/server.js nginx-config --server-name <домен> --certificate <crt> --certificate-key <key>
                                                                                         вивести конфіг Nginx (нічого не змінює)
Параметри plan/apply:
  --artifact <файл>          артефакт build-release.js; поруч має лежати <файл>.sha256
  --db-env <файл>            DB_NAME/DB_USER/DB_HOST/DB_PORT/DB_PASS (root, 600) — лише для першого створення api.env
  --public-url <https-origin> публічна адреса UI (AUTH_ALLOWED_ORIGINS, ALERTS_PUBLIC_URL) — для першого встановлення
  --behind-nginx             додати API_TRUSTED_PROXIES=127.0.0.1 (лише коли Nginx уже проксіює за наданим шаблоном)
  --enable-pm2-control       додати PM2_CONTROL_ENABLED=true (керування PM2 на рівні API; на нодах — окремо)
  --admin-email <email>      створити першого адміністратора через bootstrap-admin.js (пароль — прихований ввід)
  --admin-password-file <ф>  пароль адміністратора з файлу (root, 600) замість введення
  -h, --help                 ця довідка
Наявні значення в api.env ніколи не змінюються: додаються лише відсутні ключі (з резервною копією 600).
Інший активний реліз не перемикається; міграції існуючої БД з даними — лише штатною процедурою оновлення.
Докладно: docs/INSTALLATION.md.`;

export interface ServerOptions {
  mode: 'plan' | 'apply';
  artifact: string;
  dbEnv: string | null;
  publicUrl: string | null;
  behindNginx: boolean;
  enablePm2Control: boolean;
  adminEmail: string | null;
  adminPasswordFile: string | null;
  releaseTool: string;
}

export function parseServerArgs(argv: readonly string[], cwd: string, releaseTool = defaultReleaseTool()): ServerOptions | { help: true } | { nginx: { serverName: string; certificate: string; certificateKey: string } } {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true, strict: true,
    options: {
      artifact: { type: 'string' }, 'db-env': { type: 'string' }, 'public-url': { type: 'string' },
      'behind-nginx': { type: 'boolean', default: false }, 'enable-pm2-control': { type: 'boolean', default: false },
      'admin-email': { type: 'string' }, 'admin-password-file': { type: 'string' },
      'server-name': { type: 'string' }, certificate: { type: 'string' }, 'certificate-key': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') return { help: true };
  if (rest.length > 0) throw new InputError(`зайві аргументи: ${rest.join(' ')}`);
  if (command === 'nginx-config') {
    return { nginx: { serverName: values['server-name'] ?? '', certificate: values.certificate ?? '', certificateKey: values['certificate-key'] ?? '' } };
  }
  if (command !== 'plan' && command !== 'apply') throw new InputError('команда: plan, apply або nginx-config (--help — довідка)');
  return {
    mode: command,
    artifact: filePath(values.artifact, '--artifact', cwd),
    dbEnv: values['db-env'] === undefined ? null : filePath(values['db-env'], '--db-env', cwd),
    publicUrl: values['public-url'] === undefined ? null : httpsOrigin(values['public-url'], '--public-url'),
    behindNginx: values['behind-nginx'],
    enablePm2Control: values['enable-pm2-control'],
    adminEmail: values['admin-email'] === undefined ? null : email(values['admin-email'], '--admin-email'),
    adminPasswordFile: values['admin-password-file'] === undefined ? null : filePath(values['admin-password-file'], '--admin-password-file', cwd),
    releaseTool,
  };
}

/** Problems of an existing api.env (names only, never values). */
export function apiConfigProblems(host: Host, text: string): string[] {
  const env = parseEnvText(text);
  const problems = DB_KEYS.filter((k) => !env[k]).map((k) => `${k} відсутній`);
  if (env.API_HOST !== undefined && !LOOPBACK.has(env.API_HOST)) problems.push('API_HOST має бути loopback-адресою');
  const info = host.stat(API.config);
  const user = host.user(API.user);
  if (info && (info.mode !== 0o600 || (user && info.uid !== user.uid))) problems.push(`права ${API.config}: очікується 600 ${API.user}`);
  return problems;
}

/** Keys the installer adds when missing (values for the secret key are generated only at apply time). */
function wantedEntries(o: ServerOptions, host: Host, existing: Record<string, string>): [string, string][] {
  const entries: [string, string][] = [['AUTH_COOKIE_SECURE', 'true']];
  if (o.publicUrl) entries.push(['AUTH_ALLOWED_ORIGINS', o.publicUrl], ['ALERTS_PUBLIC_URL', o.publicUrl]);
  if (!('ALERTS_SECRET_KEY' in existing)) entries.push(['ALERTS_SECRET_KEY', host.randomBytes(32).toString('base64')], ['ALERTS_SECRET_KEY_VERSION', '1']);
  if (o.behindNginx) entries.push(['API_TRUSTED_PROXIES', '127.0.0.1']);
  if (o.enablePm2Control) entries.push(['PM2_CONTROL_ENABLED', 'true']);
  return entries;
}
const wantedKeys = (o: ServerOptions) => [
  'AUTH_COOKIE_SECURE', ...(o.publicUrl ? ['AUTH_ALLOWED_ORIGINS', 'ALERTS_PUBLIC_URL'] : []), 'ALERTS_SECRET_KEY',
  ...(o.behindNginx ? ['API_TRUSTED_PROXIES'] : []), ...(o.enablePm2Control ? ['PM2_CONTROL_ENABLED'] : []),
];

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function configStep(o: ServerOptions): Step {
  return {
    id: 'config:create',
    title: `конфігурація ${API.config}`,
    check({ host }) {
      if (!host.stat(API.config)) return { state: 'pending', detail: 'server-release.js config: DB_* з --db-env, 600 nodecontrol (лише якщо файлу немає)' };
      const problems = apiConfigProblems(host, host.readFile(API.config));
      return problems.length === 0
        ? { state: 'done', detail: 'наявний файл збережено без змін' }
        : { state: 'conflict', detail: problems.join('; '), fix: `виправте ${API.config} вручну (резервна копія — до змін); інсталятор наявні значення не перезаписує` };
    },
    apply({ host }) {
      if (!o.dbEnv) throw new Error('потрібен --db-env');
      mustRun(host, '/usr/bin/node', [o.releaseTool, 'config', '--config', API.config, '--legacy-env', o.dbEnv, '--owner', API.user], 'server-release.js config');
    },
    effects: [RESTART],
    recovery: `server-release.js config створює файл атомарно; якщо ${API.config} з'явився з помилкою — збережіть копію, виправте вручну й повторіть`,
  };
}

function configKeysStep(o: ServerOptions): Step {
  return {
    id: 'config:keys',
    title: 'параметри API (лише відсутні ключі)',
    check({ host }) {
      const text = host.stat(API.config) ? host.readFile(API.config) : '';
      const missing = missingKeys(text, wantedKeys(o));
      if (missing.length === 0) return { state: 'done' };
      return { state: 'pending', detail: `додати: ${missing.join(', ')} (резервна копія api.env.bak-<час>, 600)` };
    },
    apply({ host }) {
      const text = host.readFile(API.config);
      const { text: next } = appendMissing(text, wantedEntries(o, host, parseEnvText(text)));
      const user = host.user(API.user);
      if (!user) throw new Error(`немає користувача ${API.user}`);
      const owner = { mode: 0o600, uid: user.uid, gid: user.gid };
      host.writeFileAtomic(`${API.config}.bak-${stamp(host.now())}`, text, owner);
      host.writeFileAtomic(API.config, next, owner);
    },
    effects: [RESTART],
    recovery: `попередній вміст — у ${API.config}.bak-<час> (600); перевірте вільне місце/права ${API.configDir} і повторіть`,
  };
}

const migrateArgs = (revision: string, command: 'status' | 'up') => [
  '-u', API.user, '--', '/usr/bin/env', `ENV_FILE=${API.config}`, '/usr/bin/node', `${API.base}/releases/${revision}/backend/dist/migrate.js`, command,
];

function migrationsStep(revision: string): Step {
  const ready = (host: Host) => host.stat(`${API.base}/releases/${revision}`) !== null && host.stat(API.config) !== null;
  return {
    id: 'db:migrations',
    title: 'схема БД (міграції до активації)',
    check({ host }) {
      if (!ready(host)) return { state: 'pending', detail: 'буде перевірено migrate.js status після підготовки релізу й конфігурації; порожня БД → up' };
      const r = host.run('runuser', migrateArgs(revision, 'status'));
      if (r.code !== 0) throw new Error(`migrate.js status: ${(r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200) || `код ${String(r.code)}`} — перевірте, що PostgreSQL працює, а DB_* у ${API.config} правильні`);
      const m = /applied=(\d+) pending=(\d+) unknown=(\d+)/.exec(r.stdout);
      if (!m) throw new Error('migrate.js status: неочікуваний вивід');
      const [applied, pending, unknown] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (unknown > 0) return { state: 'conflict', detail: `у БД є ${String(unknown)} міграцій, яких немає в цьому релізі (БД новіша за реліз)`, fix: 'встановлюйте реліз, не старіший за схему БД' };
      if (pending === 0) return { state: 'done', detail: `застосовано ${String(applied)}` };
      if (applied > 0) {
        return { state: 'conflict', detail: `БД уже містить схему (${String(applied)} застосовано, ${String(pending)} очікує)`, fix: 'це оновлення наявної БД: backup → migrate up за docs/INSTALLATION.md («Оновлення»); інсталятор міграції БД з даними не запускає' };
      }
      return { state: 'pending', detail: `порожня БД: migrate.js up (${String(pending)} міграцій, одна транзакція)` };
    },
    apply({ host }) { mustRun(host, 'runuser', migrateArgs(revision, 'up'), 'migrate.js up'); },
    recovery: 'невдалий up відкочується повністю (одна транзакція): причину видно вище; БД не змінена — виправте й повторіть',
  };
}

function adminStep(o: ServerOptions, revision: string): Step {
  return {
    id: 'admin:bootstrap',
    title: `перший адміністратор (${o.adminEmail ?? ''})`,
    check: (ctx: Context) => (ctx.effects.has('admin-done') ? { state: 'done' } : { state: 'pending', detail: o.adminPasswordFile ? 'bootstrap-admin.js --password-stdin (з файлу)' : 'bootstrap-admin.js — пароль буде запитано двічі, приховано' }),
    apply(ctx) {
      const { host } = ctx;
      const args = ['-u', API.user, '--', '/usr/bin/env', `ENV_FILE=${API.config}`, '/usr/bin/node', `${API.base}/releases/${revision}/backend/dist/bootstrap-admin.js`, '--email', o.adminEmail ?? ''];
      const r = o.adminPasswordFile
        ? host.run('runuser', [...args, '--password-stdin'], { input: host.readFile(o.adminPasswordFile) })
        : host.run('runuser', args, { interactive: true });
      if (r.code === 3) ctx.out.line('    адміністратор уже існує або email зайнятий — нічого не змінено');
      else if (r.code !== 0) throw new Error(`bootstrap-admin.js: код ${String(r.code)} (2 — ввід/параметри, 1 — помилка БД; нічого не закомічено)`);
      ctx.effects.add('admin-done');
    },
    recovery: 'bootstrap або створює адміністратора повністю, або нічого; повторіть з --admin-email (наявного адміністратора не змінить)',
  };
}

async function readPort(host: Host): Promise<number> {
  await Promise.resolve();
  const port = host.stat(API.config) ? parseEnvText(host.readFile(API.config)).API_PORT : undefined;
  return port && /^\d{1,5}$/.test(port) ? Number(port) : API.defaultPort;
}

async function waitStatus(host: Host, url: string, seconds: number): Promise<number | null> {
  let status: number | null = null;
  for (let i = 0; i < seconds; i++) {
    status = await host.httpStatus(url, 2000);
    if (status === 200) return status;
    await host.sleep(1000);
  }
  return status;
}

export async function verifyServer(ctx: Context): Promise<boolean> {
  const { host, out } = ctx;
  out.line('\nПеревірка результату:');
  const active = systemctlState(host, 'is-active', API.unit) === 'active';
  out.line(active ? `  ✓ служба ${API.unit} запущена` : `  ✗ служба ${API.unit} не запущена (systemctl status ${API.unit}; journalctl -u ${API.unit} -n 50 -o cat)`);
  if (!active) return false;
  const port = await readPort(host);
  const live = await waitStatus(host, `http://127.0.0.1:${String(port)}/health/live`, 30);
  out.line(live === 200 ? '  ✓ /health/live — 200 (процес відповідає)' : `  ✗ /health/live — ${live === null ? 'немає відповіді' : String(live)} за 30 с (journalctl -u ${API.unit} -n 50 -o cat)`);
  if (live !== 200) return false;
  const ready = await waitStatus(host, `http://127.0.0.1:${String(port)}/health/ready`, 15);
  out.line(ready === 200 ? '  ✓ /health/ready — 200 (БД доступна): health пройдено' : `  ✗ /health/ready — ${ready === null ? 'немає відповіді' : String(ready)}: API не бачить БД (перевірте PostgreSQL і DB_*)`);
  return ready === 200;
}

export async function buildServerPlan(host: Host, o: ServerOptions, input: SecretInput): Promise<Plan> {
  const p: Preflight = { errors: [], warnings: [], notes: [] };
  platformPreflight(host, p, ['useradd', 'runuser', 'systemctl', 'systemd-analyze', 'tar', 'npm', 'ss']);
  const ref = artifactRef(o.artifact, 'api');
  const sha = checkArtifact(host, ref, p) ?? '';
  if (host.stat(o.releaseTool)?.kind !== 'file') p.errors.push(`не знайдено server-release.js (${o.releaseTool}): запускайте інсталятор із переданого server-bundle`);
  checkBase(host, API.base, p);
  checkNotOtherRelease(host, API.base, ref.revision, p);
  serviceAccountPreflight(host, API.user, p);
  const pending = loadPending(host, 'server', [RESTART, DAEMON_RELOAD], p);

  const configExists = host.stat(API.config) !== null;
  const existing = configExists ? parseEnvText(host.readFile(API.config)) : {};
  let dbHost = existing.DB_HOST;
  let dbPort = existing.DB_PORT;
  if (!configExists) {
    if (!o.dbEnv) p.errors.push(`${API.config} ще немає: потрібен --db-env з DB_* (див. docs/INSTALLATION.md, «База даних»)`);
    else {
      const problems = secretFileProblems(host, o.dbEnv);
      p.errors.push(...problems);
      if (problems.length === 0) {
        const env = parseEnvText(host.readFile(o.dbEnv));
        const missing = DB_KEYS.filter((k) => !env[k]);
        if (missing.length > 0) p.errors.push(`--db-env: немає ${missing.join(', ')}`);
        const unsafe = DB_KEYS.filter((k) => env[k] && !PLAIN_VALUE.test(env[k]));
        if (unsafe.length > 0) p.errors.push(`--db-env: значення ${unsafe.join(', ')} містять недопустимі символи (лише A-Z a-z 0-9 _ . : -)`);
        if (env.DB_HOST && !LOOPBACK.has(env.DB_HOST)) p.warnings.push('DB_HOST не loopback: API не вмикає TLS до PostgreSQL (README, «TLS до PostgreSQL») — використовуйте локальну БД');
        dbHost = env.DB_HOST;
        dbPort = env.DB_PORT;
      }
    }
  } else {
    p.notes.push(`${API.config} існує — буде лише перевірений і доповнений відсутніми ключами`);
    if (o.dbEnv) p.warnings.push('--db-env проігноровано: api.env уже існує (credentials не змінюються)');
  }
  const needsUrl = ['AUTH_ALLOWED_ORIGINS', 'ALERTS_PUBLIC_URL'].some((k) => !(k in existing));
  if (needsUrl && !o.publicUrl) p.errors.push('потрібен --public-url (публічна https-адреса UI): у api.env немає AUTH_ALLOWED_ORIGINS/ALERTS_PUBLIC_URL');
  if (o.publicUrl && existing.AUTH_ALLOWED_ORIGINS !== undefined && existing.AUTH_ALLOWED_ORIGINS !== o.publicUrl) {
    p.warnings.push('AUTH_ALLOWED_ORIGINS в api.env відрізняється від --public-url — наявне значення НЕ змінюється');
  }
  if (dbHost && dbPort && /^\d{1,5}$/.test(dbPort)) {
    if (await host.tcpReachable(dbHost, Number(dbPort), 3000)) p.notes.push(`PostgreSQL приймає з'єднання на ${dbHost}:${dbPort} (вхід перевірить migrate.js status)`);
    else p.errors.push(`PostgreSQL недоступний на ${dbHost}:${dbPort}: перевірте systemctl status postgresql і DB_HOST/DB_PORT`);
  }
  if (systemctlState(host, 'is-active', API.unit) !== 'active') {
    const port = existing.API_PORT && /^\d+$/.test(existing.API_PORT) ? existing.API_PORT : String(API.defaultPort);
    if (host.run('ss', ['-ltnH', 'sport', '=', `:${port}`]).stdout.trim() !== '') p.errors.push(`порт ${port} уже зайнятий іншим процесом (ss -ltnp 'sport = :${port}')`);
  }
  if (o.adminEmail) {
    if (o.adminPasswordFile) p.errors.push(...secretFileProblems(host, o.adminPasswordFile));
    else if (o.mode === 'apply' && !input.isTTY) p.errors.push('--admin-email без термінала: передайте --admin-password-file (root, 600)');
  }
  if (host.stat('/etc/nginx')?.kind !== 'dir') p.warnings.push('Nginx не знайдено: UI буде недоступний ззовні, доки не налаштовано reverse proxy (nginx-config)');

  const steps: Step[] = [
    systemUser(API.user),
    prepareStep(o.releaseTool, API.base, ref, () => sha, false),
    configStep(o),
    configKeysStep(o),
    migrationsStep(ref.revision),
    unitFile(API.unit, () => `${API.base}/releases/${ref.revision}/deploy/systemd/${API.unit}`, [RESTART]),
    activateStep(o.releaseTool, API.base, ref, [RESTART]),
    service(API.unit, { restartOn: RESTART }),
    ...(o.adminEmail ? [adminStep(o, ref.revision)] : []),
  ];
  return {
    preflight: p,
    pending,
    steps,
    verify: verifyServer,
    next: [
      '\nГотово: Central API встановлено й перевірено. Далі (docs/INSTALLATION.md):',
      `  1. Nginx + TLS: node ${join('install', 'server.js')} nginx-config --server-name <домен> --certificate <crt> --certificate-key <key>`,
      '     → перевірити, зберегти, nginx -t, reload; потім повторити apply з --behind-nginx.',
      ...(o.adminEmail ? [] : ['  2. Перший адміністратор: повторіть apply з --admin-email <email> (пароль — прихований ввід).']),
      '  3. Сервери: UI → «Сервери» → «Додати сервер» → «Видати ключ»; на сервері — install/agent.js.',
    ],
  };
}

export async function serverMain(argv: readonly string[], deps: { host?: Host; out?: Reporter; input?: SecretInput; cwd?: string; releaseTool?: string } = {}): Promise<number> {
  const host = deps.host ?? realHost;
  const out = deps.out ?? consoleReporter;
  let parsed: ReturnType<typeof parseServerArgs>;
  try {
    parsed = parseServerArgs(argv, deps.cwd ?? process.cwd(), deps.releaseTool ?? defaultReleaseTool());
  } catch (error) {
    out.error(`✗ ${safeMessage(error)}\n\n${SERVER_USAGE}`);
    return EXIT.usage;
  }
  if ('help' in parsed) { out.line(SERVER_USAGE); return EXIT.ok; }
  if ('nginx' in parsed) {
    try {
      out.line(renderNginxSite(parsed.nginx));
      return EXIT.ok;
    } catch (error) {
      out.error(`✗ ${safeMessage(error)}`);
      return EXIT.usage;
    }
  }
  const options = parsed;
  return execute(host, options.mode, out, () => buildServerPlan(host, options, deps.input ?? processInput));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await serverMain(process.argv.slice(2));
}
