// Renames installed Node Control paths (directories and files) and rewrites path references inside the given
// configuration files — for an existing installation whose paths change between releases. Pure Node, no shell.
//
// The operator passes every old and new path explicitly (`moves`); nothing is assumed. Rules:
//  * preflight before any change: each move is pending (old exists, new absent), done (old absent or an alias to the
//    new path, new exists) or a CONFLICT (both exist, or neither) — any conflict stops the whole run unchanged;
//  * a move is a same-filesystem rename(2): owner, mode, contents, sockets and inodes are kept, nothing is copied;
//  * a rewrite replaces old path prefixes (only whole path components) in a config file: the original is first saved
//    to the backup directory (0600), the new content is written to a temp file with the original owner/mode and
//    renamed over it; values are never printed — only the names of the keys that changed;
//  * every completed step is appended to a state file (fsync) before the next one starts, so a failed run can be
//    rolled back exactly (`rollbackMigration`), and a repeated run skips completed steps;
//  * the state file and the backup directory must lie outside every path the migration moves, rewrites or aliases
//    (checked on resolved paths, before anything is created);
//  * a rewrite records the exact lines it changed (before → after). Rollback restores ONLY those lines, and only if
//    each is still found unambiguously; any other content written after the migration (rotated tokens, added or
//    removed keys) is kept. A migrated line changed by someone else is a conflict: rollback checks all steps first
//    and refuses before changing anything;
//  * optional aliases (old path → symlink to the new one) are temporary and removed by `finalizeMigration`;
//  * `maps` are reference-only renames (nothing is moved), e.g. a systemd RuntimeDirectory under /run that the unit
//    re-creates under its new name: only the references inside the rewritten files change.

import {
  chmodSync, chownSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync,
  readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

export class MigrationError extends Error {}

const exists = (path) => {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
/** What is at `path`, for messages (never its content). */
const kindOf = (path) => {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return `a symlink to ${readlinkSync(path)}`;
    if (st.isDirectory()) return readdirSync(path).length > 0 ? 'a non-empty directory' : 'an empty directory';
    return st.isFile() ? 'a regular file' : 'a special file';
  } catch { return 'nothing'; }
};
const isAliasTo = (path, target) => {
  try { return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target; } catch { return false; }
};

/** `--move OLD=NEW` pairs → validated, non-overlapping absolute paths. */
export function parseMoves(pairs) {
  if (pairs.length === 0) throw new MigrationError('at least one --move OLD=NEW is required');
  const moves = pairs.map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) throw new MigrationError(`invalid --move (expected OLD=NEW): ${pair}`);
    const [from, to] = [pair.slice(0, eq), pair.slice(eq + 1)];
    for (const p of [from, to]) {
      if (!isAbsolute(p) || normalize(p) !== p || p === sep || p.endsWith(sep)) throw new MigrationError(`not a normalized absolute path: ${p}`);
    }
    if (from === to) throw new MigrationError(`old and new path are the same: ${from}`);
    return { from, to };
  });
  const all = moves.flatMap((m) => [m.from, m.to]);
  for (const a of all) {
    for (const b of all) {
      if (a !== b && (b.startsWith(`${a}${sep}`))) throw new MigrationError(`paths must not be nested: ${a} and ${b}`);
    }
  }
  if (new Set(all).size !== all.length) throw new MigrationError('a path is used more than once');
  return moves;
}

/** Replaces old path prefixes by new ones, only at whole path components. Returns the new text and changed keys. */
export function rewriteText(text, moves) {
  const changedKeys = new Set();
  const lines = text.split('\n').map((line, index) => {
    let out = line;
    for (const { from, to } of moves) {
      const re = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\s"'=:;,%])`, 'g');
      out = out.replace(re, to);
    }
    if (out !== line) {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      changedKeys.add(key ?? `line ${String(index + 1)}`);
    }
    return out;
  });
  return { text: lines.join('\n'), changedKeys: [...changedKeys] };
}

/** Where a configured file is now: under an old path while its move is pending, else at its given (new) location. */
function currentLocation(file, moves) {
  for (const m of moves) {
    if (file === m.to || file.startsWith(`${m.to}${sep}`)) {
      const old = m.from + file.slice(m.to.length);
      if (!exists(m.to) && exists(old)) return old;
    }
  }
  return file;
}

/** Path as it would resolve: realpath of the nearest existing ancestor + the not-yet-existing remainder. */
function resolveLoose(path) {
  let head = path;
  const rest = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      if (head === dirname(head)) return join(head, ...rest);
      rest.unshift(basename(head));
      head = dirname(head);
    }
  }
}
const within = (a, b) => a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
const BACKUP_NAME = /^\d{2,}-.+\.orig$/;

/** The migration's own metadata must not be moved, rewritten or aliased by it (resolved paths, symlinks included). */
function metadataProblems({ moves, rewrites, aliases, backupDir, stateFile }) {
  const problems = [];
  const given = [['--state', stateFile], ['--backup-dir', backupDir]].filter(([, v]) => v !== undefined);
  for (const [flag, v] of given) {
    if (!isAbsolute(v) || normalize(v) !== v) problems.push(`${flag} must be a normalized absolute path`);
  }
  if (problems.length > 0) return problems;
  const touched = [
    ...moves.flatMap((m) => [m.from, m.to]),
    ...rewrites.flatMap((f) => [f, currentLocation(f, moves)]),
    ...aliases,
  ].map((x) => ({ raw: x, real: resolveLoose(x) }));
  for (const [flag, v] of given) {
    const real = resolveLoose(v);
    for (const t of touched) {
      if (within(real, t.real)) problems.push(`${flag} ${v} lies inside (or is) ${t.raw}, which this migration moves/rewrites/aliases — keep migration metadata elsewhere`);
      else if (flag === '--backup-dir' && within(t.real, real)) problems.push(`${flag} ${v} contains ${t.raw}, which this migration changes — keep migration metadata elsewhere`);
    }
  }
  if (stateFile !== undefined) {
    if (exists(stateFile) && !lstatSync(stateFile).isFile()) problems.push(`--state ${stateFile} exists and is not a regular file`);
    if (backupDir !== undefined && resolveLoose(dirname(stateFile)) === resolveLoose(backupDir) && BACKUP_NAME.test(basename(stateFile))) {
      problems.push(`--state ${stateFile} collides with the backup file naming in --backup-dir`);
    }
    if (backupDir !== undefined && resolveLoose(stateFile) === resolveLoose(backupDir)) problems.push('--state must not be the backup directory');
    const parent = dirname(stateFile);
    if (!exists(parent) && (backupDir === undefined || resolveLoose(parent) !== resolveLoose(backupDir))) problems.push(`the directory of --state ${stateFile} does not exist`);
  }
  return [...new Set(problems)];
}

/**
 * Read-only preflight: what would happen; throws on any conflict before anything is changed. When the state file
 * and backup directory are given (always for apply), their placement is checked too.
 */
export function planMigration({ moves, maps = [], rewrites = [], aliases = [], backupDir, stateFile }) {
  const references = [...moves, ...maps];
  const steps = [];
  const problems = metadataProblems({ moves, rewrites, aliases, backupDir, stateFile });
  for (const m of moves) {
    const oldExists = exists(m.from);
    const newExists = exists(m.to);
    if (oldExists && isAliasTo(m.from, m.to) && newExists) { steps.push({ type: 'move', ...m, state: 'done' }); continue; }
    if (oldExists && newExists) { problems.push(`conflict: both ${m.from} and ${m.to} exist (nothing is overwritten)`); continue; }
    if (!oldExists && !newExists) { problems.push(`missing: neither ${m.from} nor ${m.to} exists`); continue; }
    if (!oldExists) { steps.push({ type: 'move', ...m, state: 'done' }); continue; }
    if (lstatSync(m.from).isSymbolicLink()) { problems.push(`refusing to move a symlink: ${m.from}`); continue; }
    if (!exists(dirname(m.to))) { problems.push(`parent directory of ${m.to} does not exist`); continue; }
    if (statSync(dirname(m.from)).dev !== statSync(dirname(m.to)).dev) { problems.push(`${m.from} and ${m.to} are on different filesystems (a live move would be a copy)`); continue; }
    steps.push({ type: 'move', ...m, state: 'pending' });
  }
  for (const file of rewrites) {
    if (!isAbsolute(file)) { problems.push(`rewrite target is not absolute: ${file}`); continue; }
    const at = currentLocation(file, moves);
    if (!exists(at)) { problems.push(`rewrite target does not exist: ${file}`); continue; }
    if (!lstatSync(at).isFile()) { problems.push(`rewrite target is not a regular file: ${file}`); continue; }
    const { changedKeys } = rewriteText(readFileSync(at, 'utf8'), references);
    steps.push({ type: 'rewrite', file, keys: changedKeys, state: changedKeys.length > 0 ? 'pending' : 'done' });
  }
  for (const from of aliases) {
    const m = moves.find((x) => x.from === from);
    if (!m) { problems.push(`alias ${from} is not the old path of a move`); continue; }
    steps.push({ type: 'alias', path: from, target: m.to, state: isAliasTo(from, m.to) ? 'done' : 'pending' });
  }
  if (problems.length > 0) throw new MigrationError(`preflight failed — nothing was changed:\n  ${problems.join('\n  ')}`);
  return steps;
}

function writeAtomic(path, text, { mode, uid, gid }) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { chownSync(tmp, uid, gid); } catch (error) { if (error.code !== 'EPERM' || process.getuid?.() === 0) throw error; }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function loadState(stateFile) {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
}
function saveState(stateFile, state) {
  writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
}

/**
 * Applies the plan step by step. Backups go to `backupDir` (created 0700); `stateFile` records each completed step.
 * `failAfter` (tests only) throws after that many completed steps to exercise partial-failure recovery.
 */
export function applyMigration({ moves, maps = [], rewrites = [], aliases = [], backupDir, stateFile, log = () => undefined, failAfter }) {
  if (typeof backupDir !== 'string' || typeof stateFile !== 'string') throw new MigrationError('--backup-dir and --state are required');
  const steps = planMigration({ moves, maps, rewrites, aliases, backupDir, stateFile });
  const previous = loadState(stateFile);
  const state = previous ?? { version: 2, startedAt: new Date().toISOString(), moves, maps, backupDir, done: [] };
  if (previous && JSON.stringify(previous.moves) !== JSON.stringify(moves)) throw new MigrationError('the state file belongs to another migration (different moves)');
  if (previous?.status === 'rolled-back') throw new MigrationError('this migration was rolled back; start a new one with a new state file');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  state.status = 'in-progress';
  saveState(stateFile, state);
  let completed = 0;
  // Each step is journaled BEFORE it runs (complete: false) and marked complete after it: a crash in between still
  // leaves the step in the journal, and rollback decides from the actual filesystem state.
  const begin = (entry) => { state.done.push({ ...entry, complete: false }); saveState(stateFile, state); return state.done.at(-1); };
  const end = (entry) => {
    entry.complete = true;
    saveState(stateFile, state);
    completed += 1;
    if (failAfter !== undefined && completed >= failAfter) throw new MigrationError(`simulated failure after ${String(completed)} step(s)`);
  };

  for (const step of steps) {
    if (step.state === 'done') { log(`= ${step.type} ${step.type === 'move' ? `${step.from} → ${step.to}` : step.type === 'rewrite' ? step.file : step.path} (already done)`); continue; }
    if (step.type === 'move') {
      const entry = begin({ type: 'move', from: step.from, to: step.to });
      renameSync(step.from, step.to);
      log(`✓ moved ${step.from} → ${step.to}`);
      end(entry);
    } else if (step.type === 'rewrite') {
      const st = statSync(step.file);
      const original = readFileSync(step.file, 'utf8');
      const backup = join(backupDir, `${String(state.done.length).padStart(2, '0')}-${basename(step.file)}.orig`);
      writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
      const entry = begin({ type: 'rewrite', file: step.file, backup, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid });
      const { text, changedKeys } = rewriteText(original, [...moves, ...maps]);
      entry.changes = lineChanges(original, text);
      saveState(stateFile, state);
      writeAtomic(step.file, text, { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid });
      log(`✓ rewrote ${step.file} (keys: ${changedKeys.join(', ')}; values not shown)`);
      end(entry);
    } else {
      const entry = begin({ type: 'alias', path: step.path, target: step.target });
      symlinkSync(step.target, step.path);
      log(`✓ temporary alias ${step.path} → ${step.target}`);
      end(entry);
    }
  }
  state.status = 'applied';
  state.appliedAt = new Date().toISOString();
  saveState(stateFile, state);
  return state;
}

/** Lines that differ between the original and the rewritten text (same line count: rewrites never add lines). */
function lineChanges(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: line, after: b[i] }]));
}

const keyOf = (line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? 'a non-key line';
const count = (lines, text) => lines.filter((l) => l === text).length;

/**
 * Restores the migrated lines of one rewritten file in its CURRENT content. Each distinct migrated line must be found
 * exactly as many times as it was written (then it is restored) or not at all while its original is present
 * (already restored); anything else is a conflict. Other lines are never touched. Problems name keys, never values.
 */
function restoreLines(current, changes) {
  const lines = current.split('\n');
  const problems = [];
  const groups = new Map();
  for (const c of changes) groups.set(c.after, [...(groups.get(c.after) ?? []), c]);
  for (const [after, group] of groups) {
    const found = count(lines, after);
    if (found === group.length) {
      let k = 0;
      for (let i = 0; i < lines.length; i++) if (lines[i] === after) lines[i] = group[k++].before;
    } else {
      // Already restored (an interrupted earlier rollback): no migrated line left and every original line present.
      const restoredBefore = found === 0 && group.every((c) => count(lines, c.before) >= group.filter((x) => x.before === c.before).length);
      if (!restoredBefore) problems.push(keyOf(group[0].before));
    }
  }
  return { text: lines.join('\n'), problems };
}

/**
 * Undoes the recorded steps in reverse order; safe to repeat. Every step is checked first (reverse moves possible,
 * migrated lines found unambiguously) and nothing is changed if any check fails. Moved data is renamed back; a
 * rewritten file keeps every change made after the migration except the lines the migration itself wrote.
 * `dryRun`: only the checks — reports what would be undone, writes nothing (not even the state file).
 * `legacyMaps`: for a state written by the earlier tool version (no recorded line changes, no maps): the same --map
 * pairs as at apply, so the changes can be re-derived from the backup — they are still verified against the file.
 */
export function rollbackMigration({ stateFile, legacyMaps, dryRun = false, log = () => undefined, beforeWrite, beforeStep }) {
  const state = loadState(stateFile);
  if (!state) throw new MigrationError(`no state file: ${stateFile}`);
  const pending = [...state.done].reverse().filter((step) => !step.undone);
  if (pending.length === 0 && state.status === 'rolled-back') { log('already rolled back; nothing to do'); return state; }
  const problems = [];
  const plans = new Map();
  for (const step of pending) {
    if (step.type === 'rewrite') {
      let changes = step.changes;
      if (!changes) {
        if (!legacyMaps) {
          problems.push(`${step.file}: state written by an earlier version of this tool has no recorded line changes — re-run with the same --legacy-map OLD=NEW pairs as the apply used (none if it had no --map), or recover manually (DEPLOYMENT)`);
          continue;
        }
        if (!exists(step.backup)) { problems.push(`${step.file}: backup ${step.backup} is missing — recover manually (DEPLOYMENT)`); continue; }
        const original = readFileSync(step.backup, 'utf8');
        const derived = rewriteText(original, [...state.moves, ...legacyMaps]).text;
        changes = lineChanges(original, derived);
        if (changes.length === 0) { problems.push(`${step.file}: the given maps derive no changes from the backup — not the maps of this migration`); continue; }
        // Completeness without a record: every current line carrying an absolute path must be explained by the
        // derived result; otherwise a migrated reference may be missing from the maps (or edited) — refuse.
        if (exists(step.file)) {
          const expected = new Set(derived.split('\n'));
          const unexplained = readFileSync(step.file, 'utf8').split('\n').filter((l) => !expected.has(l) && /(^|[="'\s:])\/[A-Za-z0-9._-]/.test(l));
          if (unexplained.length > 0) {
            problems.push(`${step.file}: lines with paths not explained by this migration (${[...new Set(unexplained.map((l) => keyOf(l)))].join(', ')}) — check --legacy-map or recover manually (DEPLOYMENT)`);
            continue;
          }
        }
      }
      if (!exists(step.file) || !lstatSync(step.file).isFile()) { problems.push(`${step.file}: not found as a regular file`); continue; }
      const current = readFileSync(step.file, 'utf8');
      const restored = restoreLines(current, changes);
      if (restored.problems.length > 0) {
        problems.push(`${step.file}: migrated line(s) changed after the migration (${restored.problems.join(', ')}) — not restored automatically`);
        continue;
      }
      plans.set(step, { current, text: restored.text });
    } else if (step.type === 'alias') {
      // Only the exact symlink this migration created may be removed; absent is fine (finalize, earlier rollback).
      if (exists(step.path) && !isAliasTo(step.path, step.target)) {
        problems.push(`${step.path} is not the alias of this migration but ${kindOf(step.path)} — not removed`);
      }
    } else if (step.type === 'move') {
      // The old path is free only if it is absent or still this migration's alias — by what is on disk, not by the
      // journal (a pending alias step proves nothing about the object at that path now).
      const fromFree = !exists(step.from) || isAliasTo(step.from, step.to);
      if (!fromFree && !exists(step.to)) continue; // never moved (or already moved back)
      if (!fromFree) problems.push(`cannot move back: ${step.from} is ${kindOf(step.from)}, not the alias of this migration`);
      else if (!exists(step.to)) problems.push(`cannot move back: ${step.to} is missing`);
    }
  }
  if (problems.length > 0) throw new MigrationError(`rollback refused — nothing was changed:\n  ${problems.join('\n  ')}`);
  if (dryRun) {
    for (const step of pending) {
      log(`would ${step.type === 'alias' ? `remove alias ${step.path}` : step.type === 'rewrite' ? `restore the migrated lines of ${step.file} (other content kept)` : `move ${step.to} → ${step.from}`}`);
    }
    log(`rollback check passed: ${String(pending.length)} step(s); nothing changed (--dry-run)`);
    return state;
  }

  // Every destructive step re-checks its precondition right before acting: an object that appeared after the checks
  // is never removed or renamed over. A change during the run stops it; completed steps stay journaled.
  const changedDuring = (what) => new MigrationError(`${what} — changed during the rollback; stopped without touching it. Completed steps are journaled: check the object's origin, keep its data, then run the rollback again (DEPLOYMENT)`);
  for (const step of pending) {
    beforeStep?.(step);
    if (step.type === 'alias') {
      if (isAliasTo(step.path, step.target)) unlinkSync(step.path);
      else if (exists(step.path)) throw changedDuring(`${step.path} is not the alias of this migration but ${kindOf(step.path)}`);
      log(`↺ removed alias ${step.path}`);
    } else if (step.type === 'rewrite') {
      const plan = plans.get(step);
      beforeWrite?.(step.file);
      if (readFileSync(step.file, 'utf8') !== plan.current) {
        throw new MigrationError(`${step.file} changed during the rollback — not written; run the rollback again (completed steps are kept)`);
      }
      const st = statSync(step.file);
      writeAtomic(step.file, plan.text, { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid });
      log(`↺ restored the migrated lines of ${step.file} (other content kept)`);
    } else if (!exists(step.to) && exists(step.from) && !isAliasTo(step.from, step.to)) {
      log(`= ${step.from} was not moved (interrupted before the rename)`);
    } else {
      if (isAliasTo(step.from, step.to)) unlinkSync(step.from);
      // rename(2) would silently replace an empty directory or a file at the old path: never let it.
      if (exists(step.from)) throw changedDuring(`cannot move back: ${step.from} is ${kindOf(step.from)}`);
      renameSync(step.to, step.from);
      log(`↺ moved ${step.to} → ${step.from}`);
    }
    step.undone = true;
    saveState(stateFile, state);
  }
  state.status = 'rolled-back';
  state.rolledBackAt = new Date().toISOString();
  saveState(stateFile, state);
  return state;
}

/** Removes the temporary aliases of an applied migration (only symlinks that still point to the new path). */
export function finalizeMigration({ stateFile, log = () => undefined }) {
  const state = loadState(stateFile);
  if (!state || state.status !== 'applied') throw new MigrationError('finalize needs an applied migration state');
  for (const step of state.done) {
    if (step.type !== 'alias' || step.removed) continue;
    if (isAliasTo(step.path, step.target)) unlinkSync(step.path);
    else if (exists(step.path)) throw new MigrationError(`${step.path} is no longer the alias; left untouched`);
    step.removed = true;
    saveState(stateFile, state);
    log(`✓ removed temporary alias ${step.path}`);
  }
  state.finalizedAt = new Date().toISOString();
  saveState(stateFile, state);
  return state;
}
