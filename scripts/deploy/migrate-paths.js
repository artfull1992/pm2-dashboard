#!/usr/bin/env node
// Renames the paths of an existing Node Control installation (run as root on that host, components stopped first —
// see DEPLOYMENT, "Перейменування шляхів встановлення"). Every old and new path is given explicitly by the operator.
//
//   migrate-paths.js plan     --move OLD=NEW […] [--map OLD=NEW …] [--rewrite FILE …] [--alias OLD …]   (dry run, read-only)
//   migrate-paths.js apply    (the same options) --backup-dir DIR --state FILE
//   migrate-paths.js rollback --state FILE
//   migrate-paths.js finalize --state FILE        (removes the temporary aliases once nothing uses the old paths)
//
// --rewrite FILE: a config file (given at its NEW location) whose path references to the moved paths are rewritten;
// its original is saved to --backup-dir. --map OLD=NEW: a reference-only rename for --rewrite (nothing is moved),
// e.g. a systemd RuntimeDirectory under /run. Never prints configuration values — only key names.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { applyMigration, finalizeMigration, MigrationError, parseMoves, planMigration, rollbackMigration } from './lib/path-migration.js';

export function runCli(argv, { log = console.log } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      move: { type: 'string', multiple: true, default: [] },
      map: { type: 'string', multiple: true, default: [] },
      rewrite: { type: 'string', multiple: true, default: [] },
      alias: { type: 'string', multiple: true, default: [] },
      'backup-dir': { type: 'string' },
      state: { type: 'string' },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new MigrationError(`unexpected arguments: ${extra.join(' ')}`);
  const need = (key) => {
    if (!values[key]) throw new MigrationError(`--${key} is required for ${command}`);
    return values[key];
  };
  const spec = () => {
    const moves = parseMoves(values.move);
    const maps = values.map.length > 0 ? parseMoves(values.map) : [];
    const overlap = maps.find((m) => moves.some((x) => x.from === m.from || x.to === m.to));
    if (overlap) throw new MigrationError(`--map ${overlap.from} duplicates a --move`);
    return { moves, maps, rewrites: values.rewrite, aliases: values.alias };
  };

  switch (command) {
    case 'plan': {
      const steps = planMigration(spec());
      for (const s of steps) {
        const what = s.type === 'move' ? `${s.from} → ${s.to}` : s.type === 'rewrite' ? `${s.file} (keys: ${s.keys.join(', ') || '—'})` : `${s.path} → ${s.target}`;
        log(`${s.state === 'done' ? '=' : '+'} ${s.type} ${what}${s.state === 'done' ? ' (already done)' : ''}`);
      }
      log(`plan: ${String(steps.filter((s) => s.state === 'pending').length)} pending, ${String(steps.filter((s) => s.state === 'done').length)} already done; nothing changed`);
      return steps;
    }
    case 'apply': {
      const state = applyMigration({ ...spec(), backupDir: need('backup-dir'), stateFile: need('state'), log });
      log(`applied; state: ${values.state ?? ''}`);
      return state;
    }
    case 'rollback': return rollbackMigration({ stateFile: need('state'), log });
    case 'finalize': return finalizeMigration({ stateFile: need('state'), log });
    default: throw new MigrationError('usage: migrate-paths.js plan|apply|rollback|finalize …');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[migrate-paths] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    console.error('[migrate-paths] if `apply` failed part-way: run `rollback --state <file>` (completed steps are journaled).');
    process.exit(1);
  }
}
