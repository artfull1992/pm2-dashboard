// Server-side release management. All paths are parameters so tests run in temporary directories.
//
// <base>/releases/<sha>   immutable release (root-owned), prepared in a staging dir and renamed when complete
// <base>/current          symlink → releases/<sha>   (switched atomically via rename)
// <base>/previous         symlink → the release that was current before the last activation/rollback

import { spawnSync } from 'node:child_process';
import {
  chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildApiEnv, parseApiEnv, validateApiEnv } from './api-env.js';
import { assertRevision, sha256File, verifyManifest } from './manifest.js';

export function layout(base) {
  return { base, releases: join(base, 'releases'), current: join(base, 'current'), previous: join(base, 'previous') };
}

const releaseLink = (revision) => `releases/${revision}`;

function readLink(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

function setLinkAtomic(path, target) {
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, path);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status ?? result.signal})`);
}

export function npmInstallProduction(dir) {
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
}

/** Validated, installed release ready for activation. Throws with the reason otherwise. */
export function assertReleaseUsable(base, revision) {
  const dir = join(layout(base).releases, revision);
  if (!existsSync(dir)) throw new Error(`release ${revision} is not prepared`);
  const errors = verifyManifest(dir, revision);
  if (errors.length > 0) throw new Error(`release ${revision} failed verification: ${errors.join('; ')}`);
  // Releases with a lockfile (API) must have installed dependencies; dependency-free releases (Agent) have none.
  if (existsSync(join(dir, 'package-lock.json')) && !existsSync(join(dir, 'node_modules'))) {
    throw new Error(`release ${revision} has no installed dependencies`);
  }
  return dir;
}

/**
 * Gives every entry of a release tree to uid:gid (root by default) without following symlinks. npm ci run as root
 * keeps the owner recorded in package tarballs (e.g. uid 1001), which a later local user with that uid could modify.
 * Returns the number of entries changed.
 */
export function ownTree(dir, { uid = 0, gid = 0, lchown = lchownSync } = {}) {
  let changed = 0;
  const visit = (path) => {
    const info = lstatSync(path);
    if (info.uid !== uid || info.gid !== gid) { lchown(path, uid, gid); changed += 1; }
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(dir);
  return changed;
}

/**
 * Creates `dir` and every missing parent (like recursive mkdir, so a nested --base keeps working), each NEW level with
 * exactly `mode` — mkdir applies the operator's umask (077 would make the release unreadable for the service users
 * and Nginx). Existing ancestors (and symlink targets) are never changed. A non-directory in the path is refused.
 */
export function ensureDirTree(dir, mode = 0o755) {
  const missing = [];
  let current = dir;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (existsSync(current) && !statSync(current).isDirectory()) throw new Error(`${current} exists and is not a directory`);
  for (const path of missing) {
    mkdirSync(path, { mode });
    chmodSync(path, mode);
  }
}

/**
 * Verifies the artifact checksum, extracts into a staging dir, verifies the manifest, installs production
 * dependencies and only then renames staging → releases/<sha>. Any failure leaves no release directory behind.
 */
export function prepareRelease({ base, artifact, artifactSha256, revision, install = npmInstallProduction }) {
  assertRevision(revision);
  if (!/^[0-9a-f]{64}$/.test(artifactSha256 ?? '')) throw new TypeError('artifact sha256 must be 64 hex characters');
  if (!existsSync(artifact)) throw new Error('artifact not found');
  if (sha256File(artifact) !== artifactSha256) throw new Error('artifact checksum mismatch — not extracted');

  const { releases } = layout(base);
  const target = join(releases, revision);
  if (existsSync(target)) {
    assertReleaseUsable(base, revision);
    return { status: 'already-prepared', dir: target };
  }

  ensureDirTree(releases);
  const staging = join(releases, `.staging-${revision}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o755 });
  chmodSync(staging, 0o755);
  try {
    run('tar', ['-xzf', artifact, '-C', staging, '--no-same-owner']);
    const errors = verifyManifest(staging, revision);
    if (errors.length > 0) throw new Error(`manifest verification failed: ${errors.join('; ')}`);
    install(staging);
    // Root-owned, no secrets: readable (and traversable) by everyone, writable only by root — whatever the umask
    // of the extraction and of npm ci was.
    run('chmod', ['-R', 'u+rwX,go=rX', staging]);
    if (process.getuid?.() === 0) ownTree(staging); // root-owned release (never the uids from npm tarballs)
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { status: 'prepared', dir: target };
}

/** Atomically points current → releases/<sha>; the old target becomes `previous`. */
export function activateRelease({ base, revision }) {
  assertRevision(revision);
  assertReleaseUsable(base, revision);
  const { current, previous } = layout(base);
  const before = readLink(current);
  if (before === releaseLink(revision)) return { status: 'already-active', previous: readLink(previous) };
  if (before) setLinkAtomic(previous, before);
  setLinkAtomic(current, releaseLink(revision));
  return { status: 'activated', previous: before };
}

/** Swaps current and previous (so a rollback can itself be rolled back). First deploy has no previous. */
export function rollbackRelease({ base }) {
  const { current, previous } = layout(base);
  const target = readLink(previous);
  if (!target) throw new Error('no previous release (first deploy): stop and disable the unit instead');
  assertReleaseUsable(base, basename(target));
  const from = readLink(current);
  setLinkAtomic(current, target);
  if (from) setLinkAtomic(previous, from);
  return { status: 'rolled-back', from, to: target };
}

export function releaseStatus(base) {
  const { current, previous } = layout(base);
  const cur = readLink(current);
  const prev = readLink(previous);
  return { current: cur ? basename(cur) : null, previous: prev ? basename(prev) : null };
}

/**
 * Creates the API config once from the legacy DB .env (mode 600, owned by the service user, atomic write).
 * An existing config is never rewritten — only validated — so credentials and custom values survive redeploys.
 */
export function ensureApiConfig({ configFile, legacyEnvFile, uid, gid }) {
  if (existsSync(configFile)) {
    const errors = validateApiEnv(parseApiEnv(readFileSync(configFile, 'utf8')));
    const stat = statSync(configFile);
    if ((stat.mode & 0o777) !== 0o600) errors.push('config mode must be 600');
    if (stat.uid !== uid) errors.push('config must be owned by the service user');
    return { status: 'kept', errors };
  }
  if (!existsSync(legacyEnvFile)) throw new Error('legacy env file not found; cannot create the API config');
  const text = buildApiEnv(parseApiEnv(readFileSync(legacyEnvFile, 'utf8')));

  const dir = dirname(configFile);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  chmodSync(dir, 0o750);
  chownSync(dir, process.getuid?.() ?? uid, gid);

  const tmp = `${configFile}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    chownSync(tmp, uid, gid);
    renameSync(tmp, configFile);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { status: 'created', errors: [] };
}
