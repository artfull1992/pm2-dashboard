import { KNOWN_ROLES, type Role } from '../api/types';

// Where the users list was (keyset cursor stack, page-local search and role) when the access page was opened from it,
// so «← Користувачі» / «Скасувати» return there (ADR-035). It travels only in the history entry's state (never in the
// URL or browser storage); whatever comes back from history is validated before use and only ever leads to /users.
// For the browser's Back the list entry itself is remembered in memory by its history key, bound to the session.

export type Cursors = (string | null)[];
export interface UsersView { cursors: Cursors; q: string; role: Role | null }

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Generous bound for a cursor stack («Далі» pushes one per page); anything longer is not trusted. */
export const MAX_VIEW_CURSORS = 1000;
const MAX_QUERY = 254;

export function parseUsersView(value: unknown): UsersView | null {
  if (typeof value !== 'object' || value === null) return null;
  const { cursors, q, role } = value as Record<string, unknown>;
  if (!Array.isArray(cursors)) return null;
  const list = cursors as unknown[];
  if (list.length === 0 || list.length > MAX_VIEW_CURSORS || list[0] !== null) return null;
  if (!list.slice(1).every((c) => typeof c === 'string' && ID_RE.test(c))) return null;
  if (typeof q !== 'string' || q.length > MAX_QUERY) return null;
  if (role !== null && !(KNOWN_ROLES as readonly unknown[]).includes(role)) return null;
  return { cursors: [...list] as Cursors, q, role: role as Role | null };
}

/** The history state of a page opened from the list: `{ from: UsersView }`. */
export const usersViewFrom = (state: unknown): UsersView | null =>
  (typeof state === 'object' && state !== null ? parseUsersView((state as { from?: unknown }).from) : null);
/** The history state of a return to the list: `{ restore: UsersView }`. */
export const usersViewRestore = (state: unknown): UsersView | null =>
  (typeof state === 'object' && state !== null ? parseUsersView((state as { restore?: unknown }).restore) : null);

// List entries left for the access page, by history key (memory only: gone on reload; a few entries at most).
const remembered = new Map<string, { session: string; view: UsersView }>();
const REMEMBERED_MAX = 20;

export function rememberUsersView(key: string, session: string, view: UsersView) {
  remembered.delete(key);
  remembered.set(key, { session, view });
  while (remembered.size > REMEMBERED_MAX) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

export function recallUsersView(key: string, session: string): UsersView | null {
  const entry = remembered.get(key);
  return entry && entry.session === session ? entry.view : null;
}

export function forgetUsersViewsForTests() {
  remembered.clear();
}
