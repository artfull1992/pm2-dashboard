import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { applyMigration, MigrationError, parseMoves, planMigration, rollbackMigration } from '../../scripts/deploy/lib/path-migration.js';
import { runCli } from '../../scripts/deploy/migrate-paths.js';

// Review regressions (ADR-025): rollback must not overwrite configuration changed after the migration, and the
// migration's own metadata (state, backups) must never be moved or rewritten by that migration. Synthetic files only.

let root;
let p;
const OLD_TOKEN = 'SYNTHETIC_TOKEN_OLD_7781';
const NEW_TOKEN = 'SYNTHETIC_TOKEN_NEW_9902';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-pathrec-')));
  p = (rel) => join(root, rel);
  mkdirSync(p('etc/old-agent'), { recursive: true });
  writeFileSync(p('etc/old-agent/agent.env'), [
    '# agent config',
    `NC_AGENT_TOKEN=${OLD_TOKEN}`,
    `NC_AGENT_INVENTORY_FILE="${p('var/old-inv')}/inventory.json"`,
    `NC_AGENT_CONTROL_SOCKET=${p('run/old-broker')}/broker.sock`,
    'NC_AGENT_INTERVAL_SECONDS=30',
    '',
  ].join('\n'), { mode: 0o640 });
  chmodSync(p('etc/old-agent/agent.env'), 0o640);
  mkdirSync(p('var/old-inv'), { recursive: true });
  writeFileSync(p('var/old-inv/inventory.json'), '{}');
  mkdirSync(p('backup'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const env = () => readFileSync(p('etc/old-agent/agent.env'), 'utf8');
const newEnv = () => p('etc/new-agent/agent.env');
const spec = () => ({
  moves: parseMoves([`${p('etc/old-agent')}=${p('etc/new-agent')}`, `${p('var/old-inv')}=${p('var/new-inv')}`]),
  maps: parseMoves([`${p('run/old-broker')}=${p('run/new-broker')}`]),
  rewrites: [newEnv()],
});
const state = () => p('backup/state.json');
const apply = (extra = {}) => applyMigration({ ...spec(), backupDir: p('backup'), stateFile: state(), ...extra });
const edit = (fn) => { writeFileSync(newEnv(), fn(readFileSync(newEnv(), 'utf8'))); };
/** Every path and its type/mode/content under root (except the backup dir): proves "nothing changed". */
function tree(dir = root, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    out[full] = st.isDirectory() ? `dir ${String(st.mode & 0o7777)}` : `file ${String(st.mode & 0o7777)} ${readFileSync(full, 'utf8')}`;
    if (st.isDirectory()) tree(full, out);
  }
  return out;
}

// ---------------------------------------------------------------- P2: rollback must keep configuration changes

test('a token rotated after the migration survives rollback; only the migrated path lines are restored', () => {
  const original = env();
  apply();
  edit((t) => t.replace(OLD_TOKEN, NEW_TOKEN));
  rollbackMigration({ stateFile: state() });
  assert.equal(env(), original.replace(OLD_TOKEN, NEW_TOKEN));
  assert.equal(statSync(p('etc/old-agent/agent.env')).mode & 0o7777, 0o640);
});

test('independent keys added or removed after the migration are kept', () => {
  apply();
  edit((t) => t.replace('NC_AGENT_INTERVAL_SECONDS=30\n', '').concat('NC_AGENT_TIMEOUT_SECONDS=12\n'));
  rollbackMigration({ stateFile: state() });
  const after = env();
  assert.ok(after.includes('NC_AGENT_TIMEOUT_SECONDS=12'));
  assert.ok(!after.includes('NC_AGENT_INTERVAL_SECONDS'));
  assert.ok(after.includes(`NC_AGENT_INVENTORY_FILE="${p('var/old-inv')}/inventory.json"`));
  assert.ok(after.includes(`NC_AGENT_CONTROL_SOCKET=${p('run/old-broker')}/broker.sock`));
});

test('a migrated key changed by the operator is a conflict: refused before ANY rollback change, values never printed', () => {
  apply();
  edit((t) => t.replace(`${p('var/new-inv')}/inventory.json`, `${p('var/elsewhere')}/inventory.json`).replace(OLD_TOKEN, NEW_TOKEN));
  const before = tree();
  assert.throws(() => rollbackMigration({ stateFile: state() }), (e) => e instanceof MigrationError
    && /NC_AGENT_INVENTORY_FILE/.test(e.message) && /nothing was changed/.test(e.message)
    && !e.message.includes(NEW_TOKEN) && !e.message.includes(OLD_TOKEN) && !e.message.includes('elsewhere'));
  assert.deepEqual(tree(), before); // no move back, no rewrite: the layout is not mixed
});

test('without changes after apply the rollback restores the original exactly', () => {
  const original = env();
  apply();
  rollbackMigration({ stateFile: state() });
  assert.equal(env(), original);
  assert.ok(existsSync(p('var/old-inv/inventory.json')));
});

test('partial failure, changes in between, repeated rollback', () => {
  const original = env();
  assert.throws(() => apply({ failAfter: 3 }), /simulated failure after 3/);
  edit((t) => t.replace(OLD_TOKEN, NEW_TOKEN));
  rollbackMigration({ stateFile: state() });
  assert.equal(env(), original.replace(OLD_TOKEN, NEW_TOKEN));
  rollbackMigration({ stateFile: state() });
  assert.equal(env(), original.replace(OLD_TOKEN, NEW_TOKEN));
});

test('a file changed between the rollback check and its write is not overwritten', () => {
  apply();
  assert.throws(() => rollbackMigration({ stateFile: state(), beforeWrite: () => { edit((t) => t.replace(OLD_TOKEN, NEW_TOKEN)); } }),
    /changed during the rollback/);
  assert.ok(readFileSync(newEnv(), 'utf8').includes(NEW_TOKEN)); // the concurrent change is kept
  // A new rollback run sees the current content and completes.
  rollbackMigration({ stateFile: state() });
  assert.ok(env().includes(NEW_TOKEN));
  assert.ok(env().includes(`${p('var/old-inv')}/inventory.json`));
});

// State written by the previous tool version: rewrite steps have no recorded line changes and maps are unknown.
function legacyState() {
  apply();
  const s = JSON.parse(readFileSync(state(), 'utf8'));
  delete s.maps;
  for (const d of s.done) delete d.changes;
  writeFileSync(state(), JSON.stringify(s));
  return s;
}

test('state of the previous format: refused without the operator\'s maps, nothing changed', () => {
  legacyState();
  edit((t) => t.replace(OLD_TOKEN, NEW_TOKEN));
  const before = tree();
  assert.throws(() => rollbackMigration({ stateFile: state() }), /earlier version.*--legacy-map/s);
  assert.deepEqual(tree(), before);
});

test('state of the previous format: with the same maps as at apply, the changes are re-derived and verified; token kept', () => {
  const original = env();
  legacyState();
  edit((t) => t.replace(OLD_TOKEN, NEW_TOKEN));
  rollbackMigration({ stateFile: state(), legacyMaps: spec().maps });
  assert.equal(env(), original.replace(OLD_TOKEN, NEW_TOKEN));
});

test('state of the previous format: wrong maps or a missing backup are refused without changes', () => {
  legacyState();
  const before = tree();
  assert.throws(() => rollbackMigration({ stateFile: state(), legacyMaps: parseMoves([`${p('run/other')}=${p('run/new-broker')}`]) }), /nothing was changed/);
  const s = JSON.parse(readFileSync(state(), 'utf8'));
  rmSync(s.done.find((d) => d.type === 'rewrite').backup);
  assert.throws(() => rollbackMigration({ stateFile: state(), legacyMaps: spec().maps }), /backup .* missing/);
  const etcBefore = Object.fromEntries(Object.entries(before).filter(([k]) => k.startsWith(`${p('etc')}/`)));
  assert.deepEqual(tree(p('etc')), etcBefore); // config untouched by both refusals
});

// ---------------------------------------------------------------- P2: metadata placement

function refused(run) {
  const before = tree();
  assert.throws(run, (e) => e instanceof MigrationError && /metadata|state|backup/i.test(e.message));
  assert.deepEqual(tree(), before);
}

test('state or backup inside a move source or destination is refused before anything is created or moved', () => {
  rmSync(p('backup'), { recursive: true });
  refused(() => apply({ stateFile: p('etc/old-agent/state.json') }));
  refused(() => apply({ stateFile: p('etc/new-agent/state.json') }));
  refused(() => apply({ backupDir: p('var/old-inv/bk'), stateFile: p('var/old-inv/bk/state.json') }));
  refused(() => apply({ backupDir: p('var/new-inv/bk'), stateFile: p('state-outside.json') }));
  refused(() => apply({ backupDir: p('etc'), stateFile: p('etc/state.json') })); // backup dir containing a source
  assert.ok(!existsSync(p('backup')));
});

test('symlinks cannot hide an overlap; a state equal to a rewrite/alias target or a backup name is refused', () => {
  rmSync(p('backup'), { recursive: true });
  symlinkSync(p('etc/old-agent'), p('link-to-source'));
  refused(() => apply({ backupDir: p('link-to-source/bk'), stateFile: p('link-to-source/bk/state.json') }));
  refused(() => apply({ stateFile: newEnv() }));
  refused(() => apply({ aliases: [p('etc/old-agent')], stateFile: p('etc/old-agent') }));
  mkdirSync(p('backup'));
  refused(() => apply({ stateFile: p('backup/00-agent.env.orig') }));
});

test('plan checks metadata placement too when it is given; a state inside a separate backup dir is allowed', () => {
  assert.throws(() => runCli(['plan', '--move', `${p('etc/old-agent')}=${p('etc/new-agent')}`, '--state', p('etc/old-agent/state.json')], { log: () => undefined }), /state/);
  assert.ok(planMigration({ ...spec(), backupDir: p('backup'), stateFile: state() }).length > 0);
  apply();
  assert.ok(existsSync(state()));
  assert.equal(JSON.parse(readFileSync(state(), 'utf8')).status, 'applied');
});

test('rollback --dry-run only checks: nothing is written (not even the state), conflicts are still reported', () => {
  apply();
  edit((t) => t.replace(OLD_TOKEN, NEW_TOKEN));
  const before = tree();
  const out = [];
  runCli(['rollback', '--state', state(), '--dry-run'], { log: (m) => out.push(m) });
  assert.deepEqual(tree(), before);
  assert.ok(out.at(-1).includes('nothing changed'));
  assert.ok(out.every((l) => !l.includes(NEW_TOKEN) && !l.includes(OLD_TOKEN)));
  edit((t) => t.replace(`${p('var/new-inv')}/inventory.json`, `${p('var/x')}/inventory.json`));
  assert.throws(() => runCli(['rollback', '--state', state(), '--dry-run'], { log: () => undefined }), /NC_AGENT_INVENTORY_FILE/);
  legacyState2();
  assert.throws(() => runCli(['rollback', '--state', state(), '--dry-run'], { log: () => undefined }), /--legacy-map/);
});

function legacyState2() {
  const s = JSON.parse(readFileSync(state(), 'utf8'));
  delete s.maps;
  for (const d of s.done) delete d.changes;
  writeFileSync(state(), JSON.stringify(s));
}

