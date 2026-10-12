#!/usr/bin/env node
// Fails if anything committable contains a secret, or if .env is tracked / not ignored.
//   npm run check:secrets

import { PROJECT_ROOT } from './lib/config.js';
import { checkProject } from './lib/secrets.js';

const result = checkProject(PROJECT_ROOT);

for (const { file, line, pattern } of result.findings) {
  console.error(`[check:secrets] ${file}:${line} — ${pattern}`);
}
if (!result.envIgnored) console.error('[check:secrets] .env is not ignored by .gitignore');
if (result.envTracked) console.error('[check:secrets] .env is tracked by git — remove it with `git rm --cached .env`');

if (!result.ok) process.exit(1);
console.log(`[check:secrets] OK (${result.gitRepo ? 'git tracked + untracked files' : 'project files, no git repo'})`);
