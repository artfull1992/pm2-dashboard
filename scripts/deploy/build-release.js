#!/usr/bin/env node
// Builds a release artifact from a committed, pushed revision — never from the working directory.
//   node scripts/deploy/build-release.js [--revision HEAD] [--out <dir>] [--remote-branch origin/main] [--component agent]
//   node scripts/deploy/build-release.js --check [--revision HEAD] [--remote-branch origin/main]   (prints the revision only)
//   node <tree>/scripts/deploy/build-release.js --from-tree <tree> --revision <sha> --out <dir> [--component agent]
// Output: <out>/node-control-api-<sha>.tar.gz (API + frontend/dist + systemd unit), .sha256, node-control-agent-<sha>.tar.gz,
// and server-bundle/ (server-release.js, migrate-paths.js + lib, install/ = host installers) for transfer. Backend and UI are activated together via `current`.
// --component agent: only the Agent artifact and server-bundle, compiled with the locked typescript/@types/node alone
// (no frontend/backend build, no other devDependencies). --from-tree: the tree is a pristine `git archive` of --revision
// (the guided preparation of install.sh extracts it for an unprivileged builder that has no access to the checkout).
// Node.js: 22 not older than NODE_MIN (installer/bootstrap/node-runtime.env), checked BEFORE npm; npm and every child
// process run on this same Node.js (its directory first in PATH, verified through `npm version`).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertRevision, buildManifest, listFiles, MANIFEST_FILE, sha256File } from './lib/manifest.js';

/** What goes into the artifact. No .env*, .git, node_modules, sources, tests or caches. */
export const ARTIFACT_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'backend/dist',
  'backend/migrations',
  'frontend/dist',
  'deploy/systemd/node-control-api.service',
  'scripts/deploy/server-release.js',
  'scripts/deploy/migrate-paths.js',
  'scripts/deploy/lib',
  'installer/dist',
  'installer/package.json',
]);

export function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Agent artifact (installed under its own base on each managed server). No npm dependencies. */
export const AGENT_ARTIFACT_PATHS = Object.freeze([
  'agent/dist',
  'agent/package.json',
  'deploy/systemd/node-control-agent.service',
  'deploy/systemd/node-control-pm2-exporter@.service',
  'deploy/systemd/node-control-pm2-exporter@.timer',
  'deploy/systemd/node-control-pm2-broker@.service',
  'scripts/deploy/server-release.js',
  'scripts/deploy/migrate-paths.js',
  'scripts/deploy/lib',
  'installer/dist',
  'installer/package.json',
]);

// Server-side names and secret shapes that must never appear in the public browser bundle.
const BUNDLE_FORBIDDEN = Object.freeze([
  /DB_PASS|TEST_DB_|DB_USER|DB_HOST|ENV_FILE|AUTH_ALLOWED_ORIGINS/,
  /node_control_(user|db|test)/,
  /postgres(ql)?:\/\//,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /SCRAM-SHA-256\$/,
  /\/etc\/node-control|\/root\//,
]);

/** Fails if the frontend bundle contains source maps or anything that looks like server configuration. */
export function assertBundleClean(distDir) {
  const problems = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name.endsWith('.map')) { problems.push(`source map: ${path.slice(distDir.length + 1)}`); continue; }
      const text = readFileSync(path, 'utf8');
      for (const re of BUNDLE_FORBIDDEN) if (re.test(text)) problems.push(`${path.slice(distDir.length + 1)} matches ${String(re)}`);
    }
  };
  if (!existsSync(join(distDir, 'index.html'))) throw new Error('frontend bundle has no index.html');
  walk(distDir);
  if (problems.length > 0) throw new Error(`frontend bundle rejected: ${problems.join('; ')}`);
}

/** Resolves the revision and refuses dirty trees and commits that are not on the remote branch. */
export function resolveDeployableRevision({ revision = 'HEAD', remoteBranch = 'origin/main', cwd, runGit = git }) {
  if (runGit(['status', '--porcelain'], cwd) !== '') throw new Error('working tree is not clean; commit or stash first');
  const sha = assertRevision(runGit(['rev-parse', '--verify', `${revision}^{commit}`], cwd));
  try {
    runGit(['merge-base', '--is-ancestor', sha, remoteBranch], cwd);
  } catch {
    throw new Error(`${sha} is not contained in ${remoteBranch}; push it first`);
  }
  return sha;
}

/** Copies only the given paths (default: API artifact) from a built source tree into stage; .map files are dropped. */
export function stageArtifact(sourceRoot, stageDir, paths = ARTIFACT_PATHS) {
  mkdirSync(stageDir, { recursive: true });
  for (const path of paths) {
    const from = join(sourceRoot, path);
    if (!existsSync(from)) throw new Error(`artifact input missing: ${path}`);
    cpSync(from, join(stageDir, path), {
      recursive: true,
      filter: (src) => !src.endsWith('.map') && !/(^|\/)\.env/.test(src.slice(sourceRoot.length)),
    });
  }
}

/**
 * server-bundle/BUNDLE.json: the revision and the SHA-256 of every bundle file. The guided installer (install/wizard.js)
 * refuses to run from a bundle that does not match it, so the wizard, the installers and the artifacts of one release
 * always come from the same build (never a stale installer/dist). Integrity against this record — not authenticity.
 */
export const BUNDLE_MANIFEST = 'BUNDLE.json';
export function writeBundleManifest(bundleDir, revision) {
  assertRevision(revision);
  const files = {};
  for (const file of listFiles(bundleDir)) if (file !== BUNDLE_MANIFEST) files[file] = sha256File(join(bundleDir, file));
  writeFileSync(join(bundleDir, BUNDLE_MANIFEST), `${JSON.stringify({ revision, files }, null, 2)}\n`);
}

/** server-bundle/ = scripts/deploy (release tooling) + install/ (host installers, ESM: their package.json comes along). */
export function stageServerBundle(stage, bundleDir) {
  cpSync(join(stage, 'scripts', 'deploy'), bundleDir, { recursive: true });
  cpSync(join(stage, 'installer', 'dist'), join(bundleDir, 'install'), { recursive: true });
  cpSync(join(stage, 'installer', 'package.json'), join(bundleDir, 'install', 'package.json'));
}

/** NODE_MIN / NODE_VERSION / SHA256_* of installer/bootstrap/node-runtime.env (KEY=VALUE lines, # comments). */
export const RUNTIME_SPEC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installer', 'bootstrap', 'node-runtime.env');
export function readRuntimeSpec(path = RUNTIME_SPEC) {
  const spec = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(\S+)$/.exec(line.trim());
    if (m) spec[m[1]] = m[2];
  }
  if (!/^22\.\d+\.\d+$/.test(spec.NODE_MIN ?? '')) throw new Error(`${path}: NODE_MIN must be a Node.js 22 version`);
  return spec;
}

/** Node.js 22 (never another major) not older than `min`; `version` as process.versions.node or `v…`. */
export function nodeVersionOk(version, min) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  const w = /^(\d+)\.(\d+)\.(\d+)$/.exec(min);
  if (!m || !w || Number(m[1]) !== Number(w[1])) return false;
  return Number(m[2]) !== Number(w[2]) ? Number(m[2]) > Number(w[2]) : Number(m[3]) >= Number(w[3]);
}

/** Environment of every child: the directory of THIS Node.js first in PATH (npm, its scripts and tools use it). */
export function buildEnv(env = process.env, execPath = process.execPath) {
  return { ...env, PATH: `${dirname(execPath)}${env.PATH ? `:${env.PATH}` : ''}`, npm_config_update_notifier: 'false' };
}

/**
 * Before any npm call: this Node.js is a supported 22.x, and the npm found through `env` runs on exactly this
 * Node.js (otherwise optional native packages such as the Rolldown binding can be skipped for an older engine).
 */
export function assertBuildRuntime({ min, env, version = process.versions.node, npmVersion = () => spawnSync('npm', ['version', '--json'], { encoding: 'utf8', env, cwd: tmpdir() }) }) {
  if (!nodeVersionOk(version, min)) {
    throw new Error(`Node.js ${version} cannot build this release: Node.js 22 >= ${min} is required by the locked dependencies (installer/bootstrap/node-runtime.env); ./install.sh prepares a compatible runtime`);
  }
  const r = npmVersion();
  let npmNode;
  try { npmNode = r.status === 0 ? JSON.parse(r.stdout).node : undefined; } catch { npmNode = undefined; }
  if (npmNode === undefined) throw new Error(`npm next to Node.js ${version} not found or not working (npm version --json, exit ${r.status ?? r.signal})`);
  if (npmNode !== version) throw new Error(`npm runs on Node.js ${npmNode}, not on ${version}: the npm of this Node.js must come first in PATH`);
  return npmNode;
}

/** Packages (with their dependency closure) the Agent build needs: tsc and the Node.js types — nothing else. */
export const AGENT_BUILD_DEPENDENCIES = Object.freeze(['typescript', '@types/node']);

/**
 * package.json + package-lock.json for `npm ci` of `names` only, derived from the committed lockfile at build time:
 * the same versions, resolved URLs and integrity hashes, never a second hand-maintained copy.
 */
export function subsetLockfile(lock, names) {
  const root = lock.packages?.[''];
  if (lock.lockfileVersion !== 3 || !root) throw new Error('package-lock.json: lockfileVersion 3 expected');
  const spec = (name) => root.devDependencies?.[name] ?? root.dependencies?.[name];
  const packages = {};
  const visit = (from, name) => {
    // Node resolution inside the lockfile: nested node_modules first, then each parent up to the root.
    for (let dir = from; ; dir = dir.includes('/node_modules/') ? dir.slice(0, dir.lastIndexOf('/node_modules/')) : '') {
      const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      const entry = lock.packages[key];
      if (entry) {
        if (packages[key]) return;
        if (!entry.resolved || !entry.integrity) throw new Error(`package-lock.json: ${key} has no resolved/integrity`);
        packages[key] = entry;
        for (const dep of Object.keys(entry.dependencies ?? {})) visit(key, dep);
        return;
      }
      if (dir === '') throw new Error(`package-lock.json: ${name} is not locked`);
    }
  };
  const devDependencies = {};
  for (const name of names) {
    if (!spec(name)) throw new Error(`package.json: ${name} is not a dependency`);
    devDependencies[name] = spec(name);
    visit('', name);
  }
  const pkg = { name: `${root.name}-build-deps`, version: root.version, private: true, devDependencies };
  return { pkg, lockfile: { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, devDependencies }, ...packages } } };
}

const stage = (id) => { console.log(`[build-release] stage=${id}`); };

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

const NPM_CI = ['ci', '--no-audit', '--no-fund', '--ignore-scripts', '--engine-strict'];

function packArtifact(work, outDir, sha, kind, paths, env) {
  const stageDir = join(outDir, kind === 'api' ? 'stage' : 'agent-stage');
  stageArtifact(work, stageDir, paths);
  const manifest = buildManifest(stageDir, { revision: sha });
  writeFileSync(join(stageDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const name = `node-control-${kind}-${sha}.tar.gz`;
  const artifact = join(outDir, name);
  // COPYFILE_DISABLE: no macOS AppleDouble (._*) entries in the archive.
  run('tar', ['-czf', artifact, '-C', stageDir, ...readdirSync(stageDir)], outDir, { ...env, COPYFILE_DISABLE: '1' });
  const digest = sha256File(artifact);
  writeFileSync(`${artifact}.sha256`, `${digest}  ${name}\n`);
  return { stageDir, artifact, sha256: digest, files: Object.keys(manifest.files).length, nodeVersion: manifest.nodeVersion };
}

/** Builds in `work` (a pristine tree of `sha`) and writes artifacts + server-bundle into `outDir`. */
export function buildInTree({ work, sha, outDir, component = 'all', env = buildEnv(), runtimeSpec = RUNTIME_SPEC }) {
  if (component !== 'all' && component !== 'agent') throw new Error('--component: agent (or omitted for the full release)');
  const npmNode = assertBuildRuntime({ min: readRuntimeSpec(runtimeSpec).NODE_MIN, env });
  console.log(`[build-release] runtime node=${process.version} npm-node=v${npmNode} execPath=${process.execPath} uid=${String(process.getuid?.() ?? '?')}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (component === 'agent') {
    stage('npm-ci-agent');
    const deps = join(work, '.build-deps');
    mkdirSync(deps);
    const { pkg, lockfile } = subsetLockfile(JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8')), AGENT_BUILD_DEPENDENCIES);
    writeFileSync(join(deps, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(deps, 'package-lock.json'), `${JSON.stringify(lockfile, null, 2)}\n`);
    run('npm', NPM_CI, deps, env);
    symlinkSync(join(deps, 'node_modules'), join(work, 'node_modules')); // tsc resolves @types/node from the tree root
    const tsc = join(work, 'node_modules', 'typescript', 'bin', 'tsc');
    stage('agent-build');
    run(process.execPath, [tsc, '-p', 'agent/tsconfig.build.json'], work, env);
    stage('installer-build');
    run(process.execPath, [tsc, '-p', 'installer/tsconfig.build.json'], work, env);
    stage('package');
    const agent = packArtifact(work, outDir, sha, 'agent', AGENT_ARTIFACT_PATHS, env);
    stageServerBundle(agent.stageDir, join(outDir, 'server-bundle'));
    writeBundleManifest(join(outDir, 'server-bundle'), sha);
    return { sha, outDir, component, nodeVersion: agent.nodeVersion, agentArtifact: agent.artifact, agentSha256: agent.sha256, agentFiles: agent.files };
  }
  stage('npm-ci');
  run('npm', NPM_CI, work, env);
  for (const script of ['backend:build', 'frontend:build', 'agent:build', 'installer:build']) {
    stage(script.replace(':', '-'));
    run('npm', ['run', script], work, env);
  }
  assertBundleClean(join(work, 'frontend', 'dist'));
  stage('package');
  const api = packArtifact(work, outDir, sha, 'api', ARTIFACT_PATHS, env);
  stageServerBundle(api.stageDir, join(outDir, 'server-bundle'));
  writeBundleManifest(join(outDir, 'server-bundle'), sha);
  const agent = packArtifact(work, outDir, sha, 'agent', AGENT_ARTIFACT_PATHS, env);
  return {
    sha, outDir, component, artifact: api.artifact, sha256: api.sha256, files: api.files, nodeVersion: api.nodeVersion,
    agentArtifact: agent.artifact, agentSha256: agent.sha256, agentFiles: agent.files,
  };
}

export function buildRelease({ revision, out, remoteBranch, cwd = process.cwd(), component = 'all' }) {
  const sha = resolveDeployableRevision({ revision, remoteBranch, cwd });
  const work = mkdtempSync(join(tmpdir(), 'node-control-src-'));
  try {
    git(['archive', '--format=tar', '-o', join(work, 'src.tar'), sha], cwd);
    run('tar', ['-xf', 'src.tar'], work, process.env);
    rmSync(join(work, 'src.tar'));
    return buildInTree({ work, sha, outDir: out ?? join(tmpdir(), `node-control-release-${sha}`), component });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      revision: { type: 'string', default: 'HEAD' },
      out: { type: 'string' },
      'remote-branch': { type: 'string', default: 'origin/main' },
      component: { type: 'string', default: 'all' },
      'from-tree': { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  try {
    if (values.check) {
      console.log(`[build-release] revision=${resolveDeployableRevision({ revision: values.revision, remoteBranch: values['remote-branch'], cwd: process.cwd() })}`);
    } else {
      const result = values['from-tree']
        ? buildInTree({ work: values['from-tree'], sha: assertRevision(values.revision), outDir: values.out ?? '', component: values.component })
        : buildRelease({ revision: values.revision, out: values.out, remoteBranch: values['remote-branch'], component: values.component });
      if (result.artifact) {
        console.log(`[build-release] revision=${result.sha} files=${result.files} node=${result.nodeVersion}`);
        console.log(`[build-release] artifact=${result.artifact}`);
        console.log(`[build-release] sha256=${result.sha256}`);
      } else console.log(`[build-release] revision=${result.sha} component=agent node=${result.nodeVersion}`);
      console.log(`[build-release] agent artifact=${result.agentArtifact} files=${result.agentFiles}`);
      console.log(`[build-release] agent sha256=${result.agentSha256}`);
    }
  } catch (error) {
    console.error(`[build-release] ERROR: ${error.message}`);
    process.exit(1);
  }
}
