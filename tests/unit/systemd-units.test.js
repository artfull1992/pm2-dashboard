import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Static regression checks for the shipped systemd units (Task 008.1). The runtime behaviour (the service really runs
// as the instance user and @root is refused) is verified on a server; see PROJECT_STATUS.

const ROOT = join(import.meta.dirname, '..', '..');
const unit = (name) => readFileSync(join(ROOT, 'deploy', 'systemd', name), 'utf8');
const directives = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('exporter service: runs as the instance user, no manager-level ConditionUser (it would skip every instance)', () => {
  const lines = directives(unit('node-control-pm2-exporter@.service'));
  assert.equal(lines.some((l) => l.startsWith('ConditionUser=')), false);
  assert.equal(lines.some((l) => l.startsWith('Condition')), false);
  assert.ok(lines.includes('User=%i'));
  assert.ok(lines.includes('Type=oneshot'));
  assert.ok(lines.includes('ExecStart=/opt/node-control-runtime/bin/node /opt/node-control-agent/current/agent/dist/pm2-exporter.js'));
});

test('exporter service keeps its hardening: no network, no privileges, writes only the snapshot directory', () => {
  const lines = directives(unit('node-control-pm2-exporter@.service'));
  for (const required of [
    'RestrictAddressFamilies=AF_UNIX', 'IPAddressDeny=any', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'ReadWritePaths=/var/lib/node-control-pm2',
  ]) assert.ok(lines.includes(required), required);
  assert.equal(lines.some((l) => /^(AmbientCapabilities|CapabilityBoundingSet)=\S/.test(l)), false);
});

test('exporter timer triggers the same instance', () => {
  const lines = directives(unit('node-control-pm2-exporter@.timer'));
  assert.ok(lines.includes('Unit=node-control-pm2-exporter@%i.service'));
  assert.ok(lines.includes('OnUnitActiveSec=30s'));
});

test('broker service: instance user, dedicated group, socket/state dirs, no condition, no network, bounded', () => {
  const lines = directives(unit('node-control-pm2-broker@.service'));
  assert.equal(lines.some((l) => l.startsWith('Condition')), false);
  for (const required of [
    'User=%i', 'Group=nc-pm2-control', 'RuntimeDirectory=node-control-pm2-broker', 'RuntimeDirectoryMode=0750',
    'StateDirectory=node-control-pm2-broker', 'StateDirectoryMode=0700', 'RestartPreventExitStatus=2',
    'RestrictAddressFamilies=AF_UNIX', 'IPAddressDeny=any', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'MemoryMax=128M', 'TasksMax=32',
    'ExecStart=/opt/node-control-runtime/bin/node /opt/node-control-agent/current/agent/dist/pm2-broker.js serve',
  ]) assert.ok(lines.includes(required), required);
  assert.equal(lines.some((l) => /^(ReadWritePaths|AmbientCapabilities=\S|SupplementaryGroups)/.test(l)), false);
});

test('every Node.js unit runs the Node Control runtime by its absolute path, never /usr/bin/node or PATH (ADR-027)', () => {
  for (const name of ['node-control-api.service', 'node-control-agent.service', 'node-control-pm2-exporter@.service', 'node-control-pm2-broker@.service']) {
    const exec = directives(unit(name)).filter((l) => l.startsWith('ExecStart='));
    assert.equal(exec.length, 1, name);
    assert.match(exec[0], /^ExecStart=\/opt\/node-control-runtime\/bin\/node (--use-system-ca )?\/opt\/node-control(-agent)?\/current\//, name);
  }
});

test('API and Agent (outbound TLS) trust the system CA store with any runtime build (official Node.js uses its bundled CAs otherwise)', () => {
  for (const name of ['node-control-api.service', 'node-control-agent.service']) {
    assert.ok(directives(unit(name)).some((l) => l.startsWith('ExecStart=/opt/node-control-runtime/bin/node --use-system-ca ')), name);
  }
});
