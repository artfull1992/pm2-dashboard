import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readEnvFile } from './env.js';

// Placeholders like DB_PASS=, DB_PASS=<...> or ${...} are allowed; real values are not.
export const SECRET_PATTERNS = Object.freeze([
  { name: 'DB_PASS assignment', re: /^\s*(?:export\s+)?(?:TEST_)?DB_PASS\s*=\s*(?![<$#\s]|$)\S+/m },
  { name: 'connection URI with password', re: /postgres(?:ql)?:\/\/[^:\s/@]+:(?![<$*])[^@\s]+@/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'SCRAM verifier', re: /SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]{8,}/ },
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage']);
const SKIP_FILES = new Set(['.env']);

// Returns findings without the matched value, so reports never echo a secret.
export function scanText(text, { knownSecrets = [] } = {}) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) findings.push({ line: index + 1, pattern: name });
    }
    for (const secret of knownSecrets) {
      if (secret && line.includes(secret)) findings.push({ line: index + 1, pattern: 'known secret value' });
    }
  });
  return findings;
}

export function isEnvIgnored(gitignoreText) {
  return gitignoreText
    .split('\n')
    .map((line) => line.trim())
    .some((line) => ['.env', '/.env', '.env*', '/.env*'].includes(line));
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

export function isGitRepo(root) {
  const result = git(root, ['rev-parse', '--show-toplevel']);
  return result.status === 0 && realpathSync(result.stdout.trim()) === realpathSync(root);
}

function walk(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(root, path);
    if (!entry.isFile() || SKIP_FILES.has(entry.name) || entry.name.startsWith('.env.') && entry.name !== '.env.example') return [];
    return [relative(root, path)];
  });
}

// Files that are (or would be) committed: tracked + untracked-not-ignored. Without git: all project files.
export function candidateFiles(root) {
  if (!isGitRepo(root)) return walk(root);
  const result = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split('\0').filter((file) => file && existsSync(join(root, file)));
}

export function checkProject(root) {
  const knownSecrets = [readEnvFile(join(root, '.env')).DB_PASS, readEnvFile(join(root, '.env.test')).TEST_DB_PASS].filter(Boolean);
  const findings = [];

  for (const file of candidateFiles(root)) {
    const path = join(root, file);
    if (statSync(path).size > 1024 * 1024) continue;
    for (const finding of scanText(readFileSync(path, 'utf8'), { knownSecrets })) {
      findings.push({ file, ...finding });
    }
  }

  const gitRepo = isGitRepo(root);
  const gitignorePath = join(root, '.gitignore');
  const envIgnored = gitRepo
    ? git(root, ['check-ignore', '-q', '.env']).status === 0
    : existsSync(gitignorePath) && isEnvIgnored(readFileSync(gitignorePath, 'utf8'));
  const envTracked = gitRepo && git(root, ['ls-files', '--error-unmatch', '.env']).status === 0;

  return { gitRepo, findings, envIgnored, envTracked, ok: findings.length === 0 && envIgnored && !envTracked };
}
