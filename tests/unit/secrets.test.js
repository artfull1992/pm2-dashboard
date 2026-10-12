import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { generatePassword } from '../../scripts/lib/password.js';
import { candidateFiles, checkProject, isEnvIgnored, scanText } from '../../scripts/lib/secrets.js';

// Sample secrets are assembled at runtime so this file itself never matches the scanner.
const KEY = 'DB_' + 'PASS';
const fakePassword = generatePassword();
const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-secrets-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const git = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

test('scanText allows placeholders', () => {
  for (const ok of [`${KEY}=`, `${KEY}=<generated_secure_password>`, `${KEY}=\${SECRET}`, 'postgresql://user:<password>@host/db', 'const x = env.' + KEY]) {
    assert.deepEqual(scanText(ok), [], ok);
  }
});

test('scanText flags real secrets without echoing them', () => {
  const text = [`${KEY}=${fakePassword}`, `postgres://u:${fakePassword}@h/db`, '-----BEGIN ' + 'PRIVATE KEY-----', 'SCRAM-SHA-256$' + '4096:abcdEFGH1234'].join('\n');
  const findings = scanText(text);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4]);
  assert.ok(!JSON.stringify(findings).includes(fakePassword));
});

test('scanText finds known secret values anywhere', () => {
  assert.deepEqual(scanText(`log: connecting with ${fakePassword}`, { knownSecrets: [fakePassword] }), [{ line: 1, pattern: 'known secret value' }]);
});

test('isEnvIgnored recognises .env patterns', () => {
  assert.equal(isEnvIgnored('node_modules/\n.env\n'), true);
  assert.equal(isEnvIgnored('/.env\n'), true);
  assert.equal(isEnvIgnored('.env.example\n'), false);
});

test('without git: walks files, skips .env and node_modules, uses .gitignore', () => {
  const dir = project({
    '.env': `${KEY}=${fakePassword}\n`,
    '.env.local': 'x',
    '.env.example': `${KEY}=\n`,
    '.gitignore': '.env\n',
    'node_modules/pkg/index.js': fakePassword,
    'src/app.js': 'ok',
  });
  assert.deepEqual(candidateFiles(dir).sort(), ['.env.example', '.gitignore', 'src/app.js']);
  assert.equal(checkProject(dir).ok, true);
});

test('without git: leaked password in a file fails the check', () => {
  const dir = project({ '.env': `${KEY}=${fakePassword}\n`, '.gitignore': '.env\n', 'docs/notes.md': `pass is ${fakePassword}` });
  const result = checkProject(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{ file: 'docs/notes.md', line: 1, pattern: 'known secret value' }]);
});

test('without git: missing .gitignore entry fails the check', () => {
  assert.equal(checkProject(project({ '.gitignore': 'node_modules/\n' })).envIgnored, false);
});

test('with git: tracked .env fails, ignored .env passes', () => {
  const dir = project({ '.env': `${KEY}=${fakePassword}\n`, '.gitignore': '.env\n', 'a.js': 'ok' });
  git(dir, 'init', '-q');
  let result = checkProject(dir);
  assert.equal(result.gitRepo, true);
  assert.equal(result.ok, true);

  git(dir, 'add', '-f', '.env');
  result = checkProject(dir);
  assert.equal(result.envTracked, true);
  assert.equal(result.ok, false);
});

test('TEST_DB_PASS assignments and the .env.test password are treated as secrets', () => {
  const testKey = 'TEST_DB_' + 'PASS';
  assert.equal(scanText(`${testKey}=${fakePassword}`).length, 1);
  assert.deepEqual(scanText(`${testKey}=`), []);
  const dir = project({ '.env.test': `${testKey}=${fakePassword}\n`, '.gitignore': '.env\n.env.*\n', 'notes.md': `x ${fakePassword}` });
  assert.deepEqual(checkProject(dir).findings, [{ file: 'notes.md', line: 1, pattern: 'known secret value' }]);
});
