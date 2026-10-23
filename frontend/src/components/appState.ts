import type { ApplicationItem } from '../api/types';
import { PROCESS_STATUS_LABELS } from './Inventory';
import type { Tone } from './ui';

// UI projection of a process row (design reference 1.0, addendum §2). It never rewrites what the API returned: the
// PM2 status, the inventory state and the server state stay as they are; this only decides what may be presented as
// the CURRENT state and which values may be shown as current metrics.
//
// - Agent offline (server not online) → «Невідомо»; PM2 data stale → «Застаріло»; exporter unavailable → «Невідомо».
//   Offline is not a PM2 process status: the last known PM2 status is explained separately (lastKnown).
// - Stopped / errored → CPU, RAM and uptime are «—» (PM2 still reports numbers for a dead process; they are not
//   meaningful). Not live → «—» in the list; in the details only the actually received last values, labelled as stale.
// - An unknown value is «—», never 0.

export type Freshness = 'live' | 'offline' | 'stale' | 'unavailable';

export function freshness(app: ApplicationItem): Freshness {
  if (app.serverStatus !== 'online') return 'offline';
  if (app.inventoryState === 'stale') return 'stale';
  if (app.inventoryState === 'unavailable') return 'unavailable';
  return 'live';
}

const STATUS_TONES: Record<ApplicationItem['status'], Tone> = {
  online: 'ok', errored: 'bad', stopped: 'warn', 'waiting restart': 'warn', stopping: 'muted', launching: 'muted', 'one-launch-status': 'muted', unknown: 'muted',
};

/** What may be shown as the current state of the process. */
export function currentState(app: ApplicationItem): { label: string; tone: Tone } {
  const f = freshness(app);
  if (f === 'stale') return { label: 'Застаріло', tone: 'muted' };
  if (f !== 'live') return { label: 'Невідомо', tone: 'muted' };
  return { label: PROCESS_STATUS_LABELS[app.status], tone: STATUS_TONES[app.status] };
}

/** The last PM2 status we know, for an explanation next to an unknown current state (null when the state is current). */
export const lastKnown = (app: ApplicationItem): string | null => (freshness(app) === 'live' ? null : PROCESS_STATUS_LABELS[app.status].toLowerCase());

/** A stopped or errored process has no meaningful CPU / RAM / uptime. */
export const notRunning = (app: ApplicationItem) => app.status === 'stopped' || app.status === 'errored';

/** Metrics may appear in the LIST only when they describe the current state of a running process. */
export const listMetrics = (app: ApplicationItem) => freshness(app) === 'live' && !notRunning(app);
