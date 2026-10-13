import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { INVENTORY_LIMITS, type InventorySnapshot, parseInventorySnapshot, type UnavailableReason } from './contract.js';

// The snapshot file is the only channel between the exporter (runs as the PM2 owner, writes) and the Agent
// (nodecontrol-agent, reads via a dedicated group). Both sides refuse symlinks, unexpected owners and writable
// permissions instead of following or trusting them (ADR-016).

export class SnapshotFileError extends Error {
  constructor(readonly reason: Extract<UnavailableReason, 'snapshot_missing' | 'snapshot_invalid' | 'snapshot_insecure' | 'permission_denied'>) {
    super(reason);
  }
}

const GROUP_OR_OTHER_WRITE = 0o022;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Exporter side. The directory must already exist (created by the operator), be a real directory owned by the
 * exporter user and not writable by group/other. The file is written to a fresh temp file (O_EXCL|O_NOFOLLOW, 0640)
 * in the same directory, fsynced and renamed over the target — readers see either the old or the new snapshot.
 */
export async function writeSnapshotAtomic(file: string, snapshot: InventorySnapshot, uid: number = process.getuid?.() ?? -1): Promise<void> {
  if (!isAbsolute(file)) throw new SnapshotFileError('snapshot_insecure');
  const dir = dirname(file);
  const dirStat = await lstatOrNull(dir);
  if (!dirStat?.isDirectory() || dirStat.uid !== uid || (dirStat.mode & GROUP_OR_OTHER_WRITE) !== 0) throw new SnapshotFileError('snapshot_insecure');
  const existing = await lstatOrNull(file);
  if (existing && (!existing.isFile() || existing.uid !== uid)) throw new SnapshotFileError('snapshot_insecure');

  const body = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
  if (body.length > INVENTORY_LIMITS.maxFileBytes) throw new SnapshotFileError('snapshot_invalid');

  const tmp = join(dir, `.${basename(file)}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
  try {
    await handle.chmod(0o640); // independent of the process umask
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Agent side. Refuses: a symlinked/foreign/writable directory or file, a file the Agent itself owns (the Agent must
 * not be able to forge inventory), anything larger than the bound, and any content off the contract.
 */
export async function readSnapshotSecure(
  file: string, uid: number = process.getuid?.() ?? -1, options: { allowSameOwner?: boolean } = {},
): Promise<InventorySnapshot> {
  if (!isAbsolute(file)) throw new SnapshotFileError('snapshot_insecure');
  const ownedByUs = (owner: number) => owner === uid && options.allowSameOwner !== true;
  let dirStat: Stats | null;
  let fileStat: Stats | null;
  try {
    dirStat = await lstatOrNull(dirname(file));
    fileStat = await lstatOrNull(file);
  } catch (error) {
    throw new SnapshotFileError(code(error) === 'EACCES' ? 'permission_denied' : 'snapshot_insecure');
  }
  if (!dirStat) throw new SnapshotFileError('snapshot_missing');
  if (!dirStat.isDirectory() || ownedByUs(dirStat.uid) || (dirStat.mode & GROUP_OR_OTHER_WRITE) !== 0) throw new SnapshotFileError('snapshot_insecure');
  if (!fileStat) throw new SnapshotFileError('snapshot_missing');
  if (!fileStat.isFile() || ownedByUs(fileStat.uid) || (fileStat.mode & GROUP_OR_OTHER_WRITE) !== 0) throw new SnapshotFileError('snapshot_insecure');
  if (fileStat.size > INVENTORY_LIMITS.maxFileBytes) throw new SnapshotFileError('snapshot_invalid');

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const c = code(error);
    if (c === 'ENOENT') throw new SnapshotFileError('snapshot_missing');
    throw new SnapshotFileError(c === 'EACCES' ? 'permission_denied' : 'snapshot_insecure');
  }
  let text: string;
  try {
    // The path may have been swapped between lstat and open: the opened inode must be the one that was checked.
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== fileStat.ino || opened.dev !== fileStat.dev || ownedByUs(opened.uid)) throw new SnapshotFileError('snapshot_insecure');
    const buffer = Buffer.alloc(INVENTORY_LIMITS.maxFileBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > INVENTORY_LIMITS.maxFileBytes) throw new SnapshotFileError('snapshot_invalid');
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof SnapshotFileError) throw error;
    throw new SnapshotFileError('snapshot_invalid');
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnapshotFileError('snapshot_invalid');
  }
  const snapshot = parseInventorySnapshot(parsed);
  if (!snapshot) throw new SnapshotFileError('snapshot_invalid');
  return snapshot;
}
