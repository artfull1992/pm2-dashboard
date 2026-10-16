import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { applyMigration, finalizeMigration, MigrationError, parseMoves, rollbackMigration } from '../../scripts/deploy/lib/path-migration.js';

// Review regression (ADR-025): rollback must check the ACTUAL object at an alias path before changing anything. Only
// the exact symlink this migration created may be removed; anything else there is a conflict found before any
// unlink/rewrite/rename/state write. Synthetic files in temp dirs only.

let root;
let p;
const TOKEN = 'SYNTHETIC_ALIAS_TOKEN_3141';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-pathalias-')));
  p = (rel) => join(root, rel);
  mkdirSync(p('opt/old-app/releases/r1'), { recursive: true });
  writeFileSync(p('opt/old-app/releases/r1/main.js'), 'code');
  mkdirSync(p('etc/old-app'), { recursive: true });
  writeFileSync(p('etc/old-app/app.env'), `TOKEN=${TOKEN}\nAPP_HOME=${p('opt/old-app')}/current\n`);
  mkdirSync(p('etc/old-other'), { recursive: true });
  writeFileSync(p('etc/old-other/other.env'), `OTHER_HOME=${p('opt/old-app')}/data\n`);
  mkdirSync(p('foreign/target'), { recursive: true });
  writeFileSync(p('foreign/target/keep.txt'), 'foreign data');
  mkdirSync(p('backup'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const STATE = () => p('backup/state.json');
const spec = () => ({
  moves: parseMoves([`${p('opt/old-app')}=${p('opt/new-app')}`, `${p('etc/old-app')}=${p('etc/new-app')}`, `${p('etc/old-other')}=${p('etc/new-other')}`]),
  rewrites: [p('etc/new-app/app.env'), p('etc/new-other/other.env')],
  aliases: [p('opt/old-app')],
});
const apply = () => applyMigration({ ...spec(), backupDir: p('backup'), stateFile: STATE() });

/** Everything under root by lstat: symlinks are recorded with their target text, never followed. */
function tree(dir = root, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) out[full] = `link ${readlinkSync(full)}`;
    else if (st.isDirectory()) { out[full] = `dir ${String(st.mode & 0o7777)}`; tree(full, out); }
    else out[full] = `file ${String(st.mode & 0o7777)} ${readFileSync(full, 'utf8')}`;
  }
  return out;
}

const REPLACEMENTS = {
  'a non-empty directory': () => { mkdirSync(p('opt/old-app')); writeFileSync(p('opt/old-app/foreign.txt'), 'someone else'); },
  'an empty directory': () => { mkdirSync(p('opt/old-app')); },
  'a regular file': () => { writeFileSync(p('opt/old-app'), 'a file'); },
  'a symlink to another existing path': () => { symlinkSync(p('foreign/target'), p('opt/old-app')); },
  'a dangling symlink to another target': () => { symlinkSync(p('nowhere/else'), p('opt/old-app')); },
};

for (const [what, replace] of Object.entries(REPLACEMENTS)) {
  test(`alias replaced by ${what}: dry-run and rollback refuse before any change`, () => {
    apply();
    unlinkSync(p('opt/old-app'));
    replace();
    const before = tree();
    const stateBytes = readFileSync(STATE());
    for (const dryRun of [true, false]) {
      assert.throws(() => rollbackMigration({ stateFile: STATE(), dryRun }), (e) => e instanceof MigrationError
        && /nothing was changed/.test(e.message) && e.message.includes(p('opt/old-app')) && /not the alias/.test(e.message)
        && !e.message.includes(TOKEN));
      assert.deepEqual(tree(), before); // env, layout, modes, foreign objects — all unchanged
      assert.deepEqual(readFileSync(STATE()), stateBytes);
    }
    assert.equal(readFileSync(p('foreign/target/keep.txt'), 'utf8'), 'foreign data');
  });
}

test('the expected alias: normal rollback', () => {
  const env = readFileSync(p('etc/old-app/app.env'), 'utf8');
  apply();
  assert.ok(lstatSync(p('opt/old-app')).isSymbolicLink());
  rollbackMigration({ stateFile: STATE() });
  assert.ok(lstatSync(p('opt/old-app')).isDirectory());
  assert.equal(readFileSync(p('opt/old-app/releases/r1/main.js'), 'utf8'), 'code');
  assert.equal(readFileSync(p('etc/old-app/app.env'), 'utf8'), env);
});

test('alias already removed by finalize: rollback works', () => {
  apply();
  finalizeMigration({ stateFile: STATE() });
  assert.ok(!existsSync(p('opt/old-app')));
  rollbackMigration({ stateFile: STATE(), dryRun: true });
  rollbackMigration({ stateFile: STATE() });
  assert.ok(existsSync(p('opt/old-app/releases/r1/main.js')));
});

test('interrupted rollback after the alias was removed: the next run continues; a repeated run is idempotent; token kept', () => {
  apply();
  writeFileSync(p('etc/new-app/app.env'), readFileSync(p('etc/new-app/app.env'), 'utf8').replace(TOKEN, `${TOKEN}_ROTATED`));
  assert.throws(() => rollbackMigration({ stateFile: STATE(), beforeStep: (s) => { if (s.type === 'rewrite') throw new MigrationError('simulated crash'); } }), /simulated crash/);
  assert.ok(!existsSync(p('opt/old-app'))); // alias removed, nothing else done
  rollbackMigration({ stateFile: STATE() });
  assert.ok(existsSync(p('opt/old-app/releases/r1/main.js')));
  assert.ok(readFileSync(p('etc/old-app/app.env'), 'utf8').includes(`${TOKEN}_ROTATED`));
  const after = tree();
  rollbackMigration({ stateFile: STATE() });
  assert.deepEqual(tree(), after);
});

test('a conflicting alias is found before the other env files are rewritten', () => {
  apply();
  const envs = [readFileSync(p('etc/new-app/app.env')), readFileSync(p('etc/new-other/other.env'))];
  unlinkSync(p('opt/old-app'));
  mkdirSync(p('opt/old-app'));
  assert.throws(() => rollbackMigration({ stateFile: STATE() }), /not the alias/);
  assert.deepEqual([readFileSync(p('etc/new-app/app.env')), readFileSync(p('etc/new-other/other.env'))], envs);
});

test('state of the earlier format with an alias: still supported when the alias is intact', () => {
  apply();
  const s = JSON.parse(readFileSync(STATE(), 'utf8'));
  delete s.maps;
  for (const d of s.done) delete d.changes;
  writeFileSync(STATE(), JSON.stringify(s));
  rollbackMigration({ stateFile: STATE(), legacyMaps: [] });
  assert.ok(lstatSync(p('opt/old-app')).isDirectory());
  assert.ok(readFileSync(p('etc/old-app/app.env'), 'utf8').includes(`${p('opt/old-app')}/current`));
});

test('alias replaced AFTER the checks: the foreign object is not removed (refused at that step, journal correct)', () => {
  apply();
  assert.throws(() => rollbackMigration({ stateFile: STATE(), beforeStep: (s) => {
    if (s.type === 'alias') { unlinkSync(p('opt/old-app')); mkdirSync(p('opt/old-app')); }
  } }), (e) => /changed during the rollback/.test(e.message) && /not the alias/.test(e.message));
  assert.ok(lstatSync(p('opt/old-app')).isDirectory()); // the empty foreign directory is still there
  const s = JSON.parse(readFileSync(STATE(), 'utf8'));
  assert.ok(s.done.every((d) => !d.undone));
});

test('source replaced right before the move back: never renamed over it (an empty directory would otherwise vanish)', () => {
  apply();
  finalizeMigration({ stateFile: STATE() });
  assert.throws(() => rollbackMigration({ stateFile: STATE(), beforeStep: (s) => {
    if (s.type === 'move' && s.from === p('opt/old-app')) mkdirSync(p('opt/old-app'));
  } }), /changed during the rollback/);
  assert.ok(lstatSync(p('opt/old-app')).isDirectory());
  assert.deepEqual(readdirSync(p('opt/old-app')), []);
  assert.ok(existsSync(p('opt/new-app/releases/r1/main.js'))); // the data stays where it was
  const s = JSON.parse(readFileSync(STATE(), 'utf8'));
  assert.ok(s.done.filter((d) => d.undone).every((d) => d.type !== 'move' || d.from !== p('opt/old-app')));
});
