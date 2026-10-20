import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT, AGENT_USAGE } from '../src/agent.js';
import { API, SERVER_USAGE } from '../src/server.js';
import { STATE_DIR } from '../src/state.js';

// Code ↔ Docs: every option of the installers is documented in docs/INSTALLATION.md, and every installer command
// line in that document uses only options the code accepts; documented paths are the ones the code uses.

const DOC = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'INSTALLATION.md'), 'utf8');
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

  it('no private addresses in examples: only example domains', () => {
    const urls = [...DOC.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1] ?? '');
    for (const host of urls) expect(host, host).toMatch(/(^|\.)example\.(com|org)$/);
    expect(DOC).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)(?<!0\.0\.0\.0)/);
  });
});
