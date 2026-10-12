import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ARTIFACT_PATHS, assertBundleClean, resolveDeployableRevision, stageArtifact } from '../../scripts/deploy/build-release.js';
import { listFiles } from '../../scripts/deploy/lib/manifest.js';

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
    'deploy/systemd/node-control-api.service': '', 'scripts/deploy/server-release.js': '',
    'deploy/nginx/goit-node-control-loopback.conf': '', 'frontend/dist/index.html': '<html>', 'frontend/dist/assets/index-abc.js': '',
    'frontend/dist/assets/index-abc.js.map': '', 'frontend/src/main.tsx': '', 'frontend/test/app.test.tsx': '', 'e2e/tests/auth.spec.ts': '',
    'scripts/deploy/lib/manifest.js': '', 'scripts/setup-postgres.js': '', 'node_modules/pg/index.js': '',
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
    'deploy/nginx/goit-node-control-loopback.conf',
    'deploy/systemd/node-control-api.service',
    'frontend/dist/assets/index-abc.js',
    'frontend/dist/index.html',
    'package-lock.json',
    'package.json',
    'scripts/deploy/lib/manifest.js',
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
    ['assets/a.js', '/etc/goit-node-control/api.env'],
  ]) {
    assert.throws(() => assertBundleClean(bundle({ [file]: content })), /frontend bundle rejected/, file + content);
  }
  const empty = mkdtempSync(join(tmpdir(), 'nc-dist-'));
  dirs.push(empty);
  assert.throws(() => assertBundleClean(empty), /no index.html/);
});
