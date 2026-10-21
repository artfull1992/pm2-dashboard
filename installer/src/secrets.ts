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
  /**
   * Raw mode: Ctrl+C (0x03) and Ctrl+D (0x04 — in raw mode it is a byte, not an "end" event) cancel, as does a real
   * EOF or a stream error; other control bytes are ignored (never part of a secret). Exactly one completion; the
   * previous terminal mode is restored and every listener added here is removed.
   */
  hidden(prompt) {
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      let value = '';
      let finished = false;
      process.stderr.write(prompt);
      const done = (error: Error | null) => {
        if (finished) return;
        finished = true;
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdin.removeListener('error', onEnd);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        process.stderr.write('\n');
        if (error) reject(error); else resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') { done(null); return; }
          if (ch === '\u0003' || ch === '\u0004') { done(new InputError('скасовано')); return; }
          if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
          if (CONTROL.test(ch)) continue;
          value += ch;
          if (value.length > 4096) { done(new InputError('ввід задовгий')); return; }
        }
      };
      const onEnd = () => { done(new InputError('скасовано')); };
      stdin.on('data', onData);
      stdin.once('end', onEnd);
      stdin.once('error', onEnd);
      stdin.setRawMode(true);
      stdin.resume();
    });
  },
};
