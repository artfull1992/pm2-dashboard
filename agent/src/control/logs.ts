import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import type { AllowlistEntry } from './allowlist.js';
import { AllowlistError } from './allowlist.js';
import { matchEntry, type RawProcessView } from './identity.js';
import {
  LOG_LIMITS, type LogReason, type LogsRequest, type LogsResponse, type LogStream, type LogTarget, type LogTargetsResponse,
} from './logs-protocol.js';

// Bounded, read-only log tail for the broker (ADR-018). Paths come ONLY from the matched PM2 process metadata
// (pm_out_log_path / pm_err_log_path), must be normalized absolute regular files inside explicitly allowed
// directories, with no symlink anywhere in the path; the opened descriptor is re-checked (same inode, regular file).
// Only the last ≤ 256 KiB of each file is read. Text is sanitised and known credential formats are masked here,
// before anything leaves the managed server. Masking is best effort — it does not replace RBAC or the allowlist.

export interface LogDeps {
  loadAllowlist: () => Promise<AllowlistEntry[]>;
  list: () => Promise<unknown[]>;
  /** Allowed log directories (normalized, absolute, already resolved to their real path). */
  logDirs: readonly string[];
  now?: () => number;
}

type FileRead = { state: 'ok'; text: string; startedMidFile: boolean; size: number; mtime: Date } | { state: 'missing' | 'unavailable' };

const FORBIDDEN_ROOTS = /^\/(proc|sys|dev)(\/|$)/;

/** Allowed only if normalized, absolute, outside /proc /sys /dev and strictly inside one allowed directory. */
export function allowedLogPath(value: unknown, dirs: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return null;
  if (!isAbsolute(value) || normalize(value) !== value || value.endsWith('/') || FORBIDDEN_ROOTS.test(value)) return null;
  return dirs.some((d) => value.startsWith(`${d}/`)) ? value : null;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Reads the tail of one allowed log file. Never follows symlinks, never blocks on FIFOs, never writes. */
export async function readTail(path: string, maxBytes: number = LOG_LIMITS.tailBytes): Promise<FileRead> {
  let before: Stats;
  try {
    // realpath resolves every component: equality means no symlink anywhere in the path.
    if ((await realpath(path)) !== path) return { state: 'unavailable' };
    before = await lstat(path);
  } catch (error) {
    return { state: code(error) === 'ENOENT' ? 'missing' : 'unavailable' };
  }
  if (!before.isFile()) return { state: 'unavailable' };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: code(error) === 'ENOENT' ? 'missing' : 'unavailable' };
  }
  try {
    const opened = await handle.stat();
    // Swapped between the checks and open() (rotation or an attack): refuse this read.
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return { state: 'unavailable' };
    const size = opened.size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (bytesRead === 0) break; // truncated meanwhile: use what was read
      read += bytesRead;
    }
    const text = new TextDecoder('utf-8').decode(buffer.subarray(0, read));
    return { state: 'ok', text, startedMidFile: start > 0, size, mtime: opened.mtime };
  } catch {
    return { state: 'unavailable' };
  } finally {
    await handle.close();
  }
}

// --- text hygiene -------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- ANSI CSI / OSC / other escape sequences
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- remaining C0/C1 controls except TAB
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

export function sanitizeLine(line: string): string {
  const clean = line.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  if (clean.length <= LOG_LIMITS.maxLineChars) return clean;
  let cut = clean.slice(0, LOG_LIMITS.maxLineChars);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const MASK = '***';
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(authorization\s*[:=]\s*["']?)(bearer|basic|token)\s+[^\s"',;]+/gi, `$1$2 ${MASK}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `$1 ${MASK}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, `${MASK}jwt${MASK}`],
  [/\bncag_[A-Za-z0-9_-]{20,}/g, `ncag_${MASK}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, `${MASK}aws-key${MASK}`],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth)["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi, `$1${MASK}`],
];

/** Masks known credential formats in one line (best effort; not a guarantee). */
export function maskSecrets(line: string): string {
  let out = line;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Splits the tail into lines, drops a partial first line when the read started mid-file, cleans and masks. */
export function prepareLines(text: string, startedMidFile: boolean): string[] {
  const raw = text.split(/\r?\n/);
  if (startedMidFile) raw.shift();
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const out: string[] = [];
  let inKey = false;
  for (const line of raw) {
    if (PRIVATE_KEY_BEGIN.test(line)) inKey = true;
    if (inKey) {
      out.push('[PRIVATE KEY REDACTED]');
      if (PRIVATE_KEY_END.test(line)) inKey = false;
      continue;
    }
    out.push(maskSecrets(sanitizeLine(line)));
  }
  return out;
}

/** Keeps the newest lines that fit `maxLines` and `byteBudget`; returns them in order plus whether anything was cut. */
export function fitLines(lines: readonly string[], maxLines: number, byteBudget: number): { kept: string[]; bytes: number; cut: boolean } {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i] ?? '';
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > byteBudget) break;
    kept.unshift(line);
    bytes += size;
  }
  return { kept, bytes, cut: kept.length < lines.length };
}

function toStream(read: FileRead | null, lines: string[] | null, maxLines: number, budget: number): { stream: LogStream; used: number } {
  if (!read || read.state !== 'ok' || !lines) {
    return { stream: { state: read ? read.state : 'unavailable', text: '', lines: 0, truncated: false, sizeBytes: null, modifiedAt: null }, used: 0 };
  }
  const meta = { sizeBytes: read.size, modifiedAt: read.mtime.toISOString() };
  if (lines.length === 0) return { stream: { state: 'empty', text: '', lines: 0, truncated: read.startedMidFile, ...meta }, used: 0 };
  const fit = fitLines(lines, maxLines, budget);
  return { stream: { state: 'ok', text: fit.kept.join('\n'), lines: fit.kept.length, truncated: fit.cut || read.startedMidFile, ...meta }, used: fit.bytes };
}

/** Builds both streams within the shared byte budget (half each; unused budget of one goes to the other). */
export function buildStreams(out: FileRead | null, err: FileRead | null, maxLines: number, merged: boolean): { stdout: LogStream; stderr: LogStream } {
  const half = Math.floor(LOG_LIMITS.totalTextBytes / 2);
  const outLines = out?.state === 'ok' ? prepareLines(out.text, out.startedMidFile) : null;
  const errLines = !merged && err?.state === 'ok' ? prepareLines(err.text, err.startedMidFile) : null;
  const errNeed = errLines ? fitLines(errLines, maxLines, half).bytes : 0;
  const stdout = toStream(out, outLines, maxLines, LOG_LIMITS.totalTextBytes - errNeed);
  const stderr = merged
    ? { stream: { state: 'merged' as const, text: '', lines: 0, truncated: false, sizeBytes: null, modifiedAt: null }, used: 0 }
    : toStream(err, errLines, maxLines, LOG_LIMITS.totalTextBytes - stdout.used);
  return { stdout: stdout.stream, stderr: stderr.stream };
}

async function loadEntries(deps: Pick<LogDeps, 'loadAllowlist'>): Promise<AllowlistEntry[] | null> {
  try {
    return await deps.loadAllowlist();
  } catch (error) {
    if (error instanceof AllowlistError) return null;
    throw error;
  }
}

/** Targets whose logs may be read (explicit `logs: true`), with their current identity match. */
export async function listLogTargets(deps: Pick<LogDeps, 'loadAllowlist' | 'list'>): Promise<LogTargetsResponse> {
  const entries = await loadEntries(deps);
  if (!entries) return { v: 1, op: 'logTargets', daemon: 'ok', allowlist: 'invalid', targets: [] };
  let raw: unknown[] | null;
  try {
    raw = await deps.list();
  } catch {
    raw = null;
  }
  const targets: LogTarget[] = entries.filter((e) => e.logs === true).map((e) => {
    if (!raw) return { targetKey: e.id, name: e.name, pmId: null, matchStatus: 'daemon_unavailable' };
    const m = matchEntry(e, raw);
    return { targetKey: e.id, name: e.name, pmId: m.status === 'ok' ? m.view.pmId : null, matchStatus: m.status };
  });
  return { v: 1, op: 'logTargets', daemon: raw ? 'ok' : 'unavailable', allowlist: 'ok', targets };
}

export async function readLogs(req: LogsRequest, deps: LogDeps): Promise<LogsResponse> {
  const now = deps.now ?? Date.now;
  const readAt = () => new Date(now()).toISOString();
  const fail = (outcome: 'rejected' | 'failed', reason: LogReason): LogsResponse =>
    ({ v: 1, op: 'logs', requestId: req.requestId, outcome, reason, readAt: readAt(), stdout: null, stderr: null });

  const deadline = Date.parse(req.deadlineAt);
  if (now() > deadline) return fail('rejected', 'deadline_passed');
  if (deadline - now() > 5 * 60_000) return fail('rejected', 'invalid_deadline');
  const entries = await loadEntries(deps);
  if (!entries) return fail('rejected', 'allowlist_invalid');
  const entry = entries.find((e) => e.id === req.targetKey);
  if (!entry) return fail('rejected', 'not_allowlisted');
  if (entry.logs !== true) return fail('rejected', 'logs_not_allowed');
  let raw: unknown[];
  try {
    raw = await deps.list();
  } catch {
    return fail('failed', 'daemon_unavailable');
  }
  const match = matchEntry(entry, raw);
  if (match.status !== 'ok') return fail('rejected', match.status);
  const view: RawProcessView = match.view;
  const outPath = allowedLogPath(view.env.pm_out_log_path, deps.logDirs);
  const errPath = allowedLogPath(view.env.pm_err_log_path, deps.logDirs);
  const merged = outPath !== null && outPath === errPath;
  const [out, err] = await Promise.all([
    outPath ? readTail(outPath) : Promise.resolve<FileRead>({ state: 'unavailable' }),
    errPath && !merged ? readTail(errPath) : Promise.resolve<FileRead>({ state: 'unavailable' }),
  ]);
  const streams = buildStreams(out, err, req.lines, merged);
  const response: LogsResponse = { v: 1, op: 'logs', requestId: req.requestId, outcome: 'ok', reason: null, readAt: readAt(), ...streams };
  return shrinkToFrame(response);
}

/** Guarantees the serialised response (JSON escaping included) fits the frame limit by dropping oldest lines. */
export function shrinkToFrame(response: LogsResponse, limit: number = LOG_LIMITS.maxFrameBytes): LogsResponse {
  let r = response;
  while (Buffer.byteLength(JSON.stringify(r)) + 1 > limit) {
    const pick = (s: LogStream | null) => (s && s.lines > 0 ? s : null);
    const target = [pick(r.stdout), pick(r.stderr)].filter((s): s is LogStream => s !== null).sort((a, b) => b.text.length - a.text.length)[0];
    if (!target) break;
    const lines = target.text.split('\n').slice(1);
    const shrunk: LogStream = { ...target, text: lines.join('\n'), lines: lines.length, truncated: true };
    r = { ...r, stdout: r.stdout === target ? shrunk : r.stdout, stderr: r.stderr === target ? shrunk : r.stderr };
  }
  return r;
}
