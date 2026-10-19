#!/usr/bin/env node
// Builds a release artifact from a committed, pushed revision — never from the working directory.
//   node scripts/deploy/build-release.js [--revision HEAD] [--out <dir>] [--remote-branch origin/main]
// Output: <out>/node-control-api-<sha>.tar.gz (API + frontend/dist + systemd unit), .sha256,
// and server-bundle/ (server-release.js, migrate-paths.js + lib, install/ = host installers) for transfer. Backend and UI are activated together via `current`.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertRevision, buildManifest, MANIFEST_FILE, sha256File } from './lib/manifest.js';

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

/** server-bundle/ = scripts/deploy (release tooling) + install/ (host installers, ESM: their package.json comes along). */
export function stageServerBundle(stage, bundleDir) {
  cpSync(join(stage, 'scripts', 'deploy'), bundleDir, { recursive: true });
  cpSync(join(stage, 'installer', 'dist'), join(bundleDir, 'install'), { recursive: true });
  cpSync(join(stage, 'installer', 'package.json'), join(bundleDir, 'install', 'package.json'));
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

export function buildRelease({ revision, out, remoteBranch, cwd = process.cwd() }) {
  const sha = resolveDeployableRevision({ revision, remoteBranch, cwd });
  const outDir = out ?? join(tmpdir(), `node-control-release-${sha}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const work = mkdtempSync(join(tmpdir(), 'node-control-src-'));
  try {
    git(['archive', '--format=tar', '-o', join(work, 'src.tar'), sha], cwd);
    run('tar', ['-xf', 'src.tar'], work);
    rmSync(join(work, 'src.tar'));
    run('npm', ['ci', '--no-audit', '--no-fund'], work);
    run('npm', ['run', 'backend:build'], work);
    run('npm', ['run', 'frontend:build'], work);
    run('npm', ['run', 'agent:build'], work);
    run('npm', ['run', 'installer:build'], work);
    assertBundleClean(join(work, 'frontend', 'dist'));

    const stage = join(outDir, 'stage');
    stageArtifact(work, stage);
    const manifest = buildManifest(stage, { revision: sha });
    writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    const artifact = join(outDir, `node-control-api-${sha}.tar.gz`);
    // COPYFILE_DISABLE: no macOS AppleDouble (._*) entries in the archive.
    run('tar', ['-czf', artifact, '-C', stage, ...readdirSync(stage)], outDir, { ...process.env, COPYFILE_DISABLE: '1' });
    const digest = sha256File(artifact);
    writeFileSync(`${artifact}.sha256`, `${digest}  node-control-api-${sha}.tar.gz\n`);
    stageServerBundle(stage, join(outDir, 'server-bundle'));

    const agentStage = join(outDir, 'agent-stage');
    stageArtifact(work, agentStage, AGENT_ARTIFACT_PATHS);
    const agentManifest = buildManifest(agentStage, { revision: sha });
    writeFileSync(join(agentStage, MANIFEST_FILE), `${JSON.stringify(agentManifest, null, 2)}\n`);
    const agentArtifact = join(outDir, `node-control-agent-${sha}.tar.gz`);
    run('tar', ['-czf', agentArtifact, '-C', agentStage, ...readdirSync(agentStage)], outDir, { ...process.env, COPYFILE_DISABLE: '1' });
    const agentDigest = sha256File(agentArtifact);
    writeFileSync(`${agentArtifact}.sha256`, `${agentDigest}  node-control-agent-${sha}.tar.gz\n`);

    return {
      sha, artifact, sha256: digest, files: Object.keys(manifest.files).length, nodeVersion: manifest.nodeVersion, outDir,
      agentArtifact, agentSha256: agentDigest, agentFiles: Object.keys(agentManifest.files).length,
    };
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
    },
  });
  try {
    const result = buildRelease({ revision: values.revision, out: values.out, remoteBranch: values['remote-branch'] });
    console.log(`[build-release] revision=${result.sha} files=${result.files} node=${result.nodeVersion}`);
    console.log(`[build-release] artifact=${result.artifact}`);
    console.log(`[build-release] sha256=${result.sha256}`);
    console.log(`[build-release] agent artifact=${result.agentArtifact} files=${result.agentFiles}`);
    console.log(`[build-release] agent sha256=${result.agentSha256}`);
  } catch (error) {
    console.error(`[build-release] ERROR: ${error.message}`);
    process.exit(1);
  }
}
