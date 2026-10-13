import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type ControlAction, type ExecuteResult, isUuid } from './protocol.js';

// Durable deduplication journal of the broker (ADR-017). One file per command id, written atomically (temp +
// fsync + rename + directory fsync). `started` is persisted BEFORE the PM2 call and `completed` after it, so a
// redelivered command is never executed twice: completed → the stored result; started-only (crash during the
// action) → unknown/interrupted. Retention is bounded by age (7 days, far beyond any command deadline) and count
// (oldest first). A pruned id can no longer be redelivered by the API: its deadline has long passed.

export interface JournalEntry {
  commandId: string;
  targetKey: string;
  action: ControlAction;
  state: 'started' | 'completed';
  at: string;
  result: ExecuteResult | null;
}

export const JOURNAL_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const JOURNAL_MAX_ENTRIES = 5000;

export class Journal {
  constructor(private readonly dir: string) {}

  /** The directory must be a real directory owned by the broker and closed to group/other. */
  async verify(uid: number = process.getuid?.() ?? -1): Promise<void> {
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error('journal directory must be 0700 and owned by the broker user');
  }

  private file(commandId: string): string {
    if (!isUuid(commandId)) throw new Error('invalid command id');
    return join(this.dir, `${commandId}.json`);
  }

  async get(commandId: string): Promise<JournalEntry | null> {
    let text: string;
    try {
      text = await readFile(this.file(commandId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const entry = JSON.parse(text) as JournalEntry;
    if (entry.commandId !== commandId) throw new Error('journal entry mismatch');
    return entry;
  }

  async put(entry: JournalEntry): Promise<void> {
    const target = this.file(entry.commandId);
    const tmp = join(this.dir, `.${entry.commandId}.${randomBytes(4).toString('hex')}.tmp`);
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
    const dirHandle = await open(this.dir, constants.O_RDONLY);
    try {
      await dirHandle.sync();
    } catch {
      // Some filesystems (e.g. in tests) do not support fsync on directories; the rename is still atomic.
    } finally {
      await dirHandle.close();
    }
  }

  /** Removes entries older than the retention and keeps at most JOURNAL_MAX_ENTRIES completed ones. */
  async prune(now: number = Date.now()): Promise<number> {
    const names = (await readdir(this.dir)).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n));
    const items = await Promise.all(names.map(async (n) => ({ n, mtime: (await stat(join(this.dir, n))).mtimeMs })));
    items.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    const excess = Math.max(0, items.length - JOURNAL_MAX_ENTRIES);
    for (const [i, item] of items.entries()) {
      if (now - item.mtime > JOURNAL_RETENTION_MS || i < excess) {
        await unlink(join(this.dir, item.n)).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }
}
