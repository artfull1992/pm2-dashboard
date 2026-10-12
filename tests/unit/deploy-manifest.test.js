import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assertRevision, buildManifest, listFiles, MANIFEST_FILE, verifyManifest } from '../../scripts/deploy/lib/manifest.js';

const REV = 'a'.repeat(40);
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function release(files = { 'package.json': '{}', 'backend/dist/main.js': 'console.log(1)' }) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-manifest-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(buildManifest(dir, { revision: REV })));
  return dir;
}

test('assertRevision accepts only full lowercase SHAs', () => {
  assert.equal(assertRevision(REV), REV);
  for (const bad of ['HEAD', 'abc123', 'A'.repeat(40), `${REV}0`, '', undefined]) {
    assert.throws(() => assertRevision(bad), TypeError, String(bad));
  }
});

test('manifest lists every file with its sha256 and verifies cleanly', () => {
  const dir = release();
  const manifest = buildManifest(dir, { revision: REV, createdAt: 'x', nodeVersion: 'v22' });
  assert.deepEqual(Object.keys(manifest.files), ['backend/dist/main.js', 'package.json']);
  assert.match(manifest.files['package.json'], /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyManifest(dir, REV), []);
});

test('node_modules is ignored when listing and verifying', () => {
  const dir = release();
  mkdirSync(join(dir, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pg', 'index.js'), '');
  assert.ok(!listFiles(dir).some((f) => f.startsWith('node_modules')));
  assert.deepEqual(verifyManifest(dir, REV), []);
});

test('detects revision mismatch, changed, missing and unexpected files', () => {
  const dir = release();
  writeFileSync(join(dir, 'package.json'), '{"tampered":true}');
  rmSync(join(dir, 'backend/dist/main.js'));
  writeFileSync(join(dir, '.env'), 'DB_PASS=x');
  const errors = verifyManifest(dir, 'b'.repeat(40));
  assert.deepEqual(errors.sort(), [
    'checksum mismatch: package.json',
    'manifest revision does not match the expected revision',
    'missing file: backend/dist/main.js',
    'unexpected file: .env',
  ]);
});

test('missing manifest is an error, not a crash', () => {
  const dir = release();
  rmSync(join(dir, MANIFEST_FILE));
  assert.deepEqual(verifyManifest(dir, REV), [`${MANIFEST_FILE} missing in ${dir}`]);
});

test('symlinks inside a release are rejected', () => {
  const dir = release();
  symlinkSync('/etc/passwd', join(dir, 'link'));
  assert.throws(() => listFiles(dir), /non-regular file/);
});
