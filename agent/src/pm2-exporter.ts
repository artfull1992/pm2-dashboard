// Entry point: node agent/dist/pm2-exporter.js — one inventory run (systemd timer, as the PM2 owner; ADR-016).
// Config only from the environment (NC_PM2_*; no secrets). Exit codes: 0 snapshot written (state ok OR unavailable);
// 2 invalid configuration; 1 the snapshot could not be written. Logs are metadata only.
import { SnapshotFileError } from './inventory/snapshot-file.js';
import { ExporterConfigError, loadExporterConfig, runExporter } from './pm2/exporter.js';

const log = (level: 'info' | 'warn' | 'error', event: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), component: 'pm2-exporter', ...event })}\n`);
};

try {
  const config = loadExporterConfig(process.env);
  const { snapshot, durationMs } = await runExporter(config);
  const event = { msg: 'inventory exported', source: snapshot.source, state: snapshot.state, reason: snapshot.reason, processCount: snapshot.processes.length, durationMs };
  if (snapshot.state === 'ok') log('info', event);
  else log('warn', event);
} catch (error) {
  if (error instanceof ExporterConfigError) {
    log('error', { msg: 'invalid configuration', issues: error.issues });
    process.exitCode = 2;
  } else {
    log('error', { msg: 'snapshot write failed', reason: error instanceof SnapshotFileError ? error.reason : (error as NodeJS.ErrnoException | null)?.code ?? 'unknown' });
    process.exitCode = 1;
  }
}
