import { parseEnv } from 'node:util';

// KEY=VALUE files in the format the services read (Node util.parseEnv). The installer only ever ADDS missing keys:
// existing lines (credentials, tokens, operator edits, comments) are kept byte for byte. Values are never printed.

const VALUE_RE = /^[A-Za-z0-9_.:/+=@-]*$/;
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export function parseEnvText(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

/** A value safe to write unquoted (no spaces, quotes, #, newlines). */
export function assertEnvValue(key: string, value: string): void {
  if (!KEY_RE.test(key)) throw new Error(`invalid env key: ${key}`);
  if (!VALUE_RE.test(value)) throw new Error(`${key}: value contains characters that are not allowed`);
}

export function renderEnv(entries: readonly (readonly [string, string])[], header?: string): string {
  const lines = header ? [header] : [];
  for (const [key, value] of entries) {
    assertEnvValue(key, value);
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Keys of `wanted` that the file does not define (an empty value counts as defined: the operator chose it). */
export function missingKeys(text: string, wanted: readonly string[]): string[] {
  const present = parseEnvText(text);
  return wanted.filter((key) => !(key in present));
}

/** The text with the given entries appended (only keys that are missing); a missing final newline is added first. */
export function appendMissing(text: string, entries: readonly (readonly [string, string])[]): { text: string; added: string[] } {
  const missing = new Set(missingKeys(text, entries.map(([k]) => k)));
  const add = entries.filter(([k]) => missing.has(k));
  if (add.length === 0) return { text, added: [] };
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return { text: base + renderEnv(add), added: add.map(([k]) => k) };
}
