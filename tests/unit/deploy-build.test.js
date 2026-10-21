import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AGENT_ARTIFACT_PATHS, ARTIFACT_PATHS, assertBundleClean, BUNDLE_MANIFEST, resolveDeployableRevision, stageArtifact, stageServerBundle, writeBundleManifest } from '../../scripts/deploy/build-release.js';
import { listFiles, sha256File } from '../../scripts/deploy/lib/manifest.js';

const SHA = 'c'.repeat(40);
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fakeGit({ status = '', sha = SHA, pushed = true } = {}) {
  const calls = [];
  const runGit = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return status;
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'merge-base') { if (!pushed) throw new Error('not ancestor'); return ''; }
    throw new Error(`unexpected git ${args[0]}`);
  };
  return { runGit, calls };
}

test('resolveDeployableRevision returns the full SHA of a clean, pushed commit', () => {
  const { runGit, calls } = fakeGit();
  assert.equal(resolveDeployableRevision({ revision: 'HEAD', remoteBranch: 'origin/main', runGit }), SHA);
  assert.deepEqual(calls, ['status --porcelain', 'rev-parse --verify HEAD^{commit}', `merge-base --is-ancestor ${SHA} origin/main`]);
});

test('refuses a dirty working tree', () => {
  assert.throws(() => resolveDeployableRevision({ runGit: fakeGit({ status: ' M backend/src/app.ts' }).runGit }), /not clean/);
});

test('refuses a commit that is not on the remote branch', () => {
  assert.throws(() => resolveDeployableRevision({ runGit: fakeGit({ pushed: false }).runGit }), /push it first/);
});

test('refuses a non-SHA rev-parse result', () => {
  assert.throws(() => resolveDeployableRevision({ runGit: fakeGit({ sha: 'deadbeef' }).runGit }), TypeError);
});

test('stageArtifact copies only runtime files: no sources, tests, maps, .env or node_modules', () => {
  const src = mkdtempSync(join(tmpdir(), 'nc-src-'));
  const stage = mkdtempSync(join(tmpdir(), 'nc-stage-'));
  dirs.push(src, stage);
  const files = {
    'package.json': '{}', 'package-lock.json': '{}', '.env': 'DB_PASS=x', '.env.example': 'x',
    'backend/dist/main.js': '', 'backend/dist/main.js.map': '', 'backend/dist/migrate.js': '', 'backend/src/main.ts': '', 'backend/test/a.test.ts': '',
    'backend/migrations/1791900000000_create-users.sql': '', 'backend/test/fixtures/migrations-failing/1791900000001_broken.sql': '',
    'deploy/systemd/node-control-api.service': '', 'scripts/deploy/server-release.js': '', 'scripts/deploy/migrate-paths.js': '',
    'deploy/nginx/site.conf': '', 'frontend/dist/index.html': '<html>', 'frontend/dist/assets/index-abc.js': '',
    'frontend/dist/assets/index-abc.js.map': '', 'frontend/src/main.tsx': '', 'frontend/test/app.test.tsx': '', 'e2e/tests/auth.spec.ts': '',
    'scripts/deploy/lib/manifest.js': '', 'scripts/setup-postgres.js': '', 'node_modules/pg/index.js': '',
    'installer/dist/server.js': '', 'installer/dist/agent.js': '', 'installer/dist/server.js.map': '', 'installer/package.json': '{}',
    'installer/src/server.ts': '', 'installer/test/server.test.ts': '',
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(src, file, '..'), { recursive: true });
    writeFileSync(join(src, file), content);
  }
  stageArtifact(src, stage);
  assert.deepEqual(listFiles(stage), [
    'backend/dist/main.js',
    'backend/dist/migrate.js',
    'backend/migrations/1791900000000_create-users.sql',
    'deploy/systemd/node-control-api.service',
    'frontend/dist/assets/index-abc.js',
    'frontend/dist/index.html',
    'installer/dist/agent.js',
    'installer/dist/server.js',
    'installer/package.json',
    'package-lock.json',
    'package.json',
    'scripts/deploy/lib/manifest.js',
    'scripts/deploy/migrate-paths.js',
    'scripts/deploy/server-release.js',
  ]);
});

test('stageArtifact fails when a required input is missing', () => {
  const src = mkdtempSync(join(tmpdir(), 'nc-src-'));
  dirs.push(src);
  assert.ok(ARTIFACT_PATHS.includes('backend/dist'));
  assert.throws(() => stageArtifact(src, join(src, 'stage')), /artifact input missing: package.json/);
});

function bundle(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-dist-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries({ 'index.html': '<!doctype html>', ...files })) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

test('assertBundleClean accepts a plain UI bundle', () => {
  assert.doesNotThrow(() => assertBundleClean(bundle({ 'assets/index-1.js': 'fetch("/api/auth/me")' })));
});

test('assertBundleClean rejects source maps, server config names and secret shapes', () => {
  for (const [file, content] of [
    ['assets/a.js.map', '{}'],
    ['assets/a.js', 'const x = "DB_' + 'PASS"'],
    ['assets/a.js', 'postgres' + '://u:p@h/db'],
    ['assets/a.js', 'node_control_' + 'user'],
    ['assets/a.js', 'SCRAM-SHA-256' + '$4096:abc'],
    ['assets/a.js', '/etc/node-control/api.env'],
  ]) {
    assert.throws(() => assertBundleClean(bundle({ [file]: content })), /frontend bundle rejected/, file + content);
  }
  const empty = mkdtempSync(join(tmpdir(), 'nc-dist-'));
  dirs.push(empty);
  assert.throws(() => assertBundleClean(empty), /no index.html/);
});

test('agent artifact contains only the compiled agent, its package.json, unit and release tooling', () => {
  const src = mkdtempSync(join(tmpdir(), 'nc-src-'));
  const stage = mkdtempSync(join(tmpdir(), 'nc-agent-stage-'));
  dirs.push(src, stage);
  const files = {
    'agent/dist/main.js': '', 'agent/dist/main.js.map': '', 'agent/src/main.ts': '', 'agent/test/agent.test.ts': '', 'agent/package.json': '{}',
    'agent/.env': 'NC_AGENT_TOKEN=x', 'deploy/systemd/node-control-agent.service': '', 'deploy/systemd/node-control-api.service': '',
    'deploy/systemd/node-control-pm2-exporter@.service': '', 'deploy/systemd/node-control-pm2-exporter@.timer': '',
    'deploy/systemd/node-control-pm2-broker@.service': '',
    'scripts/deploy/server-release.js': '', 'scripts/deploy/migrate-paths.js': '', 'scripts/deploy/lib/manifest.js': '', 'backend/dist/main.js': '', 'frontend/dist/index.html': '',
    'installer/dist/agent.js': '', 'installer/package.json': '{}', 'installer/src/agent.ts': '',
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(src, file, '..'), { recursive: true });
    writeFileSync(join(src, file), content);
  }
  stageArtifact(src, stage, AGENT_ARTIFACT_PATHS);
  assert.deepEqual(listFiles(stage), [
    'agent/dist/main.js',
    'agent/package.json',
    'deploy/systemd/node-control-agent.service',
    'deploy/systemd/node-control-pm2-broker@.service',
    'deploy/systemd/node-control-pm2-exporter@.service',
    'deploy/systemd/node-control-pm2-exporter@.timer',
    'installer/dist/agent.js',
    'installer/package.json',
    'scripts/deploy/lib/manifest.js',
    'scripts/deploy/migrate-paths.js',
    'scripts/deploy/server-release.js',
  ]);
});

test('server-bundle: release tooling at the top, installers in install/ with their package.json (ESM)', () => {
  const stage = mkdtempSync(join(tmpdir(), 'nc-stage-'));
  const out = mkdtempSync(join(tmpdir(), 'nc-bundle-'));
  dirs.push(stage, out);
  for (const file of ['scripts/deploy/server-release.js', 'scripts/deploy/lib/manifest.js', 'installer/dist/server.js', 'installer/dist/agent.js', 'installer/package.json']) {
    mkdirSync(join(stage, file, '..'), { recursive: true });
    writeFileSync(join(stage, file), file.endsWith('package.json') ? '{"type":"module"}' : '');
  }
  stageServerBundle(stage, join(out, 'server-bundle'));
  assert.deepEqual(listFiles(join(out, 'server-bundle')), ['install/agent.js', 'install/package.json', 'install/server.js', 'lib/manifest.js', 'server-release.js']);
});

test('server-bundle/BUNDLE.json: the revision and the SHA-256 of every bundle file (the wizard refuses anything else)', () => {
  const stage = mkdtempSync(join(tmpdir(), 'nc-stage-'));
  const out = mkdtempSync(join(tmpdir(), 'nc-bundle-'));
  dirs.push(stage, out);
  for (const file of ['scripts/deploy/server-release.js', 'scripts/deploy/lib/manifest.js', 'installer/dist/wizard.js', 'installer/dist/server.js', 'installer/package.json']) {
    mkdirSync(join(stage, file, '..'), { recursive: true });
    writeFileSync(join(stage, file), file);
  }
  const bundle = join(out, 'server-bundle');
  stageServerBundle(stage, bundle);
  writeBundleManifest(bundle, SHA);
  const manifest = JSON.parse(readFileSync(join(bundle, BUNDLE_MANIFEST), 'utf8'));
  assert.equal(manifest.revision, SHA);
  assert.deepEqual(Object.keys(manifest.files).sort(), listFiles(bundle).filter((f) => f !== BUNDLE_MANIFEST));
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(hash, sha256File(join(bundle, file)));
  assert.throws(() => writeBundleManifest(bundle, 'HEAD'), TypeError);
});
