import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mustRun, type Preflight, type Step } from './engine.js';
import type { Host } from './host.js';
import { type ArtifactRef, parseChecksumFile } from './validate.js';

// Releases are handled ONLY by the existing scripts/deploy/server-release.js (prepare: checksum → manifest →
// install → atomic rename; activate: current/previous symlinks). The installer adds the decisions around it: never
// switch an already active installation to another revision, never prepare over a foreign directory.

/** server-release.js shipped next to this installer: server-bundle/install/ → ../ ; release installer/dist/ → ../../scripts/deploy/. */
export function defaultReleaseTool(here = dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [join(here, '..', 'server-release.js'), join(here, '..', '..', 'scripts', 'deploy', 'server-release.js')];
  return candidates.find((c) => existsSync(c)) ?? candidates[0] ?? '';
}

const RELEASE_ENTRIES = new Set(['releases', 'current', 'previous']);

/** Artifact checks before any change: present, checksum file matches, SHA-256 of the file matches. */
export function checkArtifact(host: Host, ref: ArtifactRef, p: Preflight): string | null {
  if (host.stat(ref.path)?.kind !== 'file') { p.errors.push(`артефакт не знайдено: ${ref.path}`); return null; }
  if (host.stat(ref.checksumFile)?.kind !== 'file') { p.errors.push(`немає файлу контрольної суми ${basename(ref.checksumFile)} поруч з артефактом`); return null; }
  let expected: string;
  try {
    expected = parseChecksumFile(host.readFile(ref.checksumFile), basename(ref.path));
  } catch (error) {
    p.errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
  if (host.sha256File(ref.path) !== expected) {
    p.errors.push('SHA-256 артефакту не збігається з .sha256: файл пошкоджений або підмінений — передайте його заново');
    return null;
  }
  p.notes.push(`артефакт ${basename(ref.path)}: SHA-256 збігається (ревізія ${ref.revision.slice(0, 12)})`);
  return expected;
}

/** Existing base directory: only our own layout (releases/current/previous) is accepted. */
export function checkBase(host: Host, base: string, p: Preflight): void {
  const info = host.stat(base);
  if (!info) return;
  if (info.kind !== 'dir') { p.errors.push(`${base} існує і це не каталог`); return; }
  const entries = host.list(base);
  const foreign = entries.filter((e) => !RELEASE_ENTRIES.has(e) && !e.startsWith('current.tmp-') && !e.startsWith('previous.tmp-'));
  if (foreign.length > 0) p.errors.push(`${base} містить сторонні файли (${foreign.slice(0, 5).join(', ')}): це не каталог релізів Node Control — інсталятор туди не пише`);
}

/**
 * Units the installer would install, compared BEFORE any change with the copies inside the (checksum-verified)
 * artifact, read without extracting it (`tar -xzOf`). An existing different unit is not ours to replace: stop here,
 * not after user, release, config and migrations were already created.
 */
export function checkUnits(host: Host, ref: ArtifactRef, units: readonly string[], p: Preflight): void {
  for (const unit of units) {
    const target = `/etc/systemd/system/${unit}`;
    const info = host.stat(target);
    if (!info) continue;
    if (info.kind !== 'file') { p.errors.push(`${target} існує і не є звичайним файлом — перевірте його самостійно`); continue; }
    const shipped = host.run('tar', ['-xzOf', ref.path, `deploy/systemd/${unit}`]);
    if (shipped.code !== 0) { p.errors.push(`не вдалося прочитати ${unit} з артефакту для порівняння`); continue; }
    if (host.readFile(target) !== shipped.stdout) {
      p.errors.push(`${target} відрізняється від unit в артефакті (інша версія або ручні зміни): порівняйте вручну; оновлення units — за docs/DEPLOYMENT.md, інсталятор їх не перезаписує`);
    }
  }
}

/** An installation that already runs another revision is an upgrade: stop before any change. */
export function checkNotOtherRelease(host: Host, base: string, revision: string, p: Preflight): void {
  const current = currentRevision(host, base);
  if (current !== null && current !== revision) {
    p.errors.push(`у ${base} уже активний інший реліз ${current.slice(0, 12)}: це оновлення — штатна процедура (docs/INSTALLATION.md, «Оновлення»); інсталятор релізи не перемикає`);
  } else if (current === revision) p.notes.push(`реліз ${revision.slice(0, 12)} уже активний — повторний запуск лише перевірить і доведе решту кроків`);
}

export function currentRevision(host: Host, base: string): string | null {
  const link = host.readlink(join(base, 'current'));
  return link === null ? null : basename(link);
}

export function prepareStep(tool: string, base: string, ref: ArtifactRef, sha256: () => string, noInstall: boolean): Step {
  return {
    id: 'release:prepare',
    title: `реліз ${ref.revision.slice(0, 12)} у ${base}/releases`,
    check({ host }) {
      if (host.stat(join(base, 'releases', ref.revision))?.kind === 'dir') return { state: 'done', detail: 'підготовлено раніше; цілісність перевіряє activate' };
      return { state: 'pending', detail: `server-release.js prepare (контрольна сума → manifest${noInstall ? '' : ' → npm ci --omit=dev'})` };
    },
    apply({ host }) {
      mustRun(host, '/usr/bin/node', [tool, 'prepare', '--base', base, '--artifact', ref.path, '--sha256', sha256(), '--revision', ref.revision, ...(noInstall ? ['--no-install'] : [])], 'server-release.js prepare');
    },
    recovery: 'prepare не залишає частково розпакованого релізу; причину видно вище (контрольна сума, manifest, npm). Повторіть після виправлення',
  };
}

export function activateStep(tool: string, base: string, ref: ArtifactRef, effects: readonly string[]): Step {
  return {
    id: 'release:activate',
    title: `активний реліз (${base}/current)`,
    check({ host }) {
      const current = currentRevision(host, base);
      if (current === null) return { state: 'pending', detail: `server-release.js activate → ${ref.revision.slice(0, 12)}` };
      if (current === ref.revision) return { state: 'done', detail: ref.revision.slice(0, 12) };
      return {
        state: 'conflict',
        detail: `уже активний інший реліз ${current.slice(0, 12)} — інсталятор не перемикає релізи`,
        fix: 'це оновлення: виконайте штатну процедуру оновлення (docs/INSTALLATION.md, «Оновлення») або запустіть інсталятор з артефактом активної ревізії',
      };
    },
    apply({ host }) {
      mustRun(host, '/usr/bin/node', [tool, 'activate', '--base', base, '--revision', ref.revision], 'server-release.js activate');
    },
    effects,
    recovery: `node ${tool} status --base ${base}; activate перевіряє manifest — пошкоджений реліз видаліть (rm -r ${base}/releases/${ref.revision}) і повторіть`,
  };
}
