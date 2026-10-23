// Short time labels of the applications workspace (design reference 1.0: «Зібрано 18 с тому · 10:21:44»).

const clock = new Intl.DateTimeFormat('uk-UA', { timeStyle: 'medium' });
const full = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' });

/** «10:21:44» for today, otherwise date and time (a bare time of another day would mislead). */
export function formatClock(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return at.toDateString() === new Date(now).toDateString() ? clock.format(at) : full.format(at);
}

/** «18 с тому», «4 хв тому», «2 год тому», then the date. A time in the future (clock skew) reads as «щойно». */
export function formatAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'невідомо коли';
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 1) return 'щойно';
  if (seconds < 60) return `${String(seconds)} с тому`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} хв тому`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} год тому`;
  return full.format(new Date(iso));
}

/** Within the last 24 hours (a relative «… тому» reads well). */
export const recent = (iso: string | null, now = Date.now()) => iso !== null && now - new Date(iso).getTime() < 86_400_000;
