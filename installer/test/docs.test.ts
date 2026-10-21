import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT, AGENT_USAGE } from '../src/agent.js';
import { API, SERVER_USAGE } from '../src/server.js';
import { RUNTIME } from '../src/runtime.js';
import { STATE_DIR } from '../src/state.js';
import { BUILDER, PATHS } from '../bootstrap/prepare.js';

// Code ↔ Docs: every option of the installers is documented in docs/INSTALLATION.md, and every installer command
// line in that document uses only options the code accepts; documented paths are the ones the code uses.

const ROOT = join(import.meta.dirname, '..', '..');
const DOC = readFileSync(join(ROOT, 'docs', 'INSTALLATION.md'), 'utf8');
const flags = (text: string) => new Set([...text.matchAll(/--[a-z][a-z0-9-]+/g)].map((m) => m[0]));

/** Installer invocations in the document, with backslash continuations joined. */
function commands(script: 'server' | 'agent'): string[] {
  const joined = DOC.replace(/\\\n\s*/g, ' ');
  return [...joined.matchAll(new RegExp(`install/${script}\\.js[^\\n]*`, 'g'))].map((m) => m[0]);
}

describe('docs/INSTALLATION.md matches the installers', () => {
  it.each([['server', SERVER_USAGE], ['agent', AGENT_USAGE]] as const)('%s: every option is documented; documented commands use known options only', (script, usage) => {
    const known = flags(usage);
    known.add('--help');
    for (const flag of known) expect(DOC, flag).toContain(flag);
    const used = commands(script);
    expect(used.length).toBeGreaterThan(0);
    for (const line of used) for (const flag of flags(line.split('#')[0] ?? '')) expect(known.has(flag), `${line}: ${flag}`).toBe(true);
  });

  it('documented paths and accounts are the ones the installers use', () => {
    for (const value of [API.user, API.base, API.config, API.unit, AGENT.user, AGENT.base, AGENT.config, AGENT.unit, AGENT.snapshotDir, AGENT.inventoryGroup, AGENT.controlGroup, AGENT.brokerConfigDir, STATE_DIR, `${STATE_DIR}/server.json`]) {
      expect(DOC, value).toContain(value);
    }
  });

  it('the main route matches install.sh, the bootstrap and the runtime (paths, options, versions)', () => {
    const launcher = readFileSync(join(ROOT, 'install.sh'), 'utf8');
    expect(/^RUNTIME_DIR=(\S+)$/m.exec(launcher)?.[1]).toBe(RUNTIME.dir);
    const spec = readFileSync(join(ROOT, 'installer', 'bootstrap', 'node-runtime.env'), 'utf8');
    const value = (key: string) => new RegExp(`^${key}=(\\S+)$`, 'm').exec(spec)?.[1] ?? '';
    for (const v of [
      'git clone <URL репозиторію> node-control\ncd node-control\n./install.sh', 'sudo ./install.sh', './install.sh --help', '--release', '--component', '--node-archive',
      'BUNDLE.json', 'server-bundle/install/wizard.js', 'installer/bootstrap/node-runtime.env', RUNTIME.node, `${RUNTIME.dir}/versions/`,
      PATHS.store, PATHS.logs, PATHS.builderHome, BUILDER, value('NODE_MIN'), value('NODE_VERSION'), '--ignore-scripts', '--engine-strict',
    ]) expect(DOC, v).toContain(v);
    // every option of install.sh --help is documented
    for (const flag of flags(/usage\(\) \{[\s\S]*?\nEOF/.exec(launcher)?.[0] ?? '')) expect(DOC, flag).toContain(flag);
  });

  it('README: the main example is clone → cd → ./install.sh, with no manual npm/build step before it', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const install = readme.slice(readme.indexOf('## Встановлення'), readme.indexOf('## Постійний контекст розробки'));
    expect(install).toContain('```bash\ngit clone <URL репозиторію> node-control\ncd node-control\n./install.sh\n```');
    expect(install).not.toMatch(/^\s*npm ci|build-release\.js --out/m);
  });

  it('no private addresses in examples: only example domains', () => {
    const urls = [...DOC.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1] ?? '');
    // Example domains only — plus the two official public sources the installer downloads from.
    for (const host of urls) expect(host, host).toMatch(/(^|\.)example\.(com|org)$|^nodejs\.org$|^registry\.npmjs\.org$/);
    expect(DOC).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)(?<!0\.0\.0\.0)/);
  });
});
