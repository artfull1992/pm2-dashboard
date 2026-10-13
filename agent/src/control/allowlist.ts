import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { type ControlAction, isActionList, isProcessName, isTargetKey, MAX_TARGETS } from './protocol.js';

// Local allowlist of controllable PM2 processes (ADR-017). Written by the operator as root; the broker only reads
// it (and re-reads it on every request). Anything unexpected — wrong owner, writable by group/other, symlink,
// oversize, unknown keys, duplicates — makes the whole list invalid: every action is refused (fail closed).

export interface AllowlistEntry {
  /** Local identity shown in the UI and used in commands (targetKey). */
  id: string;
  /** PM2 process name the entry refers to. */
  name: string;
  actions: ControlAction[];
  /** sha256 of the process definition (see identity.ts) — identifies the definition, it does not authorise anyone. */
  fingerprint: string;
}

export class AllowlistError extends Error {
  constructor(readonly detail: string) {
    super('allowlist invalid');
  }
}

export const MAX_ALLOWLIST_BYTES = 64 * 1024;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

export interface AllowlistOptions {
  /** Required owner (root = 0 in production). */
  ownerUid: number;
  /** The broker's own uid: a list the broker could rewrite itself is never trusted… */
  selfUid: number;
  /** …except in local tests (NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST=true; never set by the systemd unit). */
  allowSelfOwned?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseAllowlist(value: unknown): AllowlistEntry[] {
  if (!isObject(value) || Object.keys(value).sort().join() !== 'targets,version' || value.version !== 1) throw new AllowlistError('shape');
  const { targets } = value;
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS) throw new AllowlistError('targets');
  const ids = new Set<string>();
  const names = new Set<string>();
  return targets.map((t: unknown) => {
    if (!isObject(t) || Object.keys(t).sort().join() !== 'actions,fingerprint,id,name') throw new AllowlistError('entry keys');
    const { id, name, actions, fingerprint } = t;
    if (!isTargetKey(id) || !isProcessName(name) || !isActionList(actions) || typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
      throw new AllowlistError('entry value');
    }
    // One entry per id and per PM2 name: two entries for the same name would make the identity ambiguous.
    if (ids.has(id) || names.has(name)) throw new AllowlistError('duplicate');
    ids.add(id);
    names.add(name);
    return { id, name, actions, fingerprint };
  });
}

export async function readAllowlist(path: string, options: AllowlistOptions): Promise<AllowlistEntry[]> {
  if (!isAbsolute(path)) throw new AllowlistError('path');
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new AllowlistError('missing');
  }
  const ownerOk = info.uid === options.ownerUid || (options.allowSelfOwned === true && info.uid === options.selfUid);
  if (!info.isFile() || !ownerOk || (info.uid === options.selfUid && options.allowSelfOwned !== true) || (info.mode & 0o022) !== 0) {
    throw new AllowlistError('permissions');
  }
  if (info.size > MAX_ALLOWLIST_BYTES) throw new AllowlistError('size');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new AllowlistError('open'); });
  let text: string;
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > MAX_ALLOWLIST_BYTES) throw new AllowlistError('changed');
    text = await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AllowlistError('json');
  }
  return parseAllowlist(parsed);
}
