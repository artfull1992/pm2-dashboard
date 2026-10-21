import { join, resolve } from 'node:path';
import type { Host } from './host.js';

// A prepared release = the directory written by scripts/deploy/build-release.js: versioned artifacts (+ .sha256) and
// server-bundle/ (release tooling + the installers + this wizard). The wizard and the installers it calls must come
// from the SAME build as the artifacts: server-bundle/BUNDLE.json records the revision and the SHA-256 of every bundle
// file, written by build-release.js. A stale installer/dist, a bundle mixed from two builds or artifacts of another
// revision are refused before anything else happens. SHA-256 proves integrity against this record, not who built it.

export const BUNDLE_MANIFEST = 'BUNDLE.json';
const REVISION_RE = /^[0-9a-f]{40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ARTIFACT_RE = /^node-control-(api|agent)-([0-9a-f]{40})\.tar\.gz$/;

export interface ReleaseInfo { dir: string; bundle: string; revision: string; api: string | null; agent: string | null }

function bundleFiles(host: Host, root: string, rel = ''): { files: string[]; problems: string[] } {
  const files: string[] = [];
  const problems: string[] = [];
  for (const name of host.list(join(root, rel)).sort()) {
    const path = rel === '' ? name : `${rel}/${name}`;
    const kind = host.stat(join(root, path))?.kind;
    if (kind === 'dir') {
      const sub = bundleFiles(host, root, path);
      files.push(...sub.files);
      problems.push(...sub.problems);
    } else if (kind === 'file') files.push(path);
    else problems.push(`server-bundle/${path}: не звичайний файл (symlink або інше) — бандл має містити лише файли`);
  }
  return { files, problems };
}

/** Checks the release directory and the bundle the wizard runs from. Returns the release or the list of problems. */
export function verifyRelease(host: Host, releaseDir: string, bundleDir: string): { ok: true; release: ReleaseInfo } | { ok: false; errors: string[] } {
  // Canonical paths: the wizard is loaded by its real path, --release may name the same place through a symlink.
  const dir = host.realpath(releaseDir) ?? resolve(releaseDir);
  const bundle = host.realpath(bundleDir) ?? resolve(bundleDir);
  const errors: string[] = [];
  if (host.stat(dir)?.kind !== 'dir') return { ok: false, errors: [`каталог релізу не знайдено: ${resolve(releaseDir)}`] };
  if (bundle !== join(dir, 'server-bundle')) {
    errors.push(`майстер запущено не з бандла цього релізу (${bundle}); запускайте ./install.sh --release ${dir} або ${join(dir, 'server-bundle', 'install', 'wizard.js')}`);
    return { ok: false, errors };
  }
  const manifestPath = join(bundle, BUNDLE_MANIFEST);
  if (host.stat(manifestPath)?.kind !== 'file') {
    return { ok: false, errors: [`немає ${BUNDLE_MANIFEST} у server-bundle — реліз зібрано не build-release.js цієї версії; підготуйте його заново (docs/INSTALLATION.md)`] };
  }
  let manifest: { revision?: unknown; files?: unknown };
  try {
    manifest = JSON.parse(host.readFile(manifestPath)) as { revision?: unknown; files?: unknown };
  } catch {
    return { ok: false, errors: [`${BUNDLE_MANIFEST} пошкоджений`] };
  }
  const revision = typeof manifest.revision === 'string' && REVISION_RE.test(manifest.revision) ? manifest.revision : null;
  const listed = typeof manifest.files === 'object' && manifest.files !== null ? manifest.files as Record<string, unknown> : null;
  if (!revision || !listed) return { ok: false, errors: [`${BUNDLE_MANIFEST}: немає ревізії або переліку файлів`] };

  const found = bundleFiles(host, bundle);
  errors.push(...found.problems);
  const present = new Set(found.files.filter((f) => f !== BUNDLE_MANIFEST));
  for (const [file, hash] of Object.entries(listed)) {
    if (typeof hash !== 'string' || !SHA_RE.test(hash)) { errors.push(`${BUNDLE_MANIFEST}: некоректний запис для ${file}`); continue; }
    if (!present.has(file)) errors.push(`server-bundle/${file}: файл відсутній`);
    else if (host.sha256File(join(bundle, file)) !== hash) errors.push(`server-bundle/${file}: вміст змінено (не відповідає ${BUNDLE_MANIFEST})`);
    present.delete(file);
  }
  for (const extra of present) errors.push(`server-bundle/${extra}: зайвий файл (не з цієї збірки)`);

  let api: string | null = null;
  let agent: string | null = null;
  for (const name of host.list(dir)) {
    const m = ARTIFACT_RE.exec(name);
    if (!m) continue;
    if (m[2] !== revision) { errors.push(`${name}: артефакт іншої ревізії, ніж бандл (${revision.slice(0, 12)}) — у каталозі релізу мають бути артефакти однієї збірки`); continue; }
    if (host.stat(join(dir, `${name}.sha256`))?.kind !== 'file') errors.push(`${name}: немає ${name}.sha256 поруч`);
    if (m[1] === 'api') api = join(dir, name); else agent = join(dir, name);
  }
  if (!api && !agent) errors.push('у каталозі релізу немає артефактів node-control-api-*/node-control-agent-*.tar.gz');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, release: { dir, bundle, revision, api, agent } };
}
