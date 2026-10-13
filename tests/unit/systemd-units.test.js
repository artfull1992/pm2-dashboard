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
  assert.ok(lines.includes('ExecStart=/usr/bin/node /opt/goit-node-control-agent/current/agent/dist/pm2-exporter.js'));
});

test('exporter service keeps its hardening: no network, no privileges, writes only the snapshot directory', () => {
  const lines = directives(unit('node-control-pm2-exporter@.service'));
  for (const required of [
    'RestrictAddressFamilies=AF_UNIX', 'IPAddressDeny=any', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'ReadWritePaths=/var/lib/goit-node-control-pm2',
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
    'User=%i', 'Group=nc-pm2-control', 'RuntimeDirectory=goit-node-control-pm2-broker', 'RuntimeDirectoryMode=0750',
    'StateDirectory=goit-node-control-pm2-broker', 'StateDirectoryMode=0700', 'RestartPreventExitStatus=2',
    'RestrictAddressFamilies=AF_UNIX', 'IPAddressDeny=any', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'MemoryMax=128M', 'TasksMax=32',
    'ExecStart=/usr/bin/node /opt/goit-node-control-agent/current/agent/dist/pm2-broker.js serve',
  ]) assert.ok(lines.includes(required), required);
  assert.equal(lines.some((l) => /^(ReadWritePaths|AmbientCapabilities=\S|SupplementaryGroups)/.test(l)), false);
});
