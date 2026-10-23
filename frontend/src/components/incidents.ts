import type { AlertRule, Incident } from '../api/types';
import type { Tone } from './ui';

// Wording of alert incidents (ADR-021, NTF-01…07). Three things are kept apart: the problem (open / closed, severity),
// what is known about the process (only what the incident itself carries) and the delivery of its Slack message
// (admin data). Nothing is derived that the API does not send: no current PM2 state, no value at opening, no reader.

export const RULE_TITLE: Record<AlertRule, string> = {
  server_offline: 'Сервер не звітує', inventory_stale: 'Дані PM2 неактуальні', process_down: 'PM2-процес не працює',
  process_cpu: 'Високе CPU процесу (PM2)', server_memory: 'Висока пам’ять ОС (правило виведено)', process_restarts: 'Часті рестарти',
};
export const RULE_ORDER: AlertRule[] = ['process_down', 'process_cpu', 'process_restarts', 'server_offline', 'inventory_stale', 'server_memory'];

export const SEVERITY_TEXT = { critical: 'Критично', warning: 'Попередження' } as const;

export const RESOLUTION_TEXT = {
  recovered: 'Відновлено', process_gone: 'Процес зник з PM2 (відновлення не підтверджено)', excluded: 'Сервер виключено з моніторингу',
  retired: 'Правило виведено з експлуатації (не відновлення)',
} as const;

export const SERVER_STATUS_TEXT = { online: 'Онлайн', offline: 'Не звітує', never_connected: 'Ще не підключався', inactive: 'Неактивний' } as const;

type Notification = NonNullable<Incident['notification']>;
export const DELIVERY: Record<Notification['state'], { label: string; tone: Tone }> = {
  none: { label: 'Не надсилалось', tone: 'muted' },
  queued: { label: 'У черзі', tone: 'info' },
  sending: { label: 'Надсилається', tone: 'info' },
  sent: { label: 'Надіслано', tone: 'ok' },
  failed: { label: 'Не доставлено', tone: 'bad' },
  unknown: { label: 'Результат невідомий', tone: 'warn' },
  dropped: { label: 'Відкинуто: черга переповнена', tone: 'bad' },
  cancelled: { label: 'Скасовано', tone: 'muted' },
};

/** Delivery of this incident's message; `notify: false` = a repeat within the cooldown, nothing was meant to be sent. */
export function delivery(n: Notification): { label: string; tone: Tone } {
  return n.notify ? DELIVERY[n.state] : { label: 'Без сповіщення', tone: 'muted' };
}

const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const num = (v: number) => number.format(v);
const dayMonth = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit' });
const dayMonthYear = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
const hourMinute = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });

/** «23.10 · 10:16» (the year only when it is not the current one); «—» when there is no time. */
export function shortTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const at = new Date(iso);
  const day = at.getFullYear() === new Date(now).getFullYear() ? dayMonth.format(at) : dayMonthYear.format(at);
  return `${day} · ${hourMinute.format(at)}`;
}

export interface Metric { value: string; note: string | null }

/**
 * The value the incident carries: the last observation while open; after a recovery the closing observation; after
 * any other closing the last observation before it (the API keeps it). Missing → «—», a real 0 stays 0. PM2 CPU is
 * per core and may exceed 100 %.
 */
export function metric(i: Incident): Metric {
  const d = i.detail;
  const threshold = d.threshold === undefined || d.threshold === null ? null : d.threshold;
  switch (i.rule) {
    case 'process_cpu':
      return { value: d.value === undefined || d.value === null ? '—' : `${num(d.value)} % CPU`, note: threshold === null ? null : `поріг ${num(threshold)} %` };
    case 'server_memory':
      return { value: d.value === undefined || d.value === null ? '—' : `${num(d.value)} % пам’яті`, note: threshold === null ? null : `поріг ${num(threshold)} %` };
    case 'process_restarts': {
      if (d.delta === undefined) return { value: '—', note: null };
      const span = d.spanSeconds ?? d.windowSeconds;
      return {
        value: `${num(d.delta)} рестартів${span === undefined ? '' : ` за ${num(Math.max(1, Math.round(span / 60)))} хв`}`,
        note: threshold === null ? null : `поріг ${num(threshold)}`,
      };
    }
    case 'process_down':
      if (d.status === 'stopped') return { value: 'stopped', note: 'може бути навмисною зупинкою' };
      if (d.status === 'errored') return { value: 'errored', note: 'процес завершився з помилкою' };
      return { value: d.status ?? '—', note: null };
    case 'server_offline':
      return d.lastSeenAt ? { value: `Сигнал ${shortTime(d.lastSeenAt)}`, note: 'поточний стан невідомий' } : { value: 'Сигнал невідомий', note: null };
    case 'inventory_stale':
      return { value: d.state === 'unavailable' ? 'Exporter недоступний' : d.state === 'stale' ? 'Дані застарілі' : d.state ?? '—', note: null };
  }
}

/** Search text of a row: only what the row shows (server, application, problem type). */
export const searchText = (i: Incident) => `${i.serverName} ${i.processName ?? ''} ${RULE_TITLE[i.rule]}`.toLocaleLowerCase('uk-UA');
