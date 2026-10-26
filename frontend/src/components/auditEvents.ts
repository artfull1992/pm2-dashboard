import type { AuditItem } from '../api/types';
import type { Tone } from './ui';

// Wording of audit events (AUD-01…05, docs/design/part-01; readable context ADR-033). Everything comes from the
// allowlisted fields of the event and the API's read-time context (current e-mails and names of linked rows, resolved
// by the server for the page): no per-row requests, no guesses from ids, opaque keys, URLs or the event text. Without
// the context (an older API) people and servers are named by their ids.
//
// Codes come from the API as arbitrary strings, so every dictionary is a Map built from its own entries: a code such
// as `constructor` or `__proto__` must never hit an Object.prototype property (review fc6f2e4). An unknown code is
// returned unchanged as text.

/** The label of `key` in `labels`, or `key` itself (always a string). */
const labelOf = (labels: ReadonlyMap<string, string>, key: string): string => labels.get(key) ?? key;

const EVENT_LABELS: ReadonlyMap<string, string> = new Map(Object.entries({
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
}));
/** A known event shows its label; an unknown code is shown as it is (plain text, no invented translation). */
export const eventLabel = (event: string) => labelOf(EVENT_LABELS, event);
export const isKnownEvent = (event: string) => EVENT_LABELS.has(event);

export const OUTCOME: Record<AuditItem['outcome'], { label: string; tone: Tone }> = {
  success: { label: 'Успіх', tone: 'ok' },
  failure: { label: 'Невдача', tone: 'bad' },
  denied: { label: 'Відмовлено', tone: 'warn' },
};

const REASON_LABELS: ReadonlyMap<string, string> = new Map(Object.entries({
  invalid_credentials: 'невірні облікові дані', inactive_user: 'неактивний користувач', stale_credentials: 'облікові дані змінено паралельно',
  invalid_current_password: 'невірний поточний пароль', email_taken: 'email уже зайнятий', self_change: 'зміна власного облікового запису',
  last_admin: 'останній активний адміністратор', not_dispatched: 'не передано агенту вчасно', no_result: 'агент не повідомив результат',
}));
/** A known reason code reads as text; another one is shown as the code itself. */
export const reasonLabel = (reason: string) => labelOf(REASON_LABELS, reason);

const ACTION_LABELS: ReadonlyMap<string, string> = new Map(Object.entries({ start: 'Запуск', stop: 'Зупинка', restart: 'Перезапуск' }));
const actionLabel = (action: string) => labelOf(ACTION_LABELS, action);

/** First 8 characters of an id for compact text (the whole id is in the details). */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** Lifecycle steps of a process command that the server records itself (agent reports, timers): no user acts. */
const SYSTEM_EVENTS = new Set(['process.command_rejected', 'process.command_expired', 'process.command_dispatched', 'process.command_succeeded', 'process.command_failed', 'process.command_unknown']);
export const isSystemStep = (item: AuditItem) => SYSTEM_EVENTS.has(item.event) && item.actorUserId === null;

/** Who: a label for the row, the full id behind it, and an explanation when the row is a system record. */
export interface Actor { label: string; full: string | null; note: string | null }

/** The person (if any) that wrote this audit row. The API's e-mail is the current one (ADR-033). */
export function authorOf(item: AuditItem): Actor {
  if (item.actorUserId) {
    const email = item.context?.actorEmail ?? null;
    if (email) return { label: email, full: item.actorUserId, note: null };
    // With the context the account was looked up and not found; without it (older API) only the id is known.
    return item.context ? { label: 'Користувача не знайдено', full: item.actorUserId, note: null } : { label: `Користувач ${shortId(item.actorUserId)}`, full: item.actorUserId, note: null };
  }
  if (SYSTEM_EVENTS.has(item.event)) return { label: 'Система', full: null, note: null };
  if (item.event === 'auth.login') return { label: 'Обліковий запис не встановлено', full: null, note: null };
  return { label: 'Ініціатора не встановлено', full: null, note: null };
}

/** The user who requested the control command of this row (linked by id, server and target), if known. */
export function requesterOf(item: AuditItem): Actor | null {
  const c = item.context?.command ?? null;
  if (!c) return null;
  return { label: c.requestedByEmail ?? `Користувач ${shortId(c.requestedBy)}`, full: c.requestedBy, note: null };
}

/**
 * The initiator shown in the list: the author of the row; for a system step of a command, the person who requested
 * that command (with the note that the system wrote the row). Nobody is invented.
 */
export function actorOf(item: AuditItem): Actor {
  const requester = isSystemStep(item) ? requesterOf(item) : null;
  if (requester) return { ...requester, note: 'Системна подія · за запитом користувача' };
  return authorOf(item);
}

// What happened, in words. Commands name their action; system steps are said neutrally (no false attribution).
const COMMAND_TEXT: ReadonlyMap<string, string> = new Map(Object.entries({
  'process.command_requested|start': 'Запросив запуск', 'process.command_requested|stop': 'Запросив зупинку', 'process.command_requested|restart': 'Запросив перезапуск',
  'process.command_dispatched|start': 'Запуск передано агенту', 'process.command_dispatched|stop': 'Зупинку передано агенту', 'process.command_dispatched|restart': 'Перезапуск передано агенту',
  'process.command_succeeded|start': 'Запуск виконано', 'process.command_succeeded|stop': 'Зупинку виконано', 'process.command_succeeded|restart': 'Перезапуск виконано',
  'process.command_failed|start': 'Запуск завершився помилкою', 'process.command_failed|stop': 'Зупинка завершилася помилкою', 'process.command_failed|restart': 'Перезапуск завершився помилкою',
  'process.command_unknown|start': 'Результат запуску невідомий', 'process.command_unknown|stop': 'Результат зупинки невідомий', 'process.command_unknown|restart': 'Результат перезапуску невідомий',
  'process.command_rejected|start': 'Запуск відхилено', 'process.command_rejected|stop': 'Зупинку відхилено', 'process.command_rejected|restart': 'Перезапуск відхилено',
  'process.command_expired|start': 'Запуск не доставлено вчасно', 'process.command_expired|stop': 'Зупинку не доставлено вчасно', 'process.command_expired|restart': 'Перезапуск не доставлено вчасно',
}));
const ACTION_TEXT: ReadonlyMap<string, string> = new Map(Object.entries({
  'admin.bootstrap': 'Створено адміністратора', 'auth.logout': 'Вийшов', 'authz.denied': 'Відмова в доступі',
  'user.created': 'Створив користувача', 'user.create_rejected': 'Створення користувача відхилено', 'user.role_changed': 'Змінив роль',
  'user.deactivated': 'Деактивував користувача', 'user.activated': 'Активував користувача', 'user.update_rejected': 'Зміну користувача відхилено',
  'access.updated': 'Змінив доступи', 'server.created': 'Додав сервер', 'agent.credential_revoked': 'Відкликав ключ агента',
  'logs.view_opened': 'Переглянув логи', 'logs.view_denied': 'Перегляд логів відхилено',
  'settings.alerts_changed': 'Змінив правила сповіщень', 'settings.delivery_enabled': 'Увімкнув доставку сповіщень', 'settings.delivery_disabled': 'Вимкнув доставку сповіщень',
  'integration.slack_removed': 'Відключив Slack', 'integration.slack_test_requested': 'Запросив тест Slack',
}));

/** The action of the row in words; an unknown event or action stays as its code (plain text). */
export function actionText(item: AuditItem): string {
  const e = item.event;
  const d = item.details;
  if (e.startsWith('process.command_')) {
    const known = d.action === undefined ? undefined : COMMAND_TEXT.get(`${e}|${d.action}`);
    return known ?? (d.action === undefined ? eventLabel(e) : `${eventLabel(e)} (${d.action})`);
  }
  if (e === 'auth.login') return item.outcome === 'success' ? 'Увійшов' : 'Невдала спроба входу';
  if (e === 'auth.password_change') return item.outcome === 'success' ? 'Змінив власний пароль' : 'Не вдалося змінити пароль';
  if (e === 'agent.credential_issued') return d.rotated === true ? 'Замінив ключ агента' : 'Видав ключ агента';
  if (e === 'integration.slack_configured') return d.replaced === true ? 'Замінив webhook Slack' : 'Підключив Slack';
  if (e === 'integration.slack_test_result') return item.outcome === 'success' ? 'Тест Slack успішний' : 'Тест Slack не вдався';
  return labelOf(ACTION_TEXT, e) === e ? eventLabel(e) : labelOf(ACTION_TEXT, e);
}

/** The application of a command / log event: stored in the event, else stored with the linked command, else none. */
export function serviceOf(item: AuditItem): { name: string | null; origin: string } {
  if (item.details.serviceName) return { name: item.details.serviceName, origin: 'збережено в події під час операції' };
  const fromCommand = item.context?.command?.serviceName ?? null;
  if (fromCommand) return { name: fromCommand, origin: 'з пов’язаної команди (збережено під час запиту)' };
  return { name: null, origin: 'назву не збережено — технічний ключ у технічних ідентифікаторах' };
}
const serverOf = (item: AuditItem): string | null => item.context?.serverName ?? (item.details.serverId ? `сервер ${shortId(item.details.serverId)}` : null);
const targetUserOf = (item: AuditItem): string | null => item.context?.targetUserEmail ?? (item.details.targetUserId ? `Користувач ${shortId(item.details.targetUserId)}` : null);

export interface Target { primary: string; secondary: string | null }
const joined = (...parts: (string | null | undefined)[]) => parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ') || null;

/** What the action was about (application / server / user / section) and its context. No guessing from opaque keys. */
export function targetOf(item: AuditItem): Target {
  const d = item.details;
  const e = item.event;
  if (e.startsWith('process.command_') || e.startsWith('logs.')) return { primary: serviceOf(item).name ?? 'Назву застосунку не збережено', secondary: serverOf(item) };
  if (e === 'server.created' || e.startsWith('agent.credential_')) {
    const note = e === 'agent.credential_revoked' && d.revoked === false ? 'активного ключа не було' : null;
    return { primary: item.context?.serverName ?? (d.serverId ? `Сервер ${shortId(d.serverId)}` : 'Не передано'), secondary: note };
  }
  if (e.startsWith('user.') || e === 'access.updated') {
    const roles = d.fromRole && d.toRole ? `${d.fromRole} → ${d.toRole}` : d.role ?? null;
    return { primary: targetUserOf(item) ?? 'Не передано', secondary: joined(roles, d.revision === undefined ? null : `ревізія ${String(d.revision)}`) };
  }
  if (e === 'authz.denied') return { primary: d.route ?? 'Не передано', secondary: d.permission ? `потрібен дозвіл ${d.permission}` : null };
  if (e === 'settings.alerts_changed') return { primary: 'Правила сповіщень', secondary: d.revision === undefined ? null : `ревізія ${String(d.revision)}` };
  if (e.startsWith('settings.')) return { primary: 'Доставка сповіщень', secondary: d.revision === undefined ? null : `ревізія ${String(d.revision)}` };
  if (e.startsWith('integration.slack_')) return { primary: 'Інтеграція Slack', secondary: d.generation === undefined ? null : `покоління ${String(d.generation)}` };
  if (e === 'auth.login' || e === 'auth.logout') return { primary: 'Сесія', secondary: null };
  if (e === 'auth.password_change' || e === 'admin.bootstrap') return { primary: 'Власний обліковий запис', secondary: null };
  // Unknown event: only what its fields name.
  const primary = d.serviceName ?? targetUserOf(item) ?? (d.serverId ? serverOf(item) : null);
  return { primary: primary ?? 'Не передано', secondary: d.serviceName ? serverOf(item) : null };
}

/** Readable context of the row with the origin of each name (for the details). */
export function contextRows(item: AuditItem): { label: string; value: string; origin: string }[] {
  const rows: { label: string; value: string; origin: string }[] = [];
  const author = authorOf(item);
  rows.push({ label: 'Автор запису', value: author.label, origin: author.full && item.context?.actorEmail ? 'поточний email на момент перегляду' : author.label === 'Система' ? 'запис зробив сервер (крок виконання команди)' : '—' });
  const requester = requesterOf(item);
  if (requester) rows.push({ label: 'Замовник команди', value: requester.label, origin: 'з пов’язаної команди; email — поточний на момент перегляду' });
  if (item.event.startsWith('process.command_') || item.event.startsWith('logs.')) {
    const s = serviceOf(item);
    rows.push({ label: 'Застосунок', value: s.name ?? 'Назву застосунку не збережено', origin: s.origin });
  }
  if (item.details.serverId) {
    rows.push({ label: 'Сервер', value: item.context?.serverName ?? `ID ${shortId(item.details.serverId)}`, origin: item.context?.serverName ? 'поточна назва на момент перегляду' : 'назву не отримано' });
  }
  if (item.details.targetUserId) {
    rows.push({ label: 'Користувач-ціль', value: item.context?.targetUserEmail ?? `ID ${shortId(item.details.targetUserId)}`, origin: item.context?.targetUserEmail ? 'поточний email на момент перегляду' : 'email не отримано' });
  }
  return rows;
}

/** Allowlisted details as label → text (ids and keys are in the technical part); 0 and false are values. */
const DETAIL_LABELS: [keyof AuditItem['details'], string][] = [
  ['reason', 'Причина'], ['action', 'Дія'], ['role', 'Роль'], ['fromRole', 'Попередня роль'], ['toRole', 'Нова роль'],
  ['permission', 'Потрібний дозвіл'], ['route', 'Маршрут'], ['sessionsRevoked', 'Завершено сесій'], ['rotated', 'Ключ замінено'],
  ['revoked', 'Ключ відкликано'], ['revision', 'Ревізія'], ['changed', 'Змінено'], ['cancelledItems', 'Скасовано повідомлень'],
  ['generation', 'Покоління інтеграції'], ['replaced', 'Замінено webhook'], ['code', 'Код результату'], ['stale', 'Застарілий результат'],
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

/** Technical identifiers of the row (event id, code, people, request, server, command, target key, operation). */
export function technicalRows(item: AuditItem): [string, string][] {
  const d = item.details;
  const rows: [string, string | null | undefined][] = [
    ['Подія (ID)', item.id], ['Код події', item.event], ['Автор запису (ID)', item.actorUserId], ['Запит (ID)', item.requestId],
    ['Замовник команди (ID)', item.context?.command?.requestedBy], ['Сервер (ID)', d.serverId], ['Команда (ID)', d.commandId],
    ['Ключ цілі', d.targetKey], ['Користувач-ціль (ID)', d.targetUserId], ['Операція (ID)', d.operationId],
  ];
  return rows.filter(([, v]) => v !== undefined).map(([label, v]) => [label, v ?? '—']);
}

/** Text the local search looks in: what the row and its details show (people, action, application, server, ids). */
export function searchText(item: AuditItem): string {
  const a = actorOf(item);
  const t = targetOf(item);
  return [item.id, item.event, eventLabel(item.event), actionText(item), OUTCOME[item.outcome].label, a.label, a.full, authorOf(item).label,
    t.primary, t.secondary, item.requestId, ...contextRows(item).map((r) => r.value), ...detailRows(item.details).map(([, v]) => v),
    ...technicalRows(item).map(([, v]) => v)].filter(Boolean).join(' ').toLocaleLowerCase('uk-UA');
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
