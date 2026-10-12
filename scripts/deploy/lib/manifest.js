// Release manifest: revision + SHA-256 of every file in the artifact. Shared by build (local) and server scripts.
// Self-contained (Node built-ins only): the server runs it from the transferred release, before npm ci.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MANIFEST_FILE = 'RELEASE.json';
const REVISION_RE = /^[0-9a-f]{40}$/;

export function assertRevision(revision) {
  if (typeof revision !== 'string' || !REVISION_RE.test(revision)) {
    throw new TypeError('revision must be a full 40-character lowercase git SHA');
  }
  return revision;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** All regular files under root, as POSIX-relative paths, sorted. node_modules is never part of an artifact. */
export function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(root, path);
      if (!entry.isFile()) throw new Error(`Unexpected non-regular file in release: ${relative(root, path)}`);
      return [relative(root, path).split(sep).join('/')];
    })
    .sort();
}

export function buildManifest(root, { revision, createdAt = new Date().toISOString(), nodeVersion = process.version }) {
  assertRevision(revision);
  const files = {};
  for (const file of listFiles(root)) {
    if (file === MANIFEST_FILE) continue;
    files[file] = sha256File(join(root, file));
  }
  return { revision, createdAt, nodeVersion, files };
}

export function readManifest(root) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) throw new Error(`${MANIFEST_FILE} missing in ${root}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Errors (empty = valid): revision mismatch, missing/changed/unexpected files. node_modules is ignored. */
export function verifyManifest(root, expectedRevision) {
  const errors = [];
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (error) {
    return [error.message];
  }
  if (manifest.revision !== expectedRevision) errors.push('manifest revision does not match the expected revision');
  const expected = manifest.files ?? {};
  for (const [file, hash] of Object.entries(expected)) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile()) errors.push(`missing file: ${file}`);
    else if (sha256File(path) !== hash) errors.push(`checksum mismatch: ${file}`);
  }
  for (const file of listFiles(root)) {
    if (file !== MANIFEST_FILE && !(file in expected)) errors.push(`unexpected file: ${file}`);
  }
  return errors;
}
