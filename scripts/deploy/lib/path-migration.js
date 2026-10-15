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
//  * optional aliases (old path → symlink to the new one) are temporary and removed by `finalizeMigration`;
//  * `maps` are reference-only renames (nothing is moved), e.g. a systemd RuntimeDirectory under /run that the unit
//    re-creates under its new name: only the references inside the rewritten files change.

import {
  chmodSync, chownSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync,
  renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

export class MigrationError extends Error {}

const exists = (path) => {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
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

/** Read-only preflight: what would happen; throws on any conflict before anything is changed. */
export function planMigration({ moves, maps = [], rewrites = [], aliases = [] }) {
  const references = [...moves, ...maps];
  const steps = [];
  const problems = [];
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
  if (!isAbsolute(backupDir) || !isAbsolute(stateFile)) throw new MigrationError('--backup-dir and --state must be absolute');
  const steps = planMigration({ moves, maps, rewrites, aliases });
  const previous = loadState(stateFile);
  const state = previous ?? { version: 1, startedAt: new Date().toISOString(), moves, backupDir, done: [] };
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

/** Undoes the recorded steps in reverse order; safe to repeat. Live data stays — moves are renamed back. */
export function rollbackMigration({ stateFile, log = () => undefined }) {
  const state = loadState(stateFile);
  if (!state) throw new MigrationError(`no state file: ${stateFile}`);
  for (const step of [...state.done].reverse()) {
    if (step.undone) continue;
    if (step.type === 'alias') {
      if (isAliasTo(step.path, step.target)) unlinkSync(step.path);
      log(`↺ removed alias ${step.path}`);
    } else if (step.type === 'rewrite') {
      writeAtomic(step.file, readFileSync(step.backup, 'utf8'), { mode: step.mode, uid: step.uid, gid: step.gid });
      log(`↺ restored ${step.file} from backup`);
    } else if (!exists(step.to) && exists(step.from) && !isAliasTo(step.from, step.to)) {
      log(`= ${step.from} was not moved (interrupted before the rename)`);
    } else {
      if (exists(step.from) && !isAliasTo(step.from, step.to)) throw new MigrationError(`cannot move back: both ${step.from} and ${step.to} exist`);
      if (isAliasTo(step.from, step.to)) unlinkSync(step.from);
      if (!exists(step.to)) throw new MigrationError(`cannot move back: ${step.to} is missing`);
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
