import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codePoints, descriptionProblem, githubProblem, normalizeProjectInfo, PROJECT_INFO_LIMITS, projectUrlProblem } from '../src/servers/project-info.js';

// Rules of project information (ADR-036). The cases are shared with the frontend test (frontend/test/project-info.test.tsx):
// both implementations must accept and refuse exactly the same values.
interface Cases { github: { valid: string[]; invalid: string[] }; projectUrl: { valid: string[]; invalid: string[] }; description: { valid: string[]; invalid: string[] } }
const CASES = JSON.parse(readFileSync(new URL('./fixtures/project-info-cases.json', import.meta.url), 'utf8')) as Cases;

describe('shared cases', () => {
  it.each(CASES.github.valid)('GitHub accepted: %s', (v) => { expect(githubProblem(v)).toBeNull(); });
  it.each(CASES.github.invalid)('GitHub refused: %j', (v) => { expect(githubProblem(v)).not.toBeNull(); });
  it.each(CASES.projectUrl.valid)('project address accepted: %s', (v) => { expect(projectUrlProblem(v)).toBeNull(); });
  it.each(CASES.projectUrl.invalid)('project address refused: %j', (v) => { expect(projectUrlProblem(v)).not.toBeNull(); });
  it.each(CASES.description.valid)('description accepted: %j', (v) => { expect(descriptionProblem(v)).toBeNull(); });
  it.each(CASES.description.invalid)('description refused: %j', (v) => { expect(descriptionProblem(v)).toBe('invalid_text'); });
});

describe('limits (code points, like PostgreSQL char_length)', () => {
  it('URL up to 2048 code points; one more is too long', () => {
    const base = 'https://example.com/';
    const ok = base + 'a'.repeat(PROJECT_INFO_LIMITS.url - base.length);
    expect(projectUrlProblem(ok)).toBeNull();
    expect(projectUrlProblem(`${ok}a`)).toBe('too_long');
    const gh = 'https://github.com/o/';
    expect(githubProblem(gh + 'r'.repeat(PROJECT_INFO_LIMITS.url - gh.length + 1))).toBe('too_long');
  });
  it('description up to 2000 code points; astral characters count once', () => {
    expect(descriptionProblem('я'.repeat(2000))).toBeNull();
    expect(descriptionProblem('я'.repeat(2001))).toBe('too_long');
    const emoji = '😀'.repeat(2000); // 4000 UTF-16 units, 2000 code points
    expect(codePoints(emoji)).toBe(2000);
    expect(descriptionProblem(emoji)).toBeNull();
  });
});

describe('normalizeProjectInfo', () => {
  it('trims, converts CRLF/CR to LF, and turns empty values into null (clears the field)', () => {
    expect(normalizeProjectInfo({ githubUrl: '  https://github.com/o/r  ', projectUrl: '', description: '  a\r\nb\rc  ' }))
      .toEqual({ ok: true, value: { githubUrl: 'https://github.com/o/r', projectUrl: null, description: 'a\nb\nc' } });
    expect(normalizeProjectInfo({ githubUrl: null, projectUrl: '   ', description: '\n\n' }))
      .toEqual({ ok: true, value: { githubUrl: null, projectUrl: null, description: null } });
  });
  it('reports the field and problem of the first invalid value', () => {
    expect(normalizeProjectInfo({ githubUrl: 'https://gitlab.com/o/r', projectUrl: null, description: null })).toEqual({ ok: false, field: 'githubUrl', problem: 'invalid_github' });
    expect(normalizeProjectInfo({ githubUrl: null, projectUrl: 'javascript:alert(1)', description: null })).toEqual({ ok: false, field: 'projectUrl', problem: 'invalid_url' });
    expect(normalizeProjectInfo({ githubUrl: null, projectUrl: null, description: 'x'.repeat(2001) })).toEqual({ ok: false, field: 'description', problem: 'too_long' });
  });
});
