// Project information of an application (ADR-036): validation and normalisation of the three reference fields.
// The same rules are implemented in the frontend (frontend/src/components/projectInfoRules.ts); both are covered by tests
// with the same cases. The values are only ever stored and shown as links/plain text — the API never fetches,
// previews or checks them.

export const PROJECT_INFO_LIMITS = Object.freeze({ url: 2048, description: 2000 });

/** https://github.com/<owner>/<repository>[.git][/] — exact lower-case host, no credentials, port, query or fragment. */
const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/?$/;
// Characters that never belong in a link we render: whitespace, C0/C1 controls, backslash (parsers treat it as "/").
// eslint-disable-next-line no-control-regex
const URL_FORBIDDEN_RE = /[\s\u0000-\u001f\u007f-\u009f\\]/;
// Plain-text description: line breaks and tabs are kept, other control characters are refused.
// eslint-disable-next-line no-control-regex
const DESCRIPTION_FORBIDDEN_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Length in code points (what PostgreSQL char_length and JSON Schema maxLength count), not UTF-16 units. */
export const codePoints = (value: string) => Array.from(value).length;

export type FieldProblem = 'too_long' | 'invalid_github' | 'invalid_url' | 'invalid_text';

export function githubProblem(value: string): FieldProblem | null {
  if (codePoints(value) > PROJECT_INFO_LIMITS.url) return 'too_long';
  if (!GITHUB_RE.test(value)) return 'invalid_github';
  const repository = value.replace(/\/$/, '').split('/')[4] ?? '';
  return repository === '.' || repository === '..' || repository === '.git' ? 'invalid_github' : null;
}

export function projectUrlProblem(value: string): FieldProblem | null {
  if (codePoints(value) > PROJECT_INFO_LIMITS.url) return 'too_long';
  // The authority must follow the scheme directly («https:///x» would be parsed as host «x»).
  if (!/^https?:\/\/[^/?#]/.test(value) || URL_FORBIDDEN_RE.test(value)) return 'invalid_url';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid_url';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.username !== '' || url.password !== '') return 'invalid_url';
  return null;
}

export function descriptionProblem(value: string): FieldProblem | null {
  if (codePoints(value) > PROJECT_INFO_LIMITS.description) return 'too_long';
  return DESCRIPTION_FORBIDDEN_RE.test(value) ? 'invalid_text' : null;
}

export interface ProjectInfoFields { githubUrl: string | null; projectUrl: string | null; description: string | null }
export const FIELD_NAMES = ['githubUrl', 'projectUrl', 'description'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/**
 * Input → stored form: URLs trimmed, the description with CRLF/CR → LF and outer whitespace trimmed; an empty value
 * (or null) clears the field. Returns the first problem instead when a value is not acceptable.
 */
export function normalizeProjectInfo(input: { githubUrl: string | null; projectUrl: string | null; description: string | null }):
  { ok: true; value: ProjectInfoFields } | { ok: false; field: FieldName; problem: FieldProblem } {
  const githubUrl = input.githubUrl?.trim() ?? '';
  const projectUrl = input.projectUrl?.trim() ?? '';
  const description = (input.description ?? '').replace(/\r\n?/g, '\n').trim();
  const g = githubUrl === '' ? null : githubProblem(githubUrl);
  if (g) return { ok: false, field: 'githubUrl', problem: g };
  const u = projectUrl === '' ? null : projectUrlProblem(projectUrl);
  if (u) return { ok: false, field: 'projectUrl', problem: u };
  const d = description === '' ? null : descriptionProblem(description);
  if (d) return { ok: false, field: 'description', problem: d };
  return { ok: true, value: { githubUrl: githubUrl || null, projectUrl: projectUrl || null, description: description || null } };
}
