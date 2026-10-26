import type { AuditItem } from '../api/types';
import type { Tone } from './ui';

// Wording of audit events (AUD-01…05, docs/design/part-01). Everything is derived from the allowlisted fields of the
// event itself: no user, server or process lookups, no guesses from ids, URLs or the event text. The API has no
// display names, so people and servers are named by their ids (the full value is in the details).

export const EVENT_LABELS: Record<string, string> = {
  'admin.bootstrap': 'Створення адміністратора',
  'auth.login': 'Вхід',
  'auth.logout': 'Вихід',
  'auth.password_change': 'Зміна власного пароля',
  'authz.denied': 'Відмова в доступі',
  'user.created': 'Створення користувача',
  'user.create_rejected': 'Створення користувача відхилено',
  'user.role_changed': 'Зміна ролі',
  'user.deactivated': 'Деактивація користувача',
  'user.activated': 'Активація користувача',
  'user.update_rejected': 'Зміну користувача відхилено',
  'access.updated': 'Зміна доступів',
  'server.created': 'Додавання сервера',
  'agent.credential_issued': 'Видача ключа агента',
  'agent.credential_revoked': 'Відкликання ключа агента',
  'process.command_requested': 'Команда: запит',
  'process.command_rejected': 'Команда: відхилена брокером',
  'process.command_expired': 'Команда: не доставлена вчасно',
  'process.command_dispatched': 'Команда: передана агенту',
  'process.command_succeeded': 'Команда: виконана',
  'process.command_failed': 'Команда: помилка виконання',
  'process.command_unknown': 'Команда: результат невідомий',
  'logs.view_opened': 'Перегляд логів',
  'logs.view_denied': 'Перегляд логів відхилено',
  'settings.alerts_changed': 'Зміна правил сповіщень',
  'settings.delivery_enabled': 'Увімкнення доставки сповіщень',
  'settings.delivery_disabled': 'Вимкнення доставки сповіщень',
  'integration.slack_configured': 'Підключення Slack',
  'integration.slack_removed': 'Відключення Slack',
  'integration.slack_test_requested': 'Тест Slack: запит',
  'integration.slack_test_result': 'Тест Slack: результат',
};
/** A known event shows its label; an unknown code is shown as it is (plain text, no invented translation). */
export const eventLabel = (event: string) => EVENT_LABELS[event] ?? event;
export const isKnownEvent = (event: string) => event in EVENT_LABELS;

export const OUTCOME: Record<AuditItem['outcome'], { label: string; tone: Tone }> = {
  success: { label: 'Успіх', tone: 'ok' },
  failure: { label: 'Невдача', tone: 'bad' },
  denied: { label: 'Відмовлено', tone: 'warn' },
};

const REASON_LABELS: Record<string, string> = {
  invalid_credentials: 'невірні облікові дані', inactive_user: 'неактивний користувач', stale_credentials: 'облікові дані змінено паралельно',
  invalid_current_password: 'невірний поточний пароль', email_taken: 'email уже зайнятий', self_change: 'зміна власного облікового запису',
  last_admin: 'останній активний адміністратор', not_dispatched: 'не передано агенту вчасно', no_result: 'агент не повідомив результат',
};
/** A known reason code reads as text; another one is shown as the code itself. */
export const reasonLabel = (reason: string) => REASON_LABELS[reason] ?? reason;

const ACTION_LABELS: Record<string, string> = { start: 'Запуск', stop: 'Зупинка', restart: 'Перезапуск' };
const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

/** First 8 characters of an id for the compact list (the whole id is in the details and the tooltip). */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** Lifecycle steps of a process command that the server records itself (agent reports, timers): no user acts. */
const SYSTEM_EVENTS = new Set(['process.command_rejected', 'process.command_expired', 'process.command_dispatched', 'process.command_succeeded', 'process.command_failed', 'process.command_unknown']);

export interface Actor { label: string; full: string | null }
/**
 * The initiator. A user is named by id (the API has no names). Without a user id: «Система» only for events that are
 * system steps by contract; a failed sign-in of an unknown account is said as such; anything else is «Не передано».
 */
export function actorOf(item: AuditItem): Actor {
  if (item.actorUserId) return { label: `Користувач ${shortId(item.actorUserId)}`, full: item.actorUserId };
  if (SYSTEM_EVENTS.has(item.event)) return { label: 'Система', full: null };
  if (item.event === 'auth.login') return { label: 'Обліковий запис не встановлено', full: null };
  return { label: 'Не передано', full: null };
}

export interface Target { primary: string; secondary: string | null }
const server = (id: string | undefined) => (id ? `сервер ${shortId(id)}` : null);
const user = (id: string | undefined) => (id ? `Користувач ${shortId(id)}` : null);
const joined = (...parts: (string | null | undefined)[]) => parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ') || null;

/** Target and context — only from the event's own fields; nothing found → «Не передано». */
export function targetOf(item: AuditItem): Target {
  const d = item.details;
  const e = item.event;
  if (e.startsWith('process.command_')) return { primary: d.targetKey ?? 'Не передано', secondary: joined(d.action ? actionLabel(d.action) : null, server(d.serverId)) };
  if (e.startsWith('logs.')) return { primary: d.targetKey ?? 'Не передано', secondary: server(d.serverId) };
  if (e === 'server.created' || e.startsWith('agent.credential_')) {
    const note = e === 'agent.credential_issued' ? (d.rotated === true ? 'ключ замінено' : d.rotated === false ? 'перший ключ' : null)
      : e === 'agent.credential_revoked' ? (d.revoked === true ? 'ключ відкликано' : d.revoked === false ? 'активного ключа не було' : null) : null;
    return { primary: d.serverId ? `Сервер ${shortId(d.serverId)}` : 'Не передано', secondary: note };
  }
  if (e.startsWith('user.') || e === 'access.updated') {
    const roles = d.fromRole && d.toRole ? `${d.fromRole} → ${d.toRole}` : d.role ?? null;
    return { primary: user(d.targetUserId) ?? 'Не передано', secondary: joined(roles, d.revision === undefined ? null : `ревізія ${String(d.revision)}`) };
  }
  if (e === 'authz.denied') return { primary: d.route ?? 'Не передано', secondary: d.permission ? `потрібен дозвіл ${d.permission}` : null };
  if (e.startsWith('settings.')) return { primary: 'Налаштування сповіщень', secondary: d.revision === undefined ? null : `ревізія ${String(d.revision)}` };
  if (e.startsWith('integration.slack_')) return { primary: 'Інтеграція Slack', secondary: d.generation === undefined ? null : `покоління ${String(d.generation)}` };
  if (e === 'auth.login' || e === 'auth.logout') return { primary: 'Сесія', secondary: null };
  if (e === 'auth.password_change' || e === 'admin.bootstrap') return { primary: 'Власний обліковий запис', secondary: null };
  // Unknown event: only what its fields name.
  const primary = d.targetKey ?? user(d.targetUserId) ?? (d.serverId ? `Сервер ${shortId(d.serverId)}` : null);
  return { primary: primary ?? 'Не передано', secondary: d.targetKey ? server(d.serverId) : null };
}

/** Allowlisted details as label → text; 0 and false are values, an absent field is not listed. */
const DETAIL_LABELS: [keyof AuditItem['details'], string][] = [
  ['reason', 'Причина'], ['action', 'Дія'], ['targetKey', 'Сервіс'], ['serverId', 'Сервер (ID)'], ['commandId', 'Команда (ID)'],
  ['targetUserId', 'Користувач (ID)'], ['role', 'Роль'], ['fromRole', 'Попередня роль'], ['toRole', 'Нова роль'],
  ['permission', 'Потрібний дозвіл'], ['route', 'Маршрут'], ['sessionsRevoked', 'Завершено сесій'], ['rotated', 'Ключ замінено'],
  ['revoked', 'Ключ відкликано'], ['revision', 'Ревізія'], ['changed', 'Змінено'], ['cancelledItems', 'Скасовано повідомлень'],
  ['generation', 'Покоління інтеграції'], ['replaced', 'Замінено webhook'], ['operationId', 'Операція (ID)'], ['code', 'Код результату'],
  ['stale', 'Застарілий результат'],
];
export function detailRows(details: AuditItem['details']): [string, string][] {
  const rows: [string, string][] = [];
  for (const [key, label] of DETAIL_LABELS) {
    const v = details[key];
    if (v === undefined) continue;
    if (typeof v === 'boolean') rows.push([label, v ? 'так' : 'ні']);
    else if (typeof v === 'number') rows.push([label, String(v)]);
    else rows.push([label, key === 'reason' ? `${reasonLabel(v)}${reasonLabel(v) === v ? '' : ` (${v})`}` : key === 'action' ? `${actionLabel(v)}${actionLabel(v) === v ? '' : ` (${v})`}` : v]);
  }
  return rows;
}

/** Text the local search looks in: what the row and its details show. */
export function searchText(item: AuditItem): string {
  const a = actorOf(item);
  const t = targetOf(item);
  return [item.id, item.event, eventLabel(item.event), OUTCOME[item.outcome].label, a.label, a.full, t.primary, t.secondary, item.requestId,
    ...detailRows(item.details).map(([, v]) => v)].filter(Boolean).join(' ').toLocaleLowerCase('uk-UA');
}

const dayMonth = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit' });
const dayMonthYear = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
const clock = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const full = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const offset = new Intl.DateTimeFormat('uk-UA', { timeZoneName: 'shortOffset' });

/** «23.10 · 10:21:48»; the year only when it is not the current one. */
export function listTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  return `${(at.getFullYear() === new Date(now).getFullYear() ? dayMonth : dayMonthYear).format(at)} · ${clock.format(at)}`;
}
/** «23.10.2026, 10:21:48 · Europe/Kyiv (GMT+3)» — the full date with year, local time and the named zone. */
export function fullTime(iso: string): string {
  const at = new Date(iso);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const off = offset.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${full.format(at)} · ${zone}${off ? ` (${off})` : ''}`;
}
