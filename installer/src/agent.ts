#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT, execute, type Plan, platformPreflight } from './cli.js';
import { consoleReporter, type Context, mustRun, type Preflight, type Reporter, safeMessage, type Step, systemctlState } from './engine.js';
import { appendMissing, missingKeys, parseEnvText, renderEnv } from './envfile.js';
import { type Host, realHost } from './host.js';
import { activateStep, checkArtifact, checkBase, checkNotOtherRelease, checkUnits, defaultReleaseTool, prepareStep } from './release.js';
import { DAEMON_RELOAD, directory, exactFile, membership, service, serviceAccountPreflight, systemGroup, systemUser, unitFile } from './resources.js';
import { loadPending } from './state.js';
import { processInput, type SecretInput, secretFileProblems, singleLine } from './secrets.js';
import { artifactRef, filePath, httpsOrigin, InputError, linuxName, safeAbsolutePath } from './validate.js';

// Agent installer for a managed server that already runs PM2 applications. Installs Node Control only: no pm2
// command is ever executed (even `pm2 --version` may start a daemon), PM2 processes, PM2_HOME and PM2 startup are not
// touched. Capabilities are explicit: heartbeat always; PM2 inventory only with --pm2-owner/--pm2-home; control and
// logs only with --enable-control, and even then with an EMPTY allowlist that the operator fills in.

export const AGENT = Object.freeze({
  user: 'nodecontrol-agent',
  base: '/opt/node-control-agent',
  configDir: '/etc/node-control-agent',
  config: '/etc/node-control-agent/agent.env',
  unit: 'node-control-agent.service',
  inventoryGroup: 'nc-pm2-inventory',
  snapshotDir: '/var/lib/node-control-pm2',
  snapshotFile: '/var/lib/node-control-pm2/inventory.json',
  exporterConfigDir: '/etc/node-control-pm2-exporter',
  controlGroup: 'nc-pm2-control',
  brokerConfigDir: '/etc/node-control-pm2-broker',
  brokerSocket: '/run/node-control-pm2-broker/broker.sock',
});
export const TOKEN_RE = /^ncag_[A-Za-z0-9_-]{43}$/;
const RESTART = 'restart-agent';

export const AGENT_USAGE = `Node Control — встановлення Agent на сервер із PM2-застосунками (Ubuntu + systemd, Node.js 22).
PM2 і застосунки не змінюються й не перезапускаються; жодна команда pm2 не виконується.

Використання (root, з каталогу переданого server-bundle):
  node install/agent.js plan  --artifact <node-control-agent-<sha>.tar.gz> --api-url <https-origin> [параметри]
  node install/agent.js apply --artifact <node-control-agent-<sha>.tar.gz> --api-url <https-origin> [параметри]
Параметри:
  --api-url <https-origin>    адреса Node Control, напр. https://control.example.com
  --token-file <файл>         ключ Agent із UI (root, 600); або --token-stdin; інакше — прихований ввід
  --token-stdin               прочитати ключ зі stdin (для автоматизації)
  --pm2-owner <user>          Linux-користувач, від якого працює PM2 (не root) — вмикає inventory
  --pm2-home <шлях>           абсолютний PM2_HOME цього користувача, напр. /home/deploy/.pm2
  --enable-control            встановити broker з ПОРОЖНІМ allowlist (керування й логи — лише після його заповнення)
  -h, --help                  ця довідка
Ключ потрібен лише для першого створення agent.env; наявний файл не перезаписується (ротація — docs/INSTALLATION.md).
Докладно: docs/INSTALLATION.md.`;

export interface AgentOptions {
  mode: 'plan' | 'apply';
  artifact: string;
  apiUrl: string | null;
  tokenFile: string | null;
  tokenStdin: boolean;
  pm2: { owner: string; home: string } | null;
  enableControl: boolean;
  releaseTool: string;
}

export function parseAgentArgs(argv: readonly string[], cwd: string, releaseTool = defaultReleaseTool()): AgentOptions | { help: true } {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true, strict: true,
    options: {
      artifact: { type: 'string' }, 'api-url': { type: 'string' }, 'token-file': { type: 'string' },
      'token-stdin': { type: 'boolean', default: false }, 'pm2-owner': { type: 'string' }, 'pm2-home': { type: 'string' },
      'enable-control': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') return { help: true };
  if (rest.length > 0) throw new InputError(`зайві аргументи: ${rest.join(' ')}`);
  if (command !== 'plan' && command !== 'apply') throw new InputError('команда: plan або apply (--help — довідка)');
  if (values['token-file'] !== undefined && values['token-stdin']) throw new InputError('вкажіть лише одне: --token-file або --token-stdin');
  const owner = values['pm2-owner'];
  const home = values['pm2-home'];
  if ((owner === undefined) !== (home === undefined)) throw new InputError('--pm2-owner і --pm2-home задаються разом');
  if (values['enable-control'] && owner === undefined) throw new InputError('--enable-control потребує --pm2-owner і --pm2-home');
  return {
    mode: command,
    artifact: filePath(values.artifact, '--artifact', cwd),
    apiUrl: values['api-url'] === undefined ? null : httpsOrigin(values['api-url'], '--api-url'),
    tokenFile: values['token-file'] === undefined ? null : filePath(values['token-file'], '--token-file', cwd),
    tokenStdin: values['token-stdin'],
    pm2: owner === undefined ? null : { owner: linuxName(owner, '--pm2-owner'), home: safeAbsolutePath(home, '--pm2-home') },
    enableControl: values['enable-control'],
    releaseTool,
  };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function extraKeys(o: AgentOptions): [string, string][] {
  return [
    ...(o.pm2 ? [['NC_AGENT_INVENTORY_FILE', AGENT.snapshotFile] as [string, string]] : []),
    ...(o.enableControl ? [['NC_AGENT_CONTROL_SOCKET', AGENT.brokerSocket] as [string, string]] : []),
  ];
}

function agentEnvStep(o: AgentOptions, token: () => string | null): Step {
  return {
    id: 'config:agent-env',
    title: `конфігурація ${AGENT.config} (адреса API + ключ)`,
    check({ host }) {
      const info = host.stat(AGENT.config);
      if (!info) return { state: 'pending', detail: '600 nodecontrol-agent, атомарний запис; ключ не виводиться' };
      const user = host.user(AGENT.user);
      if (info.kind !== 'file' || info.mode !== 0o600 || (user && info.uid !== user.uid)) {
        return { state: 'conflict', detail: `${AGENT.config} має бути файлом 600 ${AGENT.user}`, fix: `chown ${AGENT.user}:${AGENT.user} ${AGENT.config}; chmod 600 ${AGENT.config} — і повторіть` };
      }
      return { state: 'done', detail: 'наявний файл збережено без змін' };
    },
    apply({ host }) {
      const value = token();
      const user = host.user(AGENT.user);
      if (!value || !o.apiUrl || !user) throw new Error('немає ключа, адреси API або користувача');
      const text = renderEnv([['NC_AGENT_API_URL', o.apiUrl], ['NC_AGENT_TOKEN', value], ...extraKeys(o)], '# Node Control Agent — created by install/agent.js. Secret: keep 600.');
      host.writeFileAtomic(AGENT.config, text, { mode: 0o600, uid: user.uid, gid: user.gid });
    },
    effects: [RESTART],
    recovery: `перевірте каталог ${AGENT.configDir}; повторний запуск створить файл, якщо його немає`,
  };
}

function agentEnvKeysStep(o: AgentOptions): Step {
  return {
    id: 'config:agent-keys',
    title: 'можливості Agent в agent.env (лише відсутні ключі)',
    check({ host }) {
      const keys = extraKeys(o).map(([k]) => k);
      const missing = host.stat(AGENT.config) ? missingKeys(host.readFile(AGENT.config), keys) : [];
      return missing.length === 0 ? { state: 'done' } : { state: 'pending', detail: `додати: ${missing.join(', ')} (резервна копія agent.env.bak-<час>, 600)` };
    },
    apply({ host }) {
      const text = host.readFile(AGENT.config);
      const user = host.user(AGENT.user);
      if (!user) throw new Error(`немає користувача ${AGENT.user}`);
      const owner = { mode: 0o600, uid: user.uid, gid: user.gid };
      host.writeFileAtomic(`${AGENT.config}.bak-${stamp(host.now())}`, text, owner);
      host.writeFileAtomic(AGENT.config, appendMissing(text, extraKeys(o)).text, owner);
    },
    effects: [RESTART],
    recovery: `попередній вміст — у ${AGENT.config}.bak-<час>; повторіть`,
  };
}

/** One exporter run (snapshot before the Agent reads it), then the timer. PM2 itself is only read by the exporter. */
function exporterStep(owner: string): Step {
  const timer = `node-control-pm2-exporter@${owner}.timer`;
  const once = `node-control-pm2-exporter@${owner}.service`;
  return {
    id: `exporter:${owner}`,
    title: `PM2 inventory exporter для ${owner} (таймер 30 с)`,
    check({ host }) {
      const enabled = systemctlState(host, 'is-enabled', timer) === 'enabled';
      const active = systemctlState(host, 'is-active', timer) === 'active';
      return enabled && active ? { state: 'done', detail: 'таймер активний' } : { state: 'pending', detail: `systemctl start ${once} (один пробний запуск) → enable --now ${timer}` };
    },
    apply({ host }) {
      mustRun(host, 'systemctl', ['start', once], `пробний запуск ${once}`);
      mustRun(host, 'systemctl', ['enable', '--now', timer], `systemctl enable --now ${timer}`);
    },
    recovery: `journalctl -u ${once} -n 20 -o cat: exit 2 — конфігурація (PM2_HOME, власник), інакше причина в журналі; PM2 не змінювався`,
  };
}

/** Root-owned allowlist; created EMPTY once and never rewritten (the operator owns its content). */
function allowlistStep(owner: string): Step {
  const path = `${AGENT.brokerConfigDir}/${owner}.allowlist.json`;
  return {
    id: `allowlist:${owner}`,
    title: `allowlist broker ${path}`,
    check({ host }) {
      const info = host.stat(path);
      if (!info) return { state: 'pending', detail: 'порожній ({"version":1,"targets":[]}) root:root 644 — broker відхилятиме все, доки ви не додасте цілі' };
      if (info.kind !== 'file' || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        return { state: 'conflict', detail: `${path} має належати root і не бути доступним на запис іншим`, fix: `chown root:root ${path}; chmod 644 ${path}` };
      }
      return { state: 'done', detail: 'наявний allowlist не змінюється' };
    },
    apply({ host }) { host.writeFileAtomic(path, '{"version":1,"targets":[]}\n', { mode: 0o644, uid: 0, gid: 0 }); },
    recovery: `перевірте каталог ${AGENT.brokerConfigDir} і повторіть`,
  };
}

const field = (line: string, name: string) => new RegExp(`"${name}":"([a-z_]+)"`).exec(line)?.[1] ?? null;

/** InvocationID of the running Agent process (systemd: a new one for every start/restart); null if not running. */
function currentInvocation(host: Host): string | null {
  const r = host.run('systemctl', ['show', '--property=InvocationID', '--value', AGENT.unit]);
  const id = r.stdout.trim();
  return r.code === 0 && /^[0-9a-zA-Z_-]{1,64}$/.test(id) ? id : null;
}

/** Bounds of one journal read (the Agent writes short JSON lines; its journal per run is normally kilobytes). */
export const JOURNAL_LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 64 * 1024 * 1024, maxLineChars: 8 * 1024 });

interface RunEvidence { heartbeat: string | null; inventory: { outcome: string | null; state: string | null } | null }

/**
 * The journal of ONE Agent run (by its InvocationID), streamed: only the outcome of the LAST heartbeat line and of the
 * last inventory line are kept — never the raw text. Memory: one line (≤ maxLineChars) + two short values; time:
 * timeoutMs, then the child is killed. No match → nulls (not "accepted"). An error/timeout/limit is reported as such.
 */
async function journalOf(host: Host, invocation: string): Promise<RunEvidence | 'error' | 'timeout' | 'limit'> {
  const evidence: RunEvidence = { heartbeat: null, inventory: null };
  const result = await host.scan('journalctl', [`_SYSTEMD_INVOCATION_ID=${invocation}`, '-o', 'cat', '--no-pager', '-q'], {
    ...JOURNAL_LIMITS,
    onLine(text) {
      if (text.includes('"msg":"heartbeat"')) evidence.heartbeat = field(text, 'outcome');
      else if (text.includes('"msg":"inventory"')) evidence.inventory = { outcome: field(text, 'outcome'), state: field(text, 'state') };
    },
  });
  if (result.status === 'exit') return result.code === 0 ? evidence : 'error';
  return result.status;
}

/**
 * The connection is confirmed only by the CURRENT run of the Agent: the last heartbeat outcome logged by the process
 * with the current InvocationID. The Agent logs every change of outcome, so that line is its present state; records of
 * earlier runs (another key or configuration) never count. A run started by this apply has no record yet → bounded
 * wait (15 × 5 s). If the run changes meanwhile (crash + systemd restart), the evidence is discarded and the new run
 * is awaited. "active" alone is never a confirmation.
 */
export async function verifyAgent(ctx: Context, o: AgentOptions): Promise<boolean> {
  const { host, out } = ctx;
  out.line('\nПеревірка результату:');
  const active = systemctlState(host, 'is-active', AGENT.unit) === 'active';
  out.line(active ? `  ✓ служба ${AGENT.unit} запущена` : `  ✗ служба ${AGENT.unit} не запущена (journalctl -u ${AGENT.unit} -n 20 -o cat; exit 2 — конфігурація)`);
  if (!active) return false;
  let invocation = currentInvocation(host);
  let outcome: string | null = null;
  let evidence: RunEvidence = { heartbeat: null, inventory: null };
  const failure: Record<string, string> = {
    error: 'не вдалося прочитати журнал Agent (journalctl)',
    timeout: `читання журналу Agent не завершилось за ${String(JOURNAL_LIMITS.timeoutMs / 1000)} с`,
    limit: `журнал поточного запуску Agent більший за ${String(JOURNAL_LIMITS.maxBytes / 1024 / 1024)} MiB`,
  };
  for (let i = 0; i < 15 && outcome === null; i++) {
    const now = currentInvocation(host);
    if (now === null) { out.error(`  ✗ Agent зупинився під час перевірки (journalctl -u ${AGENT.unit} -n 20 -o cat)`); return false; }
    if (now !== invocation) { out.line('  ! Agent перезапустився під час перевірки — чекаємо звіт нового запуску'); invocation = now; }
    const read = await journalOf(host, now);
    if (typeof read === 'string') { out.error(`  ✗ ${failure[read] ?? read}: зв'язок не підтверджено (journalctl -u ${AGENT.unit} -n 20 -o cat)`); return false; }
    if (currentInvocation(host) !== now) continue; // the run changed while reading: its records do not count
    evidence = read;
    outcome = read.heartbeat;
    if (outcome === null) await host.sleep(5000);
  }
  const advice: Record<string, string> = {
    unauthorized: 'API відхилив ключ: перевірте, що його видано саме для цього сервера й не відкликано; новий ключ — UI «Видати новий ключ», далі ротація за docs/INSTALLATION.md',
    network: 'немає з\'єднання з API (DNS/TLS/мережа): перевірте --api-url, вихідний HTTPS і сертифікат',
    timeout: 'API не відповів вчасно: перевірте мережу й стан API',
    unavailable: 'API відповів помилкою 5xx: перевірте node-control-api на центральному сервері',
  };
  if (outcome === 'accepted') out.line('  ✓ зв\'язок Agent підтверджено: поточний запуск Agent отримав підтвердження heartbeat від API');
  else if (outcome === null) out.error(`  ✗ зв'язок Agent НЕ підтверджено: поточний запуск не звітував про heartbeat за 75 с (journalctl -u ${AGENT.unit} -n 20 -o cat)`);
  else out.error(`  ✗ зв'язок Agent НЕ підтверджено (${outcome}): ${advice[outcome] ?? `journalctl -u ${AGENT.unit} -n 20 -o cat`}`);
  if (o.pm2) {
    const inv = evidence.inventory;
    const snapshot = host.stat(AGENT.snapshotFile);
    out.line(snapshot ? '  ✓ snapshot PM2 inventory створено exporter-ом' : `  ! snapshot ще не створено (journalctl -u node-control-pm2-exporter@${o.pm2.owner} -n 5 -o cat)`);
    out.line(inv ? `  ${inv.outcome === 'accepted' ? '✓' : '!'} inventory: ${inv.outcome ?? '?'}, стан ${inv.state ?? '?'}` : '  ! inventory поточного запуску ще не надсилався (перший звіт — протягом хвилини)');
  }
  return outcome === 'accepted';
}

export async function buildAgentPlan(host: Host, o: AgentOptions, input: SecretInput): Promise<Plan> {
  const p: Preflight = { errors: [], warnings: [], notes: [] };
  platformPreflight(host, p, ['useradd', 'groupadd', 'usermod', 'systemctl', 'systemd-analyze', 'tar', 'journalctl']);
  const ref = artifactRef(o.artifact, 'agent');
  const sha = checkArtifact(host, ref, p) ?? '';
  if (host.stat(o.releaseTool)?.kind !== 'file') p.errors.push(`не знайдено server-release.js (${o.releaseTool}): запускайте інсталятор із переданого server-bundle`);
  checkBase(host, AGENT.base, p);
  checkNotOtherRelease(host, AGENT.base, ref.revision, p);
  if (sha) {
    checkUnits(host, ref, [
      AGENT.unit,
      ...(o.pm2 ? ['node-control-pm2-exporter@.service', 'node-control-pm2-exporter@.timer'] : []),
      ...(o.pm2 && o.enableControl ? ['node-control-pm2-broker@.service'] : []),
    ], p);
  }
  serviceAccountPreflight(host, AGENT.user, p);
  const pending = loadPending(host, 'agent', [RESTART, DAEMON_RELOAD], p);

  // Configuration and the key: needed only to create agent.env; an existing file is never rewritten.
  const envExists = host.stat(AGENT.config) !== null;
  const existing = envExists ? parseEnvText(host.readFile(AGENT.config)) : {};
  let token: string | null = null;
  if (!envExists) {
    if (!o.apiUrl) p.errors.push('потрібен --api-url (agent.env ще немає)');
    try {
      if (o.tokenFile) {
        const problems = secretFileProblems(host, o.tokenFile);
        p.errors.push(...problems);
        if (problems.length === 0) token = singleLine(host.readFile(o.tokenFile), '--token-file');
      } else if (o.tokenStdin) token = singleLine(await input.readAll(), '--token-stdin');
      else if (o.mode === 'apply') {
        if (input.isTTY) token = singleLine(await input.hidden('Ключ Agent (не відображається): '), 'ключ');
        else p.errors.push('немає термінала для введення ключа: --token-file (root, 600) або --token-stdin');
      } else p.notes.push('ключ буде запитано приховано під час apply (або --token-file / --token-stdin)');
    } catch (error) {
      p.errors.push(safeMessage(error));
    }
    if (token !== null && !TOKEN_RE.test(token)) p.errors.push('ключ має неправильний формат (очікується ncag_… з UI «Видати ключ»); значення не виводиться');
  } else {
    p.notes.push(`${AGENT.config} існує — ключ і адреса не змінюються`);
    if (o.tokenFile || o.tokenStdin) p.warnings.push('ключ проігноровано: agent.env уже існує (ротація — docs/INSTALLATION.md)');
    if (o.apiUrl && existing.NC_AGENT_API_URL !== o.apiUrl) p.warnings.push('NC_AGENT_API_URL в agent.env відрізняється від --api-url — наявне значення НЕ змінюється');
  }

  // The API: TLS + reachable + answers like Node Control (GET /api/auth/me without a session → 401). Read-only.
  const api = existing.NC_AGENT_API_URL ?? o.apiUrl;
  if (api) {
    const status = await host.httpStatus(`${api}/api/auth/me`, 10_000);
    if (status === 401) p.notes.push(`API ${api} доступний через HTTPS (сертифікат перевірено)`);
    else if (status === null) p.errors.push(`API ${api} недоступний: DNS, мережа, вихідний HTTPS або недовірений TLS-сертифікат`);
    else p.warnings.push(`API ${api} відповів ${String(status)} замість 401 — переконайтеся, що це адреса Node Control`);
  }

  if (o.pm2) {
    const { owner, home } = o.pm2;
    const user = host.user(owner);
    const homeInfo = host.stat(home);
    if (!user) p.errors.push(`користувача ${owner} немає`);
    else if (user.uid === 0) p.errors.push('PM2 від root не підтримується');
    if (homeInfo?.kind !== 'dir') p.errors.push(`PM2_HOME ${home} не існує або не каталог`);
    else if (user && homeInfo.uid !== user.uid) p.errors.push(`PM2_HOME ${home} не належить ${owner}`);
    if (homeInfo?.kind === 'dir') {
      if (host.stat(`${home}/rpc.sock`)?.kind === 'socket') p.notes.push(`PM2 daemon ${owner} працює (rpc.sock є); pm2-команди не виконуються`);
      else p.warnings.push(`PM2 daemon ${owner} зараз не працює (немає ${home}/rpc.sock): exporter звітуватиме «unavailable», PM2 не запускається`);
    }
    if (user) {
      const primary = host.run('id', ['-gn', owner]).stdout.trim();
      if (primary !== '' && host.groupsOf(AGENT.user).includes(primary)) p.errors.push(`${AGENT.user} входить до основної групи ${owner} (${primary}) — це дало б доступ до rpc.sock; приберіть членство`);
    }
    const snap = host.stat(AGENT.snapshotDir);
    if (snap && user && snap.uid !== user.uid) p.errors.push(`${AGENT.snapshotDir} належить іншому користувачу: один сервер — один власник PM2 для inventory`);
  } else p.notes.push('PM2 inventory не вмикається (немає --pm2-owner/--pm2-home)');
  if (!o.enableControl) p.notes.push('керування й логи не вмикаються (немає --enable-control)');

  const rel = (unit: string) => () => `${AGENT.base}/releases/${ref.revision}/deploy/systemd/${unit}`;
  const steps: Step[] = [
    systemUser(AGENT.user),
    directory(AGENT.base, { mode: 0o755, user: 'root', group: 'root' }),
    prepareStep(o.releaseTool, AGENT.base, ref, () => sha, true),
    activateStep(o.releaseTool, AGENT.base, ref, [RESTART]),
    directory(AGENT.configDir, { mode: 0o750, user: 'root', group: AGENT.user }),
    agentEnvStep(o, () => token),
    agentEnvKeysStep(o),
    unitFile(AGENT.unit, rel(AGENT.unit), [RESTART]),
  ];
  if (o.pm2) {
    const { owner, home } = o.pm2;
    steps.push(
      systemGroup(AGENT.inventoryGroup),
      membership(AGENT.user, AGENT.inventoryGroup, [RESTART]),
      directory(AGENT.snapshotDir, { mode: 0o2750, user: owner, group: AGENT.inventoryGroup }),
      directory(AGENT.exporterConfigDir, { mode: 0o755, user: 'root', group: 'root' }),
      exactFile(`${AGENT.exporterConfigDir}/${owner}.env`, () => renderEnv([['NC_PM2_HOME', home], ['NC_PM2_SNAPSHOT_FILE', AGENT.snapshotFile], ['NC_PM2_SOURCE', 'pm2']]),
        { mode: 0o644, user: 'root', group: 'root' }, `конфігурація exporter ${owner}.env`),
      unitFile('node-control-pm2-exporter@.service', rel('node-control-pm2-exporter@.service')),
      unitFile('node-control-pm2-exporter@.timer', rel('node-control-pm2-exporter@.timer')),
      exporterStep(owner),
    );
  }
  if (o.pm2 && o.enableControl) {
    const { owner, home } = o.pm2;
    steps.push(
      systemGroup(AGENT.controlGroup),
      directory(AGENT.brokerConfigDir, { mode: 0o755, user: 'root', group: 'root' }),
      exactFile(`${AGENT.brokerConfigDir}/${owner}.env`, () => renderEnv([['NC_PM2_HOME', home], ['NC_BROKER_ALLOWLIST', `${AGENT.brokerConfigDir}/${owner}.allowlist.json`]]),
        { mode: 0o644, user: 'root', group: 'root' }, `конфігурація broker ${owner}.env`),
      allowlistStep(owner),
      unitFile('node-control-pm2-broker@.service', rel('node-control-pm2-broker@.service')),
      service(`node-control-pm2-broker@${owner}.service`, { title: `broker для ${owner}` }),
      membership(AGENT.user, AGENT.controlGroup, [RESTART]),
    );
  }
  steps.push(service(AGENT.unit, { restartOn: RESTART }));

  const next = ['\nГотово: Agent встановлено, зв\'язок з API підтверджено. PM2-процеси не змінювались.'];
  if (o.pm2 && o.enableControl) {
    next.push(
      'Керування й логи ще ВИМКНЕНІ: allowlist порожній. Щоб дозволити конкретні процеси (docs/INSTALLATION.md, «Керування й логи»):',
      `  1. Fingerprint: runuser -u ${o.pm2.owner} -- env NC_PM2_HOME=${o.pm2.home} NC_BROKER_ALLOWLIST=${AGENT.brokerConfigDir}/${o.pm2.owner}.allowlist.json /usr/bin/node ${AGENT.base}/current/agent/dist/pm2-broker.js fingerprint`,
      `  2. Додати лише потрібні цілі в ${AGENT.brokerConfigDir}/${o.pm2.owner}.allowlist.json (root, 644); "logs": true — окремо й лише за погодженням.`,
      '  3. На центральному сервері: PM2_CONTROL_ENABLED=true (install/server.js apply … --enable-pm2-control).',
    );
  }
  return { preflight: p, pending, steps, verify: (ctx) => verifyAgent(ctx, o), next };
}

export async function agentMain(argv: readonly string[], deps: { host?: Host; out?: Reporter; input?: SecretInput; cwd?: string; releaseTool?: string } = {}): Promise<number> {
  const host = deps.host ?? realHost;
  const out = deps.out ?? consoleReporter;
  let parsed: ReturnType<typeof parseAgentArgs>;
  try {
    parsed = parseAgentArgs(argv, deps.cwd ?? process.cwd(), deps.releaseTool ?? defaultReleaseTool());
  } catch (error) {
    out.error(`✗ ${safeMessage(error)}\n\n${AGENT_USAGE}`);
    return EXIT.usage;
  }
  if ('help' in parsed) { out.line(AGENT_USAGE); return EXIT.ok; }
  const options = parsed;
  return execute(host, options.mode, out, () => buildAgentPlan(host, options, deps.input ?? processInput));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await agentMain(process.argv.slice(2));
}
