import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildApiEnv, parseApiEnv, validateApiEnv } from '../../scripts/deploy/lib/api-env.js';
import { buildManifest, MANIFEST_FILE, sha256File } from '../../scripts/deploy/lib/manifest.js';
import {
  activateRelease, ensureApiConfig, ownTree, prepareRelease, releaseStatus, rollbackRelease,
} from '../../scripts/deploy/lib/release-dir.js';
import { runCli } from '../../scripts/deploy/server-release.js';
import { generatePassword } from '../../scripts/lib/password.js';

const REV1 = '1'.repeat(40);
const REV2 = '2'.repeat(40);
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Builds a real .tar.gz artifact with a manifest, like build-release.js does. */
function artifact(revision, { manifestRevision = revision, extra } = {}) {
  const stage = tmp('nc-stage-');
  mkdirSync(join(stage, 'backend/dist'), { recursive: true });
  writeFileSync(join(stage, 'backend/dist/main.js'), `// ${revision}`);
  writeFileSync(join(stage, 'package.json'), '{"name":"x"}');
  writeFileSync(join(stage, MANIFEST_FILE), JSON.stringify(buildManifest(stage, { revision: manifestRevision })));
  if (extra) writeFileSync(join(stage, extra), 'not in manifest');
  const file = join(tmp('nc-art-'), `a-${revision}.tar.gz`);
  const result = spawnSync('tar', ['-czf', file, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(result.status, 0);
  return { file, sha256: sha256File(file) };
}

const fakeInstall = (calls) => (dir) => {
  calls.push(dir);
  mkdirSync(join(dir, 'node_modules'));
};

function prepared(base, revision, calls = []) {
  const art = artifact(revision);
  return prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision, install: fakeInstall(calls) });
}

test('prepare: verifies, installs in staging, then publishes releases/<sha>', () => {
  const base = tmp('nc-base-');
  const calls = [];
  const result = prepared(base, REV1, calls);
  assert.equal(result.status, 'prepared');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\.staging-/);
  assert.ok(existsSync(join(base, 'releases', REV1, 'node_modules')));
  assert.deepEqual(readdirSync(join(base, 'releases')), [REV1]);
  assert.equal(statSync(join(base, 'releases', REV1, 'package.json')).mode & 0o022, 0, 'group/other must not write');
});

// Review 2026-10-20 (P2): server-release.js --base may name a base whose parents do not exist yet (as recursive mkdir
// allowed before the umask fix). Missing levels are created with exact modes; existing ancestors are left as they are.
for (const umask of [0o022, 0o077]) {
  test(`prepare with a nested --base whose parents are missing (umask ${umask.toString(8).padStart(3, '0')}): every new level 755`, () => {
    const art = artifact(REV1);
    const root = tmp('nc-nested-');
    const base = join(root, 'a', 'b', 'node-control'); // a/ and b/ are missing too
    const previous = process.umask(umask);
    let result;
    try {
      result = prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: fakeInstall([]) });
    } finally {
      process.umask(previous);
    }
    assert.equal(result.status, 'prepared');
    const mode = (p) => (statSync(p).mode & 0o777).toString(8);
    for (const dir of [join(root, 'a'), join(root, 'a', 'b'), base, join(base, 'releases'), join(base, 'releases', REV1)]) {
      assert.equal(mode(dir), '755', dir.slice(root.length));
    }
    // Repeated prepare: idempotent, nothing re-created.
    assert.equal(prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: () => assert.fail('no reinstall') }).status, 'already-prepared');
  });
}

test('prepare with a nested --base: an existing ancestor keeps its mode and owner; only the missing levels are created', () => {
  const art = artifact(REV1);
  const root = tmp('nc-nested-');
  const existing = join(root, 'opt');
  mkdirSync(existing, { mode: 0o700 });
  chmodSync(existing, 0o710); // deliberately unusual: must survive untouched
  const before = statSync(existing);
  const base = join(existing, 'tools', 'node-control');
  prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: fakeInstall([]) });
  const after = statSync(existing);
  assert.deepEqual([after.mode & 0o7777, after.uid, after.gid], [before.mode & 0o7777, before.uid, before.gid]);
  assert.equal(statSync(join(existing, 'tools')).mode & 0o777, 0o755);
});

test('prepare with a nested --base: a file where a directory is expected is refused, nothing overwritten', () => {
  const art = artifact(REV1);
  const root = tmp('nc-nested-');
  writeFileSync(join(root, 'opt'), 'not a directory');
  assert.throws(
    () => prepareRelease({ base: join(root, 'opt', 'node-control'), artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: fakeInstall([]) }),
    /not a directory/,
  );
  assert.equal(readFileSync(join(root, 'opt'), 'utf8'), 'not a directory');
  const fileBase = join(root, 'base-file');
  writeFileSync(fileBase, 'x');
  assert.throws(
    () => prepareRelease({ base: fileBase, artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: fakeInstall([]) }),
    /not a directory/,
  );
  assert.equal(readFileSync(fileBase, 'utf8'), 'x');
});

test('prepare under umask 077: base, releases and the whole release are readable by service users and Nginx', () => {
  const art = artifact(REV1); // built with the normal umask, like on the build machine
  const base = join(tmp('nc-opt-'), 'node-control'); // does not exist yet: prepare creates it
  const previous = process.umask(0o077);
  try {
    prepareRelease({
      base, artifact: art.file, artifactSha256: art.sha256, revision: REV1,
      // like npm ci under the operator's umask: 700 dirs, 600 files
      install: (dir) => { mkdirSync(join(dir, 'node_modules', 'pg'), { recursive: true }); writeFileSync(join(dir, 'node_modules', 'pg', 'index.js'), 'x'); },
    });
  } finally {
    process.umask(previous);
  }
  const mode = (p) => (statSync(p).mode & 0o777).toString(8);
  const release = join(base, 'releases', REV1);
  assert.deepEqual([mode(base), mode(join(base, 'releases')), mode(release)], ['755', '755', '755']);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]));
  for (const path of walk(release)) {
    const expected = statSync(path).isDirectory() ? '755' : '644';
    assert.equal(mode(path), expected, path.slice(release.length));
  }
});

test('ownTree: every entry not owned by the target (incl. symlinks, not followed) is handed over; owned ones are skipped', () => {
  const dir = tmp('nc-own-');
  mkdirSync(join(dir, 'node_modules', '@types', 'node'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@types', 'node', 'index.d.ts'), 'x');
  spawnSync('ln', ['-s', '/etc/passwd', join(dir, 'node_modules', 'link')]);
  const calls = [];
  // Target: a uid nobody here has (as root would target 0 while npm left uid 1001 behind).
  const changed = ownTree(dir, { uid: 4242, gid: 4242, lchown: (path, uid, gid) => { calls.push([path.slice(dir.length), uid, gid]); } });
  assert.equal(changed, 6);
  assert.deepEqual(calls.map(([p]) => p).sort(), ['', '/node_modules', '/node_modules/@types', '/node_modules/@types/node', '/node_modules/@types/node/index.d.ts', '/node_modules/link']);
  assert.ok(calls.every(([, uid, gid]) => uid === 4242 && gid === 4242));
  // Already owned by the target → nothing to do.
  const me = statSync(dir);
  assert.equal(ownTree(dir, { uid: me.uid, gid: me.gid, lchown: () => assert.fail('no change expected') }), 0);
});

test('prepare is idempotent: second run reuses the verified release without reinstalling', () => {
  const base = tmp('nc-base-');
  const calls = [];
  prepared(base, REV1, calls);
  assert.equal(prepared(base, REV1, calls).status, 'already-prepared');
  assert.equal(calls.length, 1);
});

test('prepare rejects bad input and checksum mismatch before extracting anything', () => {
  const base = tmp('nc-base-');
  const art = artifact(REV1);
  const install = () => assert.fail('must not install');
  assert.throws(() => prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision: 'HEAD', install }), TypeError);
  assert.throws(() => prepareRelease({ base, artifact: art.file, artifactSha256: 'abc', revision: REV1, install }), TypeError);
  assert.throws(() => prepareRelease({ base, artifact: art.file, artifactSha256: 'f'.repeat(64), revision: REV1, install }), /checksum mismatch/);
  assert.throws(() => prepareRelease({ base, artifact: join(base, 'nope'), artifactSha256: art.sha256, revision: REV1, install }), /not found/);
  assert.ok(!existsSync(join(base, 'releases')));
});

test('prepare: manifest for another revision or unexpected files → no release dir, staging removed', () => {
  for (const options of [{ manifestRevision: REV2 }, { extra: '.env' }]) {
    const base = tmp('nc-base-');
    const art = artifact(REV1, options);
    assert.throws(
      () => prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: () => assert.fail('no install') }),
      /manifest verification failed/,
    );
    assert.deepEqual(readdirSync(join(base, 'releases')), []);
  }
});

test('prepare: install failure leaves nothing to activate', () => {
  const base = tmp('nc-base-');
  const art = artifact(REV1);
  assert.throws(
    () => prepareRelease({ base, artifact: art.file, artifactSha256: art.sha256, revision: REV1, install: () => { throw new Error('npm ci failed'); } }),
    /npm ci failed/,
  );
  assert.deepEqual(readdirSync(join(base, 'releases')), []);
  assert.throws(() => activateRelease({ base, revision: REV1 }), /not prepared/);
});

test('activate: first deploy, idempotent re-activation, then previous pointer on upgrade', () => {
  const base = tmp('nc-base-');
  prepared(base, REV1);
  assert.deepEqual(activateRelease({ base, revision: REV1 }), { status: 'activated', previous: null });
  assert.equal(readlinkSync(join(base, 'current')), `releases/${REV1}`);
  assert.equal(activateRelease({ base, revision: REV1 }).status, 'already-active');

  prepared(base, REV2);
  assert.deepEqual(activateRelease({ base, revision: REV2 }), { status: 'activated', previous: `releases/${REV1}` });
  assert.deepEqual(releaseStatus(base), { current: REV2, previous: REV1 });
});

test('activate refuses a release modified after preparation', () => {
  const base = tmp('nc-base-');
  prepared(base, REV1);
  writeFileSync(join(base, 'releases', REV1, 'backend/dist/main.js'), 'tampered');
  assert.throws(() => activateRelease({ base, revision: REV1 }), /checksum mismatch/);
  assert.deepEqual(releaseStatus(base), { current: null, previous: null });
});

test('rollback: none on first deploy; afterwards swaps current/previous atomically and reversibly', () => {
  const base = tmp('nc-base-');
  prepared(base, REV1);
  activateRelease({ base, revision: REV1 });
  assert.throws(() => rollbackRelease({ base }), /first deploy/);

  prepared(base, REV2);
  activateRelease({ base, revision: REV2 });
  assert.deepEqual(rollbackRelease({ base }), { status: 'rolled-back', from: `releases/${REV2}`, to: `releases/${REV1}` });
  assert.deepEqual(releaseStatus(base), { current: REV1, previous: REV2 });
  rollbackRelease({ base });
  assert.deepEqual(releaseStatus(base), { current: REV2, previous: REV1 });
  assert.ok(!readdirSync(base).some((f) => f.includes('.tmp-')), 'no temporary symlinks left');
});

// --- API config -------------------------------------------------------------------------------

const legacy = (pass = generatePassword()) =>
  `DB_NAME=node_control_db\nDB_USER=node_control_user\nDB_HOST=127.0.0.1\nDB_PASS=${pass}\nDB_PORT=5432\n`;
const owner = { uid: process.getuid(), gid: process.getgid() };

test('buildApiEnv copies DB keys and adds production loopback defaults', () => {
  const pass = generatePassword();
  const env = parseApiEnv(buildApiEnv(parseApiEnv(legacy(pass))));
  assert.deepEqual(env, {
    NODE_ENV: 'production', API_HOST: '127.0.0.1', API_PORT: '3100', LOG_LEVEL: 'info',
    DB_NAME: 'node_control_db', DB_USER: 'node_control_user', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_PASS: pass,
  });
  assert.deepEqual(validateApiEnv(env), []);
});

test('buildApiEnv/validateApiEnv errors name keys only, never values', () => {
  const pass = generatePassword();
  assert.throws(() => buildApiEnv({ DB_PASS: pass }), (error) => /DB_NAME/.test(error.message) && !error.message.includes(pass));
  assert.throws(() => buildApiEnv({ ...parseApiEnv(legacy()), DB_PASS: 'with space' }), /DB_PASS contains characters/);
  assert.deepEqual(validateApiEnv({ ...parseApiEnv(legacy()), API_HOST: '0.0.0.0' }), ['API_HOST must be a loopback address']);
});

test('ensureApiConfig creates 600 config in a 750 dir atomically, then never overwrites it', () => {
  const root = tmp('nc-etc-');
  const legacyFile = join(root, 'legacy.env');
  writeFileSync(legacyFile, legacy(), { mode: 0o600 });
  const configFile = join(root, 'node-control', 'api.env');

  assert.deepEqual(ensureApiConfig({ configFile, legacyEnvFile: legacyFile, ...owner }), { status: 'created', errors: [] });
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'node-control')).mode & 0o777, 0o750);
  assert.ok(!readdirSync(join(root, 'node-control')).some((f) => f.includes('.tmp-')));

  // Operator customisation and a later change of the legacy file must both survive a redeploy.
  const customised = readFileSync(configFile, 'utf8').replace('LOG_LEVEL=info', 'LOG_LEVEL=warn');
  writeFileSync(configFile, customised);
  writeFileSync(legacyFile, legacy());
  assert.deepEqual(ensureApiConfig({ configFile, legacyEnvFile: legacyFile, ...owner }), { status: 'kept', errors: [] });
  assert.equal(readFileSync(configFile, 'utf8'), customised);
});

test('ensureApiConfig reports wrong mode/owner/content of an existing config without changing it', () => {
  const root = tmp('nc-etc-');
  const configFile = join(root, 'api.env');
  writeFileSync(configFile, 'API_HOST=0.0.0.0\n', { mode: 0o644 });
  const result = ensureApiConfig({ configFile, legacyEnvFile: join(root, 'none'), uid: owner.uid + 1, gid: owner.gid });
  assert.equal(result.status, 'kept');
  assert.ok(result.errors.includes('config mode must be 600'));
  assert.ok(result.errors.includes('config must be owned by the service user'));
  assert.ok(result.errors.includes('DB_PASS is missing'));
  assert.ok(result.errors.includes('API_HOST must be a loopback address'));
  assert.equal(readFileSync(configFile, 'utf8'), 'API_HOST=0.0.0.0\n');
});

test('ensureApiConfig without legacy file fails and creates nothing', () => {
  const root = tmp('nc-etc-');
  const configFile = join(root, 'd', 'api.env');
  assert.throws(() => ensureApiConfig({ configFile, legacyEnvFile: join(root, 'missing'), ...owner }), /legacy env file not found/);
  assert.ok(!existsSync(configFile));
});

// --- CLI ----------------------------------------------------------------------------------------

test('CLI validates commands and required options; status/rollback use --base', () => {
  const base = tmp('nc-base-');
  const quiet = { log: () => {} };
  assert.throws(() => runCli([], quiet), /command must be one of/);
  assert.throws(() => runCli(['deploy'], quiet), /command must be one of/);
  assert.throws(() => runCli(['activate', '--base', base], quiet), /--revision is required/);
  assert.throws(() => runCli(['prepare', '--base', base, '--revision', REV1], quiet), /--artifact is required/);
  assert.throws(() => runCli(['status', 'extra', '--base', base], quiet), /unexpected arguments/);
  assert.throws(() => runCli(['config', '--owner', 'no-such-user-nc'], quiet), /unknown user/);
  assert.deepEqual(runCli(['status', '--base', base], quiet), { current: null, previous: null });
  assert.throws(() => runCli(['rollback', '--base', base], quiet), /first deploy/);
});

test('CLI config never prints values', () => {
  const root = tmp('nc-etc-');
  const pass = generatePassword();
  writeFileSync(join(root, 'legacy.env'), legacy(pass));
  const lines = [];
  const user = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  runCli(['config', '--config', join(root, 'c', 'api.env'), '--legacy-env', join(root, 'legacy.env'), '--owner', user], { log: (l) => lines.push(l) });
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').includes(pass));
});

test('dependency-free release (agent): prepare --no-install and activation without node_modules', () => {
  const base = tmp('nc-agent-base-');
  const art = artifact(REV1);
  const result = runCli(['prepare', '--base', base, '--artifact', art.file, '--sha256', art.sha256, '--revision', REV1, '--no-install'], { log: () => {} });
  assert.equal(result.status, 'prepared');
  assert.ok(!existsSync(join(base, 'releases', REV1, 'node_modules')));
  assert.equal(activateRelease({ base, revision: REV1 }).status, 'activated');
});

test('a release with a lockfile but no installed dependencies is refused', () => {
  const base = tmp('nc-base-');
  prepared(base, REV1);
  writeFileSync(join(base, 'releases', REV1, 'package-lock.json'), '{}');
  rmSync(join(base, 'releases', REV1, 'node_modules'), { recursive: true });
  assert.throws(() => activateRelease({ base, revision: REV1 }), /no installed dependencies|failed verification/);
});

// --- npm of the runtime that runs the release tool (ADR-027, 2026-10-21) --------------------------------------------
const releaseDir = await import('../../scripts/deploy/lib/release-dir.js');

test('runtimeNpmEnv: npm next to this Node.js first in PATH; another Node.js under npm or no npm is refused', () => {
  const probe = (node, status = 0) => (cmd, args, options) => {
    assert.equal(cmd, 'npm');
    assert.deepEqual(args, ['version', '--json']);
    assert.match(options.env.PATH, /^\/opt\/node-control-runtime\/versions\/v\/bin:\/usr\/bin$/);
    return { status, stdout: JSON.stringify({ node }) };
  };
  const base = { env: { PATH: '/usr/bin' }, execPath: '/opt/node-control-runtime/versions/v/bin/node', version: '22.23.4' };
  assert.equal(releaseDir.runtimeNpmEnv({ ...base, probe: probe('22.23.4') }).PATH, '/opt/node-control-runtime/versions/v/bin:/usr/bin');
  assert.throws(() => releaseDir.runtimeNpmEnv({ ...base, probe: probe('21.7.3') }), /npm runs on Node\.js 21\.7\.3, not on 22\.23\.4/);
  assert.throws(() => releaseDir.runtimeNpmEnv({ ...base, probe: probe(undefined, 1) }), /not found or not working/);
});
