#!/usr/bin/env node
// Server-side release tool for GOIT Node Control API. Run as root on the server, from the transferred release bundle.
//
//   server-release.js prepare  --artifact <tgz> --sha256 <hex> --revision <sha> [--no-install]   (--no-install: agent artifact, no npm deps)
//   server-release.js config   [--legacy-env /etc/pm2-dashboard/.env] [--owner nodecontrol]
//   server-release.js activate --revision <sha>
//   server-release.js rollback
//   server-release.js status
// Common: [--base /opt/goit-node-control] [--config /etc/goit-node-control/api.env]
// Never prints configuration values.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  activateRelease, ensureApiConfig, prepareRelease, releaseStatus, rollbackRelease,
} from './lib/release-dir.js';

export const DEFAULTS = Object.freeze({
  base: '/opt/goit-node-control',
  config: '/etc/goit-node-control/api.env',
  legacyEnv: '/etc/pm2-dashboard/.env',
  owner: 'nodecontrol',
});

function userIds(user) {
  const id = (flag) => {
    const result = spawnSync('id', [flag, user], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`unknown user: ${user}`);
    return Number(result.stdout.trim());
  };
  return { uid: id('-u'), gid: id('-g') };
}

export function runCli(argv, { log = console.log } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string', default: DEFAULTS.base },
      config: { type: 'string', default: DEFAULTS.config },
      'legacy-env': { type: 'string', default: DEFAULTS.legacyEnv },
      owner: { type: 'string', default: DEFAULTS.owner },
      artifact: { type: 'string' },
      sha256: { type: 'string' },
      revision: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new Error(`unexpected arguments: ${extra.join(' ')}`);
  const need = (key) => {
    if (!values[key]) throw new Error(`--${key} is required for ${command}`);
    return values[key];
  };

  switch (command) {
    case 'prepare': {
      const result = prepareRelease({
        base: values.base, artifact: need('artifact'), artifactSha256: need('sha256'), revision: need('revision'),
        ...(values['no-install'] ? { install: () => undefined } : {}),
      });
      log(`[release] ${result.status}: ${result.dir}`);
      return result;
    }
    case 'config': {
      const result = ensureApiConfig({ configFile: values.config, legacyEnvFile: values['legacy-env'], ...userIds(values.owner) });
      log(`[release] config ${result.status}: ${values.config}`);
      if (result.errors.length > 0) throw new Error(`config invalid: ${result.errors.join('; ')}`);
      return result;
    }
    case 'activate': {
      const result = activateRelease({ base: values.base, revision: need('revision') });
      log(`[release] ${result.status}; previous=${result.previous ?? 'none'}`);
      return result;
    }
    case 'rollback': {
      const result = rollbackRelease({ base: values.base });
      log(`[release] rolled back ${result.from ?? 'none'} → ${result.to}`);
      return result;
    }
    case 'status': {
      const result = releaseStatus(values.base);
      log(`[release] current=${result.current ?? 'none'} previous=${result.previous ?? 'none'}`);
      return result;
    }
    default:
      throw new Error('command must be one of: prepare, config, activate, rollback, status');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[release] ERROR: ${error.message}`);
    process.exit(1);
  }
}
