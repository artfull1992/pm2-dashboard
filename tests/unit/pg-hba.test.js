import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HBA_RULE } from '../../scripts/lib/config.js';
import {
  ensureRule,
  formatRule,
  hasRule,
  parseHba,
  rulesForDatabase,
  scopedRuleErrors,
  weakRules,
} from '../../scripts/lib/pg-hba.js';

// Mirrors the active rules found on the server during the audit.
const SERVER_HBA = `# comment
local   all             postgres                                peer
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
local   replication     all                                     peer
host    replication     all             127.0.0.1/32            scram-sha-256

host    secrets-manager    secrets-manager    0.0.0.0/0    scram-sha-256   # trailing comment
host    secrets-manager    secrets-manager    ::/0         scram-sha-256
`;

test('parses local, host and commented lines', () => {
  const rules = parseHba(SERVER_HBA);
  assert.equal(rules.length, 8);
  assert.deepEqual(rules[0], { line: 2, type: 'local', database: 'all', user: 'postgres', address: null, method: 'peer', options: [] });
  assert.deepEqual(
    { ...rules[6], options: undefined },
    { line: 9, type: 'host', database: 'secrets-manager', user: 'secrets-manager', address: '0.0.0.0/0', method: 'scram-sha-256', options: undefined },
  );
});

test('parses address + netmask form, options and include directives', () => {
  const rules = parseHba('host db u 10.0.0.0 255.0.0.0 scram-sha-256 clientcert=verify-full\ninclude_dir extra.d\n');
  assert.equal(rules[0].address, '10.0.0.0 255.0.0.0');
  assert.equal(rules[0].method, 'scram-sha-256');
  assert.deepEqual(rules[0].options, ['clientcert=verify-full']);
  assert.deepEqual(rules[1], { line: 2, type: 'include_dir', target: 'extra.d' });
});

test('ensureRule appends the scoped rule once and keeps existing content', () => {
  const first = ensureRule(SERVER_HBA, HBA_RULE, 'test comment');
  assert.equal(first.changed, true);
  assert.ok(first.text.startsWith(SERVER_HBA));
  assert.ok(hasRule(first.text, HBA_RULE));
  assert.match(first.text, /# test comment\nhostssl\s+node_control_db\s+node_control_user\s+0\.0\.0\.0\/0\s+scram-sha-256\n$/);

  const second = ensureRule(first.text, HBA_RULE, 'test comment');
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('ensureRule handles a file without trailing newline', () => {
  const { text } = ensureRule('local all all peer', HBA_RULE);
  assert.equal(parseHba(text).length, 2);
});

test('formatRule round-trips through parseHba', () => {
  const [parsed] = parseHba(formatRule(HBA_RULE));
  assert.equal(parsed.type, HBA_RULE.type);
  assert.equal(parsed.address, HBA_RULE.address);
  assert.equal(parsed.method, HBA_RULE.method);
});

test('the project rule is scoped; broad or weak rules are not', () => {
  assert.deepEqual(scopedRuleErrors(HBA_RULE), []);
  const broad = parseHba('host all all 0.0.0.0/0 md5\nhost node_control_db +group 0.0.0.0/0 scram-sha-256\n');
  assert.equal(scopedRuleErrors(broad[0]).length, 4);
  assert.ok(scopedRuleErrors(broad[1]).some((e) => e.startsWith('user')));
  assert.ok(scopedRuleErrors({ ...HBA_RULE, type: 'host' }).some((e) => e.startsWith('type')));
  assert.ok(scopedRuleErrors({ ...HBA_RULE, database: 'a,b' }).some((e) => e.startsWith('database')));
});

test('rulesForDatabase and weakRules filter correctly', () => {
  const rules = parseHba(`${SERVER_HBA}host node_control_db,other x 1.2.3.4/32 trust\n`);
  assert.equal(rulesForDatabase(rules, 'secrets-manager').length, 2);
  assert.equal(rulesForDatabase(rules, 'node_control_db').length, 1);
  assert.equal(weakRules(rules).length, 1);
  assert.equal(weakRules(parseHba(SERVER_HBA)).length, 0);
});
