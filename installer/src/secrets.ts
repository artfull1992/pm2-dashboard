import type { Host } from './host.js';
import { InputError } from './validate.js';

// Secrets never come from argv (visible in the process list) or environment variables. Sources: a protected file
// (root-owned, no group/other access), stdin (automation), or a hidden prompt on the terminal. Values never leave
// this module except into the file they are written to.

/** Errors (empty = acceptable) for a secret input file: regular file, owned by root, mode without group/other bits. */
export function secretFileProblems(host: Host, path: string): string[] {
  const info = host.stat(path);
  if (!info) return [`${path} не знайдено`];
  if (info.kind !== 'file') return [`${path} має бути звичайним файлом (не symlink)`];
  const problems: string[] = [];
  if (info.uid !== 0) problems.push(`${path} має належати root`);
  if ((info.mode & 0o077) !== 0) problems.push(`${path} доступний групі/іншим — chmod 600 ${path}`);
  return problems;
}

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL = /[\0-\x1f\x7f]/;

/** One line (trailing newline removed); no other control characters. */
export function singleLine(text: string, what: string): string {
  const value = text.endsWith('\n') ? text.slice(0, -1).replace(/\r$/, '') : text;
  if (value === '' || CONTROL.test(value)) throw new InputError(`${what}: очікується один рядок без керівних символів`);
  return value;
}

export interface SecretInput {
  isTTY: boolean;
  /** Whole stdin (bounded). */
  readAll(): Promise<string>;
  /** Prompt on stderr, input not echoed. */
  hidden(prompt: string): Promise<string>;
}

const MAX_STDIN = 64 * 1024;

export const processInput: SecretInput = {
  isTTY: process.stdin.isTTY,
  readAll() {
    return new Promise((resolve, reject) => {
      let text = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > MAX_STDIN) { process.stdin.pause(); reject(new InputError('stdin: забагато даних')); }
      });
      process.stdin.on('end', () => { resolve(text); });
      process.stdin.on('error', () => { reject(new InputError('stdin: помилка читання')); });
    });
  },
  hidden(prompt) {
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      let value = '';
      process.stderr.write(prompt);
      const done = (error: Error | null) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        if (error) reject(error); else resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') { done(null); return; }
          if (ch === '\u0003') { done(new InputError('скасовано')); return; }
          if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
          value += ch;
          if (value.length > 4096) { done(new InputError('ввід задовгий')); return; }
        }
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    });
  },
};
