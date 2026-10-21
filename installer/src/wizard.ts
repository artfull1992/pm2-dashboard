#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT, agentMain, TOKEN_RE } from './agent.js';
import { verifyRelease, type ReleaseInfo } from './bundle.js';
import { consoleReporter, type Reporter } from './engine.js';
import { type Host, realHost } from './host.js';
import { findPm2Daemons, type Pm2Daemon } from './pm2-detect.js';
import { processInput, type SecretInput, secretFileProblems } from './secrets.js';
import { API, serverMain } from './server.js';
import { email, httpsOrigin, linuxName, safeAbsolutePath } from './validate.js';

// Guided first installation (Central Server or Agent) on top of the existing installers: it only COLLECTS answers,
// shows them (never secrets), runs the existing `plan`, and — after an explicit "так" — the existing `apply` with the
// same arguments. Nothing on the system changes before that confirmation; all checks, steps, pending state, secrets
// handling and recovery are the installers' own. Runs only from the server-bundle of a prepared release.

export const WIZARD_EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, cancelled: 130 });

export const WIZARD_USAGE = `Node Control — майстер первинного встановлення (Central Server або Agent).

Запуск (root, у терміналі):
  sudo ./install.sh [--release <каталог підготовленого релізу>]     з checkout репозиторію
  sudo node <реліз>/server-bundle/install/wizard.js --release <реліз>    без checkout (лише підготовлений реліз)
Майстер питає параметри, показує їх (без секретів), виконує план (нічого не змінює) і лише після «так» — встановлення.
Без термінала (автоматизація) — неінтерактивні інсталятори: <реліз>/server-bundle/install/server.js | agent.js plan|apply.
Докладно: docs/INSTALLATION.md.`;

/** Terminal I/O of the wizard. `null` = the operator ended the input (EOF / Ctrl+C): the wizard cancels. */
export interface Prompter {
  readonly isTTY: boolean;
  ask(question: string): Promise<string | null>;
  hidden(question: string): Promise<string | null>;
}

export const terminalPrompter: Prompter = {
  isTTY: process.stdin.isTTY && process.stdout.isTTY,
  ask(question) {
    return new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      let answered = false;
      rl.on('SIGINT', () => { rl.close(); });
      rl.on('close', () => { if (!answered) { process.stdout.write('\n'); done(null); } });
      rl.question(question, (answer) => { answered = true; rl.close(); done(answer); });
    });
  },
  async hidden(question) {
    try {
      return await processInput.hidden(question);
    } catch {
      return null;
    }
  },
};

class Cancelled extends Error {}

interface Ctx { host: Host; out: Reporter; p: Prompter; env: Readonly<Record<string, string | undefined>> }

const YES = new Set(['так', 'т', 'yes', 'y']);
const NO = new Set(['ні', 'н', 'no', 'n']);

async function ask(c: Ctx, question: string): Promise<string> {
  const answer = await c.p.ask(question);
  if (answer === null) throw new Cancelled();
  return answer.trim();
}

/** Re-asks until `parse` accepts the answer; Enter takes `fallback` when there is one. */
async function askValid<T>(c: Ctx, question: string, parse: (value: string) => T, fallback?: string): Promise<T> {
  for (;;) {
    const raw = await ask(c, question);
    const value = raw === '' && fallback !== undefined ? fallback : raw;
    try {
      return parse(value);
    } catch (error) {
      c.out.line(`  ✗ ${error instanceof Error ? error.message : String(error)} — спробуйте ще раз (Ctrl+C — скасувати)`);
    }
  }
}

async function yesNo(c: Ctx, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const a = (await ask(c, `${question} [${fallback ? 'ТАК/ні' : 'так/НІ'}]: `)).toLowerCase();
    if (a === '') return fallback;
    if (YES.has(a)) return true;
    if (NO.has(a)) return false;
    c.out.line('  відповідь: так або ні');
  }
}

async function menu(c: Ctx, title: string, options: readonly string[]): Promise<number> {
  c.out.line(title);
  options.forEach((o, i) => { c.out.line(`  ${String(i + 1)}) ${o}`); });
  c.out.line('  0) Скасувати');
  const n = await askValid(c, 'Ваш вибір: ', (v) => {
    if (!/^\d+$/.test(v) || Number(v) > options.length) throw new Error(`введіть число від 0 до ${String(options.length)}`);
    return Number(v);
  });
  if (n === 0) throw new Cancelled();
  return n - 1;
}

interface Collected { component: 'server' | 'agent'; args: string[]; summary: [string, string][]; input: SecretInput }

async function collectServer(c: Ctx, release: ReleaseInfo): Promise<Collected> {
  const artifact = release.api ?? '';
  const args = ['--artifact', artifact];
  const summary: [string, string][] = [['Компонент', 'Central Server (API + UI)'], ['Артефакт', artifact]];
  const configExists = c.host.stat(API.config) !== null;
  if (configExists) {
    c.out.line(`\n${API.config} уже існує: credentials і наявні значення не змінюються (доповнюються лише відсутні ключі).`);
    summary.push(['Конфігурація', `${API.config} — наявна, збережена`]);
  } else {
    c.out.line('\nPostgreSQL має бути підготовлений заздалегідь (docs/INSTALLATION.md, «База даних»): майстер не створює БД, ролей і не змінює pg_hba.');
    const dbEnv = await askValid(c, 'Файл із DB_* (root, 600), наприклад /root/node-control-install/db.env: ', (v) => {
      const path = resolve(v);
      const problems = v === '' ? ['потрібен шлях'] : secretFileProblems(c.host, path);
      if (problems.length > 0) throw new Error(problems.join('; '));
      return path;
    });
    args.push('--db-env', dbEnv);
    summary.push(['DB credentials', `${dbEnv} (вміст не показується)`]);
  }
  const url = await askValid(c, configExists ? 'Публічна HTTPS-адреса UI (Enter — лишити наявну): ' : 'Публічна HTTPS-адреса UI, наприклад https://control.example.com: ', (v) => {
    if (v === '' && configExists) return null;
    return httpsOrigin(v, 'адреса');
  });
  if (url) { args.push('--public-url', url); summary.push(['Публічна адреса', url]); }
  const admin = await askValid(c, 'Email першого адміністратора (Enter — пропустити; пароль запитає bootstrap під час встановлення): ', (v) => (v === '' ? null : email(v, 'email')));
  if (admin) { args.push('--admin-email', admin); summary.push(['Перший адміністратор', `${admin} (пароль — прихований ввід під час встановлення)`]); }
  c.out.line('\nAPI_TRUSTED_PROXIES=127.0.0.1 вмикайте лише коли Nginx уже проксіює за шаблоном nginx-config (він замінює клієнтський X-Forwarded-For).');
  if (await yesNo(c, 'Nginx уже налаштовано за цим шаблоном (--behind-nginx)?', false)) { args.push('--behind-nginx'); summary.push(['Довіра до proxy', 'так (API_TRUSTED_PROXIES=127.0.0.1)']); }
  if (await yesNo(c, 'Увімкнути керування PM2 на рівні API (--enable-pm2-control)? На серверах потрібні ще broker і allowlist', false)) {
    args.push('--enable-pm2-control');
    summary.push(['Керування PM2 (API)', 'так']);
  }
  return { component: 'server', args, summary, input: processInput };
}

/** PM2 owner + PM2_HOME: a detected daemon (confirmed) or a manual entry; never a silent choice. */
async function choosePm2(c: Ctx): Promise<{ owner: string; home: string }> {
  const daemons = findPm2Daemons(c.host);
  const usable = (d: Pm2Daemon) => d.uid !== 0 && d.owner !== null && (() => { try { safeAbsolutePath(d.pm2Home, 'PM2_HOME'); return true; } catch { return false; } })();
  if (daemons.length === 0) c.out.line('\nПрацюючих PM2 daemon не знайдено (перевірено лише назви процесів; жодна команда pm2 не запускалась).');
  else {
    c.out.line('\nЗнайдені працюючі PM2 daemon (за назвою процесу «God Daemon»):');
    for (const d of daemons) {
      const why = d.uid === 0 ? ' — від root: не підтримується (Node Control працює лише з non-root власником PM2; процеси не переносяться автоматично)'
        : d.owner === null ? ' — UID без облікового запису: не підтримується' : usable(d) ? '' : ' — PM2_HOME з недопустимими символами: вкажіть вручну';
      c.out.line(`  - ${d.owner ?? `uid ${String(d.uid)}`}: PM2_HOME ${d.pm2Home} (pid ${String(d.pid)})${why}`);
    }
  }
  const candidates = daemons.filter(usable);
  const options = [...candidates.map((d) => `власник ${d.owner ?? ''}, PM2_HOME ${d.pm2Home}`), 'Вказати власника й PM2_HOME вручну'];
  const pick = await menu(c, '\nЧий PM2 підключити?', options);
  const chosen = candidates[pick];
  if (chosen?.owner) return { owner: chosen.owner, home: chosen.pm2Home };

  const hint = c.env.SUDO_USER && c.env.SUDO_USER !== 'root' && c.host.user(c.env.SUDO_USER) ? c.env.SUDO_USER : undefined;
  const owner = await askValid(c, `Linux-користувач, від якого працює PM2${hint ? ` (Enter — ${hint}, користувач, що запустив sudo; це лише підказка)` : ''}: `, (v) => {
    const name = linuxName(v, 'власник PM2');
    const user = c.host.user(name);
    if (!user) throw new Error(`користувача ${name} немає`);
    if (user.uid === 0) throw new Error('PM2 від root не підтримується');
    return name;
  }, hint);
  const home = c.host.user(owner)?.home ?? '';
  const suggested = home.startsWith('/') ? `${home.replace(/\/$/, '')}/.pm2` : undefined;
  const pm2Home = await askValid(c, `PM2_HOME цього користувача — абсолютний шлях${suggested ? ` (Enter — ${suggested}: типове місце, НЕ перевірений факт)` : ''}: `,
    (v) => safeAbsolutePath(v, 'PM2_HOME'), suggested);
  return { owner, home: pm2Home };
}

async function collectAgent(c: Ctx, release: ReleaseInfo): Promise<Collected> {
  const artifact = release.agent ?? '';
  const args = ['--artifact', artifact];
  const summary: [string, string][] = [['Компонент', 'Agent'], ['Артефакт', artifact]];
  let token: string | null = null;
  if (c.host.stat(AGENT.config) !== null) {
    c.out.line(`\n${AGENT.config} уже існує: адреса API і ключ зберігаються без змін (ротація ключа — docs/INSTALLATION.md).`);
    summary.push(['Конфігурація', `${AGENT.config} — наявна, збережена`]);
  } else {
    const url = await askValid(c, '\nHTTPS-адреса Node Control, наприклад https://control.example.com: ', (v) => httpsOrigin(v, 'адреса'));
    args.push('--api-url', url);
    summary.push(['Адреса API', url]);
    for (;;) {
      const key = await c.p.hidden('Ключ Agent з UI «Видати ключ» (не відображається): ');
      if (key === null) throw new Cancelled();
      if (TOKEN_RE.test(key.trim())) { token = key.trim(); break; }
      c.out.line('  ✗ неправильний формат ключа (очікується ncag_…); значення не показується — спробуйте ще раз');
    }
    args.push('--token-stdin');
    summary.push(['Ключ Agent', 'введено (приховано)']);
  }
  const mode = await menu(c, '\nМожливості Agent:', [
    'лише heartbeat (сервер онлайн, load average)',
    'heartbeat + список PM2-процесів (inventory)',
    'heartbeat + inventory + broker для керування й логів (allowlist порожня — нічого не дозволено, доки ви її не заповните)',
  ]);
  if (mode >= 1) {
    const pm2 = await choosePm2(c);
    if (!(await yesNo(c, `Підключити PM2 власника ${pm2.owner} з PM2_HOME ${pm2.home}?`, false))) throw new Cancelled();
    args.push('--pm2-owner', pm2.owner, '--pm2-home', pm2.home);
    summary.push(['Власник PM2', pm2.owner], ['PM2_HOME', pm2.home]);
  }
  if (mode === 2) { args.push('--enable-control'); summary.push(['Broker', 'так, з порожньою allowlist']); }
  const secret = token;
  const input: SecretInput = {
    isTTY: true,
    readAll: () => Promise.resolve(secret === null ? '' : `${secret}\n`),
    hidden: () => Promise.reject(new Error('ключ уже введено')),
  };
  return { component: 'agent', args, summary, input };
}

export interface WizardDeps {
  host?: Host;
  out?: Reporter;
  prompter?: Prompter;
  env?: Readonly<Record<string, string | undefined>>;
  /** server-bundle the wizard runs from (default: two levels above this file). */
  bundleDir?: string;
  /** Runners of the existing installers (injected in tests). */
  server?: typeof serverMain;
  agent?: typeof agentMain;
}

export async function wizardMain(argv: readonly string[], deps: WizardDeps = {}): Promise<number> {
  const host = deps.host ?? realHost;
  const out = deps.out ?? consoleReporter;
  const p = deps.prompter ?? terminalPrompter;
  const c: Ctx = { host, out, p, env: deps.env ?? process.env };
  let releaseArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '-h' || a === '--help') { out.line(WIZARD_USAGE); return WIZARD_EXIT.ok; }
    if (a === '--release' && i + 1 < argv.length) { releaseArg = argv[++i]; continue; }
    if (a.startsWith('--release=')) { releaseArg = a.slice('--release='.length); continue; }
    out.error(`✗ невідомий параметр: ${a}\n\n${WIZARD_USAGE}`);
    return WIZARD_EXIT.usage;
  }
  if (!releaseArg) { out.error(`✗ потрібен --release <каталог підготовленого релізу>\n\n${WIZARD_USAGE}`); return WIZARD_EXIT.usage; }
  if (!p.isTTY) {
    out.error('✗ Майстер працює лише в терміналі. Для автоматизації — неінтерактивні інсталятори (docs/INSTALLATION.md):\n'
      + `  node ${join(releaseArg, 'server-bundle', 'install', 'server.js')} plan|apply …\n  node ${join(releaseArg, 'server-bundle', 'install', 'agent.js')} plan|apply …`);
    return WIZARD_EXIT.usage;
  }
  // Read-only check first: a damaged, mixed or foreign release is reported before anything else.
  const bundleDir = deps.bundleDir ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const checked = verifyRelease(host, releaseArg, bundleDir);
  if (!checked.ok) {
    out.error('✗ Підготовлений реліз не пройшов перевірку (нічого не змінено):');
    for (const e of checked.errors) out.error(`  - ${e}`);
    return WIZARD_EXIT.failed;
  }
  if (host.euid() !== 0) { out.error('✗ потрібен root: sudo ./install.sh (або запуск від root)'); return WIZARD_EXIT.failed; }
  const release = checked.release;
  out.line(`Node Control — майстер встановлення. Реліз ${release.revision.slice(0, 12)} (${release.dir}).`);
  out.line('До вашого підтвердження система не змінюється. Ctrl+C або «0» — скасувати.\n');

  let applying = false;
  try {
    const component = await menu(c, 'Що встановлюємо на цьому сервері?', [
      `Central Server — API + веб-інтерфейс${release.api ? '' : ' (немає артефакту API в цьому релізі)'}`,
      `Agent — сервер із PM2-застосунками${release.agent ? '' : ' (немає артефакту Agent в цьому релізі)'}`,
    ]);
    if ((component === 0 && !release.api) || (component === 1 && !release.agent)) {
      out.error('✗ у цьому релізі немає потрібного артефакту — підготуйте повний реліз (docs/INSTALLATION.md)');
      return WIZARD_EXIT.failed;
    }
    const collected = component === 0 ? await collectServer(c, release) : await collectAgent(c, release);
    out.line('\nПараметри (секрети не показуються):');
    for (const [k, v] of collected.summary) out.line(`  ${k}: ${v}`);

    const run = collected.component === 'server' ? (deps.server ?? serverMain) : (deps.agent ?? agentMain);
    const common = { host, out, input: collected.input, releaseTool: join(release.bundle, 'server-release.js') };
    out.line('\n— План (перевірки, нічого не змінюється) —');
    const planned = await run(['plan', ...collected.args], common);
    if (planned !== 0) {
      out.error('\nПлан має блокувальні проблеми (див. вище). Нічого не змінено. Усуньте їх і запустіть майстер ще раз.');
      return planned;
    }
    const confirm = (await ask(c, '\nВиконати встановлення за цим планом? Введіть «так», щоб продовжити: ')).toLowerCase();
    if (confirm !== 'так' && confirm !== 'yes') { // a full word, not a stray "y"
      out.line('Скасовано. Нічого не змінено.');
      return WIZARD_EXIT.cancelled;
    }
    out.line('\n— Встановлення —');
    applying = true; // from here on, changes may already have been made: never report "nothing changed"
    const applied = await run(['apply', ...collected.args], common);
    if (applied !== 0) {
      out.error('\nВстановлення не завершене. Усуньте причину (див. вище) і запустіть майстер ще раз з тими самими відповідями — виконані кроки буде пропущено, незавершені reload/restart доведено.');
    }
    return applied;
  } catch (error) {
    if (!applying && error instanceof Cancelled) { out.line('\nСкасовано. Нічого не змінено.'); return WIZARD_EXIT.cancelled; }
    if (applying) {
      out.error('\nВстановлення перервано під час виконання: частину змін могло бути вже застосовано. Запустіть майстер ще раз з тими самими відповідями — виконані кроки буде пропущено (docs/INSTALLATION.md, розділ 4).');
      return WIZARD_EXIT.failed;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await wizardMain(process.argv.slice(2));
}
