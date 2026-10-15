import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  applyMigration, finalizeMigration, MigrationError, parseMoves, planMigration, rewriteText, rollbackMigration,
} from '../../scripts/deploy/lib/path-migration.js';
import { runCli } from '../../scripts/deploy/migrate-paths.js';

// Path migration of an installed host, simulated in a temp directory (same filesystem). Old and new names are
// arbitrary here: the tool knows no product names.

let root;
let p;
const SECRET = 'SYNTHETIC_TOKEN_VALUE_5521';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-pathmig-')));
  p = (rel) => join(root, rel);
  // An installation laid out with "old-*" names.
  mkdirSync(p('opt/old-app/releases/abc'), { recursive: true });
  writeFileSync(p('opt/old-app/releases/abc/main.js'), 'code');
  symlinkSync('releases/abc', p('opt/old-app/current'));
  mkdirSync(p('etc/old-app'), { recursive: true, mode: 0o750 });
  chmodSync(p('etc/old-app'), 0o750);
  writeFileSync(p('etc/old-app/agent.env'), `NC_AGENT_TOKEN=${SECRET}\nNC_AGENT_INVENTORY_FILE=${p('var/old-inv')}/inventory.json\nNC_AGENT_CONTROL_SOCKET=${p('run/old-broker')}/broker.sock\nOTHER=${p('var/old-inv-extra')}/x\n`, { mode: 0o640 });
  chmodSync(p('etc/old-app/agent.env'), 0o640);
  mkdirSync(p('var/old-inv'), { recursive: true });
  chmodSync(p('var/old-inv'), 0o2750);
  writeFileSync(p('var/old-inv/inventory.json'), '{}');
  mkdirSync(p('var/old-journal'), { recursive: true });
  chmodSync(p('var/old-journal'), 0o700);
  writeFileSync(p('var/old-journal/cmd-1.json'), '{"started":true}');
  mkdirSync(p('opt/new-parent'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const spec = () => ({
  moves: parseMoves([
    `${p('opt/old-app')}=${p('opt/new-app')}`, `${p('etc/old-app')}=${p('etc/new-app')}`,
    `${p('var/old-inv')}=${p('var/new-inv')}`, `${p('var/old-journal')}=${p('var/new-journal')}`,
  ]),
  rewrites: [p('etc/new-app/agent.env')],
});
const run = (extra = {}) => applyMigration({ ...spec(), backupDir: p('backup'), stateFile: p('backup/state.json'), ...extra });
const snapshot = () => ({
  app: readFileSync(p('opt/old-app/current/main.js'), 'utf8'), env: readFileSync(p('etc/old-app/agent.env'), 'utf8'),
  envMode: statSync(p('etc/old-app/agent.env')).mode & 0o7777, inv: statSync(p('var/old-inv')).mode & 0o7777,
  journal: readFileSync(p('var/old-journal/cmd-1.json'), 'utf8'), journalMode: statSync(p('var/old-journal')).mode & 0o7777,
});

test('plan is read-only and lists pending steps with the keys a rewrite would change', () => {
  const before = snapshot();
  const steps = planMigration(spec());
  assert.deepEqual(steps.map((s) => `${s.type}:${s.state}`), ['move:pending', 'move:pending', 'move:pending', 'move:pending', 'rewrite:pending']);
  assert.deepEqual(steps.at(-1).keys, ['NC_AGENT_INVENTORY_FILE']);
  assert.deepEqual(snapshot(), before);
  assert.ok(!existsSync(p('opt/new-app')));
});

test('apply renames in place (contents, modes, relative release symlink, journal) and rewrites only path references', () => {
  const before = snapshot();
  const logs = [];
  run({ log: (m) => logs.push(m) });
  assert.ok(!existsSync(p('opt/old-app')) && !existsSync(p('etc/old-app')));
  assert.equal(readFileSync(p('opt/new-app/current/main.js'), 'utf8'), before.app);
  assert.equal(readlinkSync(p('opt/new-app/current')), 'releases/abc');
  assert.equal(statSync(p('var/new-inv')).mode & 0o7777, 0o2750);
  assert.equal(statSync(p('var/new-journal')).mode & 0o7777, 0o700);
  assert.equal(readFileSync(p('var/new-journal/cmd-1.json'), 'utf8'), before.journal);
  const env = readFileSync(p('etc/new-app/agent.env'), 'utf8');
  assert.match(env, new RegExp(`NC_AGENT_TOKEN=${SECRET}`)); // untouched
  assert.ok(env.includes(`NC_AGENT_INVENTORY_FILE=${p('var/new-inv')}/inventory.json`));
  assert.ok(env.includes(`NC_AGENT_CONTROL_SOCKET=${p('run/old-broker')}/broker.sock`)); // not in the moves
  assert.ok(env.includes(`OTHER=${p('var/old-inv-extra')}/x`)); // a different path that merely shares a prefix
  assert.equal(statSync(p('etc/new-app/agent.env')).mode & 0o7777, before.envMode);
  // The original is kept in the backup (0600); logs name keys, never values.
  const state = JSON.parse(readFileSync(p('backup/state.json'), 'utf8'));
  const rewrite = state.done.find((d) => d.type === 'rewrite');
  assert.equal(readFileSync(rewrite.backup, 'utf8'), before.env);
  assert.equal(statSync(rewrite.backup).mode & 0o777, 0o600);
  assert.equal(statSync(p('backup')).mode & 0o777, 0o700);
  assert.equal(state.status, 'applied');
  assert.ok(state.done.every((d) => d.complete));
  assert.ok(logs.some((l) => l.includes('keys: NC_AGENT_INVENTORY_FILE')));
  assert.ok(logs.every((l) => !l.includes(SECRET)));
});

test('a repeated apply changes nothing (idempotent)', () => {
  run();
  const after = readFileSync(p('etc/new-app/agent.env'), 'utf8');
  const steps = planMigration(spec());
  assert.ok(steps.every((s) => s.state === 'done'));
  run();
  assert.equal(readFileSync(p('etc/new-app/agent.env'), 'utf8'), after);
  assert.equal(JSON.parse(readFileSync(p('backup/state.json'), 'utf8')).done.length, 5);
});

test('an existing destination stops everything before any change (nothing overwritten)', () => {
  mkdirSync(p('var/new-journal'));
  writeFileSync(p('var/new-journal/foreign'), 'keep');
  const before = snapshot();
  assert.throws(() => run(), (e) => e instanceof MigrationError && /conflict: both .*old-journal and .*new-journal exist/.test(e.message) && /nothing was changed/.test(e.message));
  assert.deepEqual(snapshot(), before);
  assert.equal(readFileSync(p('var/new-journal/foreign'), 'utf8'), 'keep');
  assert.ok(!existsSync(p('backup/state.json')));
});

test('missing paths, symlinked sources, nested or invalid moves are refused', () => {
  assert.throws(() => planMigration({ moves: parseMoves([`${p('nope')}=${p('nope2')}`]) }), /missing: neither/);
  symlinkSync(p('var/old-inv'), p('var/link'));
  assert.throws(() => planMigration({ moves: parseMoves([`${p('var/link')}=${p('var/link2')}`]) }), /refusing to move a symlink/);
  assert.throws(() => planMigration({ moves: parseMoves([`${p('var/old-inv')}=${p('missing-parent/x')}`]) }), /parent directory/);
  assert.throws(() => parseMoves([`${p('a')}=${p('a/b')}`]), /nested/);
  assert.throws(() => parseMoves(['relative=/abs']), /absolute/);
  assert.throws(() => parseMoves(['/a/=/b']), /normalized/);
  assert.throws(() => parseMoves(['/a=/a']), /same/);
  assert.throws(() => parseMoves(['/a']), /OLD=NEW/);
  assert.throws(() => parseMoves([]), /at least one/);
  assert.throws(() => planMigration({ ...spec(), rewrites: [p('etc/new-app/missing.env')] }), /does not exist/);
});

test('partial failure: the journal has the completed steps and rollback restores the original layout exactly', () => {
  const before = snapshot();
  assert.throws(() => run({ failAfter: 3 }), /simulated failure after 3/);
  const state = JSON.parse(readFileSync(p('backup/state.json'), 'utf8'));
  assert.equal(state.status, 'in-progress');
  assert.equal(state.done.length, 3);
  rollbackMigration({ stateFile: p('backup/state.json') });
  assert.deepEqual(snapshot(), before);
  assert.ok(!existsSync(p('opt/new-app')) && !existsSync(p('var/new-inv')));
  // Repeating the rollback is a no-op; a rolled-back state cannot be applied again.
  rollbackMigration({ stateFile: p('backup/state.json') });
  assert.deepEqual(snapshot(), before);
  assert.throws(() => run(), /rolled back/);
});

test('full rollback after apply restores moved data and the rewritten file (content, mode)', () => {
  const before = snapshot();
  run();
  rollbackMigration({ stateFile: p('backup/state.json') });
  assert.deepEqual(snapshot(), before);
});

test('a crash between journaling and the rename is recovered: rollback sees the step was never executed', () => {
  const before = snapshot();
  mkdirSync(p('backup'), { mode: 0o700 });
  writeFileSync(p('backup/state.json'), JSON.stringify({ version: 1, status: 'in-progress', moves: spec().moves, done: [{ type: 'move', from: p('opt/old-app'), to: p('opt/new-app'), complete: false }] }));
  rollbackMigration({ stateFile: p('backup/state.json') });
  assert.deepEqual(snapshot(), before);
});

test('temporary aliases: created on request, resolve to the new path, removed by finalize only while still aliases', () => {
  run({ aliases: [p('opt/old-app')] });
  assert.ok(lstatSync(p('opt/old-app')).isSymbolicLink());
  assert.equal(readFileSync(p('opt/old-app/current/main.js'), 'utf8'), 'code');
  finalizeMigration({ stateFile: p('backup/state.json') });
  assert.ok(!existsSync(p('opt/old-app')));
  assert.ok(existsSync(p('opt/new-app/current/main.js')));
  finalizeMigration({ stateFile: p('backup/state.json') }); // repeatable
  // Rollback after finalize still moves everything back.
  rollbackMigration({ stateFile: p('backup/state.json') });
  assert.ok(existsSync(p('opt/old-app/current/main.js')));
});

test('finalize leaves a path alone if it is no longer the alias; alias must belong to a move', () => {
  run({ aliases: [p('opt/old-app')] });
  rmSync(p('opt/old-app'));
  mkdirSync(p('opt/old-app'));
  assert.throws(() => finalizeMigration({ stateFile: p('backup/state.json') }), /no longer the alias/);
  assert.ok(existsSync(p('opt/old-app')));
  assert.throws(() => planMigration({ ...spec(), aliases: [p('unrelated')] }), /not the old path of a move/);
});

test('state file of another migration is refused', () => {
  run();
  assert.throws(() => applyMigration({ moves: parseMoves([`${p('opt/new-app')}=${p('opt/third')}`]), backupDir: p('backup'), stateFile: p('backup/state.json') }), /another migration/);
});

test('rewriteText matches whole path components only and reports keys', () => {
  const moves = parseMoves(['/opt/a=/opt/b']);
  const { text, changedKeys } = rewriteText('X=/opt/a/x\nY=/opt/ab/x\nZ="/opt/a"\n# /opt/a comment\n', moves);
  assert.equal(text, 'X=/opt/b/x\nY=/opt/ab/x\nZ="/opt/b"\n# /opt/b comment\n');
  assert.deepEqual(changedKeys, ['X', 'Z', 'line 4']);
});

test('CLI: plan prints the steps and changes nothing; usage errors are explicit', () => {
  const out = [];
  runCli(['plan', '--move', `${p('opt/old-app')}=${p('opt/new-app')}`], { log: (m) => out.push(m) });
  assert.ok(out.some((l) => l.includes('+ move')));
  assert.ok(out.at(-1).includes('1 pending'));
  assert.ok(existsSync(p('opt/old-app')));
  assert.throws(() => runCli(['apply', '--move', `${p('opt/old-app')}=${p('opt/new-app')}`]), /--backup-dir is required/);
  assert.throws(() => runCli(['bogus']), /usage/);
  assert.throws(() => runCli(['plan', 'extra', '--move', '/a=/b']), /unexpected/);
});

test('--map rewrites references to a path that is not moved (runtime socket); rollback restores the file', () => {
  const env = readFileSync(p('etc/old-app/agent.env'), 'utf8');
  const out = [];
  runCli(['apply', '--move', `${p('etc/old-app')}=${p('etc/new-app')}`, '--map', `${p('run/old-broker')}=${p('run/new-broker')}`,
    '--rewrite', p('etc/new-app/agent.env'), '--backup-dir', p('backup'), '--state', p('backup/state.json')], { log: (m) => out.push(m) });
  const after = readFileSync(p('etc/new-app/agent.env'), 'utf8');
  assert.ok(after.includes(`NC_AGENT_CONTROL_SOCKET=${p('run/new-broker')}/broker.sock`));
  assert.ok(after.includes(`NC_AGENT_INVENTORY_FILE=${p('var/old-inv')}/inventory.json`)); // not moved in this run
  assert.ok(!existsSync(p('run/new-broker')));
  assert.ok(out.every((l) => !l.includes(SECRET)));
  runCli(['rollback', '--state', p('backup/state.json')], { log: () => undefined });
  assert.equal(readFileSync(p('etc/old-app/agent.env'), 'utf8'), env);
  assert.throws(() => runCli(['plan', '--move', `${p('etc/old-app')}=${p('etc/new-app')}`, '--map', `${p('etc/old-app')}=${p('x')}`]), /duplicates a --move/);
});
