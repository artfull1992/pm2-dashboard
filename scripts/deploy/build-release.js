#!/usr/bin/env node
// Builds a release artifact from a committed, pushed revision — never from the working directory.
//   node scripts/deploy/build-release.js [--revision HEAD] [--out <dir>] [--remote-branch origin/main]
// Output: <out>/node-control-api-<sha>.tar.gz, .sha256, and server-bundle/ (server-release.js + lib) for transfer.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  'deploy/systemd/node-control-api.service',
  'scripts/deploy/server-release.js',
  'scripts/deploy/lib',
]);

export function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
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

/** Copies only ARTIFACT_PATHS from a built source tree into stage; .map files are dropped. */
export function stageArtifact(sourceRoot, stageDir) {
  mkdirSync(stageDir, { recursive: true });
  for (const path of ARTIFACT_PATHS) {
    const from = join(sourceRoot, path);
    if (!existsSync(from)) throw new Error(`artifact input missing: ${path}`);
    cpSync(from, join(stageDir, path), {
      recursive: true,
      filter: (src) => !src.endsWith('.map') && !/(^|\/)\.env/.test(src.slice(sourceRoot.length)),
    });
  }
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

    const stage = join(outDir, 'stage');
    stageArtifact(work, stage);
    const manifest = buildManifest(stage, { revision: sha });
    writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    const artifact = join(outDir, `node-control-api-${sha}.tar.gz`);
    // COPYFILE_DISABLE: no macOS AppleDouble (._*) entries in the archive.
    run('tar', ['-czf', artifact, '-C', stage, ...readdirSync(stage)], outDir, { ...process.env, COPYFILE_DISABLE: '1' });
    const digest = sha256File(artifact);
    writeFileSync(`${artifact}.sha256`, `${digest}  node-control-api-${sha}.tar.gz\n`);
    cpSync(join(stage, 'scripts', 'deploy'), join(outDir, 'server-bundle'), { recursive: true });
    return { sha, artifact, sha256: digest, files: Object.keys(manifest.files).length, nodeVersion: manifest.nodeVersion, outDir };
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
  } catch (error) {
    console.error(`[build-release] ERROR: ${error.message}`);
    process.exit(1);
  }
}
