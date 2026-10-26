import { ApiError } from '../api/client';
import type { AccessMode, UserAccess } from '../api/types';
import { formatRetry } from './StatusMessage';

// The draft of one user's resource grants (ADR-028, ADR-035). The identity of a grant is serverId + the exact
// service name (there is no separate service id in the product). Each server keeps its own mode and chosen names;
// the names stay in the draft while the mode is «all» (switching back restores them), but the payload carries exactly
// one mode and, for «all», no names. Comparison is semantic: order of servers and names does not matter.

export const SEARCH_DEBOUNCE_MS = 250;

export interface DraftServer {
  serverId: string;
  serverName: string;
  serverActive: boolean;
  mode: AccessMode;
  /** Chosen service names, sorted (exact names). */
  services: string[];
  /** Granted in the loaded state but no longer known on the server; kept until removed explicitly. */
  unavailable: string[];
}

export const toDraft = (a: UserAccess): DraftServer[] => a.servers.map((g) => ({
  serverId: g.serverId, serverName: g.serverName, serverActive: g.serverActive, mode: g.mode,
  services: g.services.map((s) => s.name).sort(), unavailable: g.services.filter((s) => !s.available).map((s) => s.name),
}));

export const payload = (d: readonly DraftServer[]) =>
  d.map((s) => ({ serverId: s.serverId, mode: s.mode, services: s.mode === 'selected' ? [...s.services].sort() : [] }));

/** Semantic identity of a set of grants: what a PUT would store. */
export const signature = (d: readonly DraftServer[]) =>
  JSON.stringify(payload(d).map((s) => [s.serverId, s.mode, s.services]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

/** «Selected» with nothing chosen: never turned into «all», never saved. */
export const emptySelections = (d: readonly DraftServer[]) => d.filter((s) => s.mode === 'selected' && s.services.length === 0);

/**
 * Keep the draft but base it on another stored state (an explicit choice after a conflict): server names, activity
 * and gone services come from that state where it has the server.
 */
export function rebase(draft: readonly DraftServer[], onto: UserAccess): DraftServer[] {
  const fresh = new Map(toDraft(onto).map((s) => [s.serverId, s]));
  return draft.map((s) => {
    const f = fresh.get(s.serverId);
    return f ? { ...s, serverName: f.serverName, serverActive: f.serverActive, unavailable: f.unavailable } : s;
  });
}

export const scopeText = (s: DraftServer) =>
  (s.mode === 'all' ? 'Усі поточні й майбутні' : s.services.length === 0 ? 'Сервіси не вибрано' : `Вибрано сервісів: ${String(s.services.length)}`);

/** Same substring rule as the API search (case-insensitive). */
export const nameMatches = (name: string, q: string) => q.trim() === '' || name.toLowerCase().includes(q.trim().toLowerCase());

export const unknownResult = (error: unknown) => error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout');

/** Texts for a refused save or a failed read (never the server's own text). */
export function accessError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Перечитайте доступи й перевірте стан.';
  switch (error.kind) {
    case 'invalid_request': return 'Сервер відхилив зміни: перевірте, що для «Вибраних сервісів» вибрано хоча б один сервіс і що сервер ще існує.';
    case 'rate_limited': return `Забагато змін поспіль.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': return `Сервіс тимчасово недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'network': case 'timeout': return 'Відповідь не отримано.';
    default: return 'Неочікувана помилка. Перечитайте доступи й перевірте стан.';
  }
}
