// Entry point: node agent/dist/pm2-broker.js [serve|fingerprint] — local PM2 control broker (ADR-017), runs as the
// PM2 owner under systemd (node-control-pm2-broker@<owner>.service). Config from the environment (NC_PM2_HOME,
// NC_BROKER_*; no secrets). Exit codes: 0 stopped; 2 invalid configuration; 1 unexpected error.
//   fingerprint — prints pm_id, name, exec_mode and the definition fingerprint of each process of the EXISTING
//                 daemon (no paths/args/env), for the operator to write the root-owned allowlist.
import { BrokerConfigError, createBroker, listenBroker, loadBrokerConfig, realDeps, verifiedLogDirs } from './control/broker.js';
import { fingerprintOf, viewOf } from './control/identity.js';
import { sanitizeName } from './pm2/sanitize.js';

const log = (level: 'info' | 'warn' | 'error', event: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), component: 'pm2-broker', ...event })}\n`);
};

const mode = process.argv[2] ?? 'serve';

try {
  const config = loadBrokerConfig(process.env);
  const deps = realDeps(config);
  if (mode === 'fingerprint') {
    const raw = await deps.list();
    for (const view of raw.map(viewOf)) {
      if (!view) continue;
      process.stdout.write(`${JSON.stringify({
        pmId: view.pmId, name: sanitizeName(view.name), execMode: typeof view.env.exec_mode === 'string' ? view.env.exec_mode : null,
        instances: typeof view.env.instances === 'number' ? view.env.instances : null, fingerprint: fingerprintOf(view),
      })}\n`);
    }
  } else if (mode === 'serve') {
    if (config.allowSelfOwnedAllowlist) log('warn', { msg: 'NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST is set: test mode only' });
    await deps.journal.verify();
    const logDirs = await verifiedLogDirs(config.logDirs);
    deps.logDirs = logDirs;
    const pruned = await deps.journal.prune();
    const { server, idle } = createBroker(deps, { info: (e) => { log('info', e); }, warn: (e) => { log('warn', e); } });
    await listenBroker(server, config.socketPath);
    log('info', { msg: 'broker started', pruned, logDirs: logDirs.length });
    const prune = setInterval(() => { void deps.journal.prune().catch(() => undefined); }, 3600_000);
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          log('info', { msg: 'shutdown requested', signal });
          clearInterval(prune);
          server.close();
          // Let the running PM2 action finish (bounded) so its result reaches the journal.
          void Promise.race([idle(), new Promise((r) => setTimeout(r, 30_000))]).then(() => { resolve(); });
        });
      }
    });
    log('info', { msg: 'broker stopped' });
  } else {
    log('error', { msg: 'unknown mode' });
    process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof BrokerConfigError) {
    log('error', { msg: 'invalid configuration', issues: error.issues });
    process.exitCode = 2;
  } else {
    log('error', { msg: 'unexpected error', name: error instanceof Error ? error.name : 'unknown' });
    process.exitCode = 1;
  }
}
