import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import { ApiError, controlApi } from '../api/client';
import type { ApplicationItem, CommandView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../pages/ServersPage';
import { ActionMenu, type MenuItem } from './ActionMenu';
import { formatUptimeShort } from './ApplicationList';
import { currentState, freshness, lastKnown, notRunning } from './appState';
import { formatCount, formatCpu, formatMemory } from './Inventory';
import { LogTail } from './LogViewer';
import { ACTION_LABELS, commandStatusText, controlTargetFor, logTargetFor } from './processActions';
import { formatAgo, formatClock, recent } from './time';
import { StatusIndicator, type Tone } from './ui';
import type { ServerCapabilities } from './useServerCapabilities';

// Details of the selected application (applications workspace; design reference 1.0, APP-01…APP-07, APP-10, APP-14,
// APP-15): the right pane of the split view (≥ 1280 px) or a separate view below that width. Layout: identity (full
// name, server · PM2 id · mode, current state), actions («Перезапустити» — or «Запустити» for a stopped process — as a
// visible button, the other commands in the «⋯» menu, a short hint), state notices, CPU / RAM / uptime with the PM2
// collection time; then the tabs. Everything is loaded only for the open tab: the overview uses the row; logs mount
// the shared bounded log tail; the history asks the API for the commands of the ONE broker-confirmed control target.
// Actions are the shared menu items (same confirmation, limits and tracking) — the static design buttons never bypass
// them, and a missing permission is shown, not hidden.
//
// `presence` says how the selected process relates to what is on screen and to the server's current inventory. Only a
// confirmed process (on this page, or found in the inventory outside the filter/page) shows its data as such; a
// process confirmed to be gone, or one the user may no longer see, shows no metrics, logs or commands; an
// unconfirmed one keeps its last known data only under an explicit warning, with commands blocked.

export type DetailTab = 'overview' | 'logs' | 'history';
const TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Огляд' }, { id: 'logs', label: 'Логи' }, { id: 'history', label: 'Історія дій' },
];

export type Presence =
  | { kind: 'page' }
  | { kind: 'filtered' }
  | { kind: 'other_page' }
  | { kind: 'checking' }
  | { kind: 'missing'; collectedAt: string | null }
  | { kind: 'uncertain'; why: string }
  | { kind: 'unverified' }
  | { kind: 'revoked' };

/** The process is confirmed (on this page or in the current inventory): its data and commands are its own. */
export const confirmedPresence = (p: Presence) => p.kind === 'page' || p.kind === 'filtered' || p.kind === 'other_page';
/** Nothing of the process may be shown or done (gone from the inventory, or no longer visible to this user). */
const gone = (p: Presence) => p.kind === 'missing' || p.kind === 'revoked';

interface Notice { tone: 'warning' | 'error' | 'info' | 'neutral'; title: string; text?: string }

function presenceNotice(p: Presence, serverName: string): Notice | null {
  switch (p.kind) {
    case 'page': return null;
    case 'filtered': return { tone: 'neutral', title: 'Вибраний застосунок поза поточним фільтром', text: 'Деталі залишаються відкритими; список показує результат фільтра.' };
    case 'other_page': return { tone: 'neutral', title: 'Вибраний застосунок не на поточній сторінці списку', text: 'Він є в inventory сервера.' };
    case 'checking': return { tone: 'warning', title: 'Перевіряємо, чи процес ще є в inventory сервера…', text: 'Показано останні відомі дані; команди тимчасово недоступні.' };
    case 'missing': return { tone: 'warning', title: `Процесу більше немає серед доступних вам процесів сервера «${serverName}»`,
      text: `За поточним inventory${p.collectedAt ? ` (зібрано ${formatDate(p.collectedAt)})` : ''}: його видалено, перейменовано, PM2 id відповідає іншому процесу або доступ відкликано. Дані, логи й команди недоступні.` };
    case 'uncertain': return { tone: 'warning', title: `Не вдалося підтвердити, що процес ще існує: ${p.why}`, text: 'Показано останні відомі дані; команди заблоковано.' };
    case 'unverified': return { tone: 'warning', title: 'Не вдалося перевірити поточний inventory сервера', text: 'Показано останні відомі дані; команди заблоковано, доки перевірка не вдасться.' };
    case 'revoked': return { tone: 'warning', title: 'Доступ до цього застосунку або його сервера більше не надано', text: 'Деталі й логи приховано.' };
  }
}

/** The state of the process itself: agent / PM2 freshness first (they make the PM2 status unknown), then stopped/errored. */
function stateNotice(app: ApplicationItem, lastSeenAt: string | null): Notice | null {
  const known = lastKnown(app) ?? '—';
  switch (freshness(app)) {
    case 'offline': return { tone: 'warning', title: `Агент не звітує${lastSeenAt ? ` · останній сигнал ${formatAgo(lastSeenAt)}` : ''}`, text: `Останній відомий стан: ${known}. Поточний стан невідомий.` };
    case 'stale': return { tone: 'warning', title: `Дані PM2 застарілі · останній збір ${formatAgo(app.collectedAt)}`,
      text: `Агент онлайн${lastSeenAt ? ` · сигнал ${formatAgo(lastSeenAt)}` : ''}. Поточний стан процесу невідомий (останній відомий: ${known}).` };
    case 'unavailable': return { tone: 'warning', title: `Exporter PM2 недоступний · останній збір ${formatAgo(app.collectedAt)}`, text: `Поточний стан процесу невідомий (останній відомий: ${known}).` };
    case 'live': break;
  }
  if (app.status === 'stopped') return { tone: 'warning', title: 'Процес зупинено', text: 'Причина зупинки невідома. Це не обов’язково інцидент.' };
  if (app.status === 'errored') return { tone: 'error', title: 'PM2 повідомляє про помилку', text: 'Процес не працює. Перевірте stderr перед повторним запуском.' };
  return null;
}

function NoticeBox({ notice, role }: { notice: Notice; role?: 'status' | 'alert' }) {
  return (
    <div className={`notice notice--${notice.tone}`} role={role}>
      <p className="notice__title">{notice.title}</p>
      {notice.text ? <p className="notice__text">{notice.text}</p> : null}
    </div>
  );
}

export function ApplicationDetail({ app, presence, tab, onTab, caps, items, reasons, canControl, canLogs, historyVersion, lastSeenAt, onMenuOpen, onClose, onBack, headingRef }: {
  /** The selected process: live data when confirmed, otherwise its last known row. */
  app: ApplicationItem;
  presence: Presence;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  /** Capabilities of the process's server; null while they load. */
  caps: ServerCapabilities | null;
  /** The process's menu items and reasons (rowMenu): the same actions everywhere. */
  items: MenuItem[];
  reasons: string[];
  canControl: boolean;
  canLogs: boolean;
  /** Changes when a command was accepted or finished: the open history reloads. */
  historyVersion: number;
  /** Last heartbeat of the process's server (from the servers list), when known. */
  lastSeenAt: string | null;
  /** The «⋯» menu was opened: capabilities are revalidated. */
  onMenuOpen: () => void;
  /** Separate view: back to the list (filters, page and scroll position are kept). */
  onBack?: (() => void) | undefined;
  /** Split view: «Закрити деталі» clears the selection (the list gets the whole width back). */
  onClose?: (() => void) | undefined;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  const base = useId();
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const confirmed = confirmedPresence(presence);
  const actions = items.filter((i) => i.key !== 'logs');
  // The visible command: «Запустити» for a stopped process when the broker allows it, otherwise «Перезапустити».
  const start = app.status === 'stopped' && freshness(app) === 'live' ? actions.find((i) => i.key === 'start') : undefined;
  const primary = start ?? actions.find((i) => i.key === 'restart');
  const others = actions.filter((i) => i !== primary);
  const select = (next: DetailTab) => { onTab(next); tabRefs.current[next]?.focus(); };
  const onTabKey = (event: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = event.key === 'ArrowRight' ? (i + 1) % TABS.length : event.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    select(TABS[to]?.id ?? 'overview');
  };
  const hidden = gone(presence);
  const state = currentState(app);
  const live = freshness(app) === 'live';
  const presenceInfo = presenceNotice(presence, app.serverName);
  const stateInfo = hidden ? null : stateNotice(app, lastSeenAt);
  const hint = !canControl ? 'Немає дозволу'
    : primary && !primary.disabled ? 'Потрібне підтвердження'
      : !caps && confirmed ? 'Перевіряється…' : 'Керування недоступне';
  const metric = (value: string) => (notRunning(app) ? '—' : value);

  return (
    <div className={`app-detail${tab === 'logs' && !hidden ? ' app-detail--logs' : ''}`} role="region" aria-label={`Деталі: ${app.name} на ${app.serverName}`}>
      <div className="app-detail__top">
        {onBack ? <button type="button" className="link-button app-detail__back" onClick={onBack}>← До списку застосунків</button> : null}
        <div className="app-detail__identity">
          <div className="app-detail__title">
            <h2 ref={headingRef} tabIndex={-1} className="app-detail__name">{app.name}</h2>
            <p className="app-detail__context">{hidden ? app.serverName : `${app.serverName} · PM2 ${String(app.pmId)}${app.execMode ? ` · ${app.execMode}` : ''}`}</p>
          </div>
          <div className="app-detail__corner">
            {hidden ? null : <StatusIndicator tone={state.tone}>{state.label}</StatusIndicator>}
            {onClose ? <button type="button" className="button button--ghost icon-button app-detail__close" aria-label="Закрити деталі" title="Закрити деталі" onClick={onClose}>✕</button> : null}
          </div>
        </div>
        {hidden ? null : (
          <div className="app-detail__actions">
            <button type="button" className="button" aria-disabled={!primary || primary.disabled || undefined}
              onClick={() => { if (primary && !primary.disabled) primary.onSelect(); }}>{primary?.label ?? 'Перезапустити'}</button>
            <ActionMenu name={`${app.name} на ${app.serverName}`} ariaLabel={`Дії: ${app.name} на ${app.serverName}`} label="⋯" iconOnly
              items={others} note={!canControl ? 'Немає дозволу на керування процесами' : reasons.join('. ') || null}
              loading={canControl && !caps} onOpen={onMenuOpen} disabled={!canControl} />
            <span className="app-detail__hint">{hint}</span>
          </div>
        )}
        {presenceInfo ? <NoticeBox notice={presenceInfo} role="status" /> : null}
        {stateInfo ? <NoticeBox notice={stateInfo} /> : null}
        {!hidden && !canControl ? <NoticeBox notice={{ tone: 'info', title: 'Режим перегляду', text: 'Немає дозволу на керування цим застосунком.' }} /> : null}
        {hidden ? null : (
          <>
            <dl className={`app-metrics${live ? '' : ' app-metrics--stale'}`}>
              <div><dt>CPU</dt><dd className="num">{metric(formatCpu(app.cpuPercent))}</dd></div>
              <div><dt>RAM</dt><dd className="num">{metric(formatMemory(app.memoryBytes))}</dd></div>
              <div><dt>Час роботи</dt><dd className="num">{metric(formatUptimeShort(app.uptimeSeconds))}</dd></div>
            </dl>
            <p className="app-detail__collected">{live
              ? (recent(app.collectedAt) ? `Зібрано ${formatAgo(app.collectedAt)} · ${formatClock(app.collectedAt)}` : `Зібрано ${formatDate(app.collectedAt)}`)
              : `Останні відомі значення · дані застарілі · зібрано ${formatDate(app.collectedAt)}`}</p>
          </>
        )}
      </div>

      {hidden ? null : (
        <>
          <div role="tablist" aria-label="Розділи застосунку" className="app-tabs" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`${base}-${t.id}-tab`}
                aria-selected={tab === t.id} aria-controls={`${base}-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
                className={`app-tab${tab === t.id ? ' app-tab--active' : ''}`} onClick={() => { onTab(t.id); }}>{t.label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`${base}-${tab}`} aria-labelledby={`${base}-${tab}-tab`} className="app-detail__content">
            {tab === 'overview' ? <Overview app={app} caps={caps} canControl={canControl} confirmed={confirmed} actions={actions} reasons={reasons} /> : null}
            {tab === 'logs' ? <LogsTab app={app} caps={caps} canLogs={canLogs} /> : null}
            {tab === 'history' ? <HistoryTab app={app} caps={caps} canControl={canControl} version={historyVersion} /> : null}
          </div>
        </>
      )}
    </div>
  );
}

const FRESHNESS_TEXT = { live: 'Актуальні', offline: 'Сервер офлайн — дані неактуальні', stale: 'Застарілі', unavailable: 'Exporter недоступний' } as const;

function Overview({ app, caps, canControl, confirmed, actions, reasons }: { app: ApplicationItem; caps: ServerCapabilities | null; canControl: boolean; confirmed: boolean; actions: MenuItem[]; reasons: string[] }) {
  const enabled = actions.filter((a) => !a.disabled);
  const control: Notice = !canControl ? { tone: 'info', title: 'Керування недоступне', text: 'Немає дозволу на команди для цього застосунку.' }
    : !confirmed ? { tone: 'info', title: 'Керування заблоковано', text: 'Наявність процесу не підтверджено.' }
      : !caps ? { tone: 'info', title: 'Керування перевіряється…' }
        : enabled.length > 0 ? { tone: 'info', title: 'Керування дозволене', text: `Доступно: ${enabled.map((a) => a.label).join(', ')}. Доступні команди визначає брокер цього сервера.` }
          : { tone: 'info', title: 'Керування недоступне', text: reasons.length > 0 ? reasons.join('. ') : 'Брокер цього сервера не дозволяє команд для процесу.' };
  const rows: [string, ReactNode][] = [
    ['Сервер', app.serverName],
    ['PM2 id', String(app.pmId)],
    ['Режим', app.execMode ?? '—'],
    ['Рестарти, усього', formatCount(app.restarts)],
    ['Зібрано', formatDate(app.collectedAt)],
    ['Дані', FRESHNESS_TEXT[freshness(app)]],
  ];
  return (
    <>
      <h3 className="app-section-title">Параметри процесу</h3>
      <dl className="kv">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <NoticeBox notice={control} />
      <p className="hint">CPU за PM2 може перевищувати 100 % на кількох ядрах. «—» означає невідоме значення, не нуль.</p>
    </>
  );
}

function LogsTab({ app, caps, canLogs }: { app: ApplicationItem; caps: ServerCapabilities | null; canLogs: boolean }) {
  if (!canLogs) return <NoticeBox notice={{ tone: 'info', title: 'Немає права на перегляд логів.', text: 'Доступ до логів надається окремо від перегляду метрик.' }} />;
  if (!caps) return <p role="status" className="hint">Перевірка доступу до логів…</p>;
  const target = logTargetFor(app, caps.logs && caps.logs.serverId === app.serverId ? caps.logs : null);
  if (target) return <LogTail key={`${app.serverId}:${target.targetKey}:${app.name}`} serverId={app.serverId} serverName={app.serverName} targetKey={target.targetKey} name={app.name} />;
  const lv = caps.logs;
  const why = !lv ? (caps.failed ? 'Не вдалося перевірити доступ до логів — відкрийте вкладку ще раз.' : 'Перегляд логів недоступний.')
    : lv.state === 'unsupported' ? 'Перегляд логів не підтримується агентом цього сервера.'
      : lv.state === 'not_connected' ? 'Агент не на зв’язку — логи недоступні.'
        : lv.state === 'broker_unavailable' ? 'Логи тимчасово недоступні (broker).' : 'Логи цього процесу не дозволені на сервері (allowlist) або процес не підтверджено.';
  return <NoticeBox notice={{ tone: 'warning', title: why, text: 'Збережених рядків цього процесу немає: текст показується лише після успішного читання.' }} />;
}

function HistoryTab({ app, caps, canControl, version }: { app: ApplicationItem; caps: ServerCapabilities | null; canControl: boolean; version: number }) {
  if (!canControl) return <NoticeBox notice={{ tone: 'info', title: 'Історія недоступна', text: 'Історія команд зіставляється через підтверджену ціль керування — доступна користувачам із правом керування.' }} />;
  if (!caps) return <p role="status" className="hint">Перевірка цілі керування…</p>;
  const target = controlTargetFor(app, caps.control && caps.control.serverId === app.serverId ? caps.control : null);
  if (!target) {
    return <p className="hint">{caps.failed
      ? 'Не вдалося перевірити ціль керування — історію не показано.'
      : 'Для цього процесу немає підтвердженої цілі керування (ім’я + PM2 id) — історію команд неможливо надійно зіставити. Це не означає, що команд не було.'}</p>;
  }
  return <TargetHistory key={`${app.serverId}:${target.targetKey}`} serverId={app.serverId} targetKey={target.targetKey} version={version} />;
}

// Event title: the action and how it ended (the full explanation stays under it). Who requested it is not shown: the
// API returns only the requester's id, not a name (no new contract for a name).
const ACTION_NOUNS = { start: 'Запуск', stop: 'Зупинку', restart: 'Перезапуск' } as const;
const OUTCOMES: Record<CommandView['status'], [string, Tone]> = {
  queued: ['у черзі', 'muted'], dispatched: ['виконується', 'muted'], succeeded: ['завершено', 'ok'], failed: ['не вдалося', 'bad'],
  rejected: ['відхилено', 'warn'], expired: ['протерміновано', 'warn'], unknown: ['— результат невідомий', 'warn'],
};

function TargetHistory({ serverId, targetKey, version }: { serverId: string; targetKey: string; version: number }) {
  const { sessionExpired, bindSession } = useAuth();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; items: CommandView[] } | { status: 'error' }>({ status: 'loading' });
  useEffect(() => {
    const binding = bindSession();
    const controller = new AbortController();
    controlApi.history(serverId, targetKey, controller.signal).then(
      (items) => { if (!controller.signal.aborted && binding.current()) setState({ status: 'ready', items }); },
      (e: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
        setState({ status: 'error' });
      },
    );
    return () => { controller.abort(); };
  }, [serverId, targetKey, version, bindSession, sessionExpired]);

  return (
    <>
      <h3 className="app-section-title">Останні керуючі дії</h3>
      <p className="hint">{`Команди цілі «${targetKey}» з allowlist цього сервера (останні 10), новіші зверху. Ключ цілі може відповідати й попереднім процесам із тим самим налаштуванням.`}</p>
      {state.status === 'loading' ? <p role="status" className="hint">Завантаження історії…</p> : null}
      {state.status === 'error' ? <div className="notice notice--warning" role="alert"><p className="notice__title">Не вдалося завантажити історію. Відкрийте вкладку ще раз.</p></div> : null}
      {state.status === 'ready' && state.items.length === 0 ? <p className="hint">Команд для цієї цілі ще не було.</p> : null}
      {state.status === 'ready' && state.items.length > 0 ? (
        <ol className="timeline">
          {state.items.map((c) => {
            const [outcome, tone] = OUTCOMES[c.status];
            return (
              <li key={c.id} className="timeline__event">
                <p className="timeline__title">{`${ACTION_NOUNS[c.action]} ${outcome}`}</p>
                <p className="hint num">{`${formatDate(c.requestedAt)} · ${ACTION_LABELS[c.action]}`}</p>
                <StatusIndicator tone={tone}>{commandStatusText(c)}</StatusIndicator>
              </li>
            );
          })}
        </ol>
      ) : null}
    </>
  );
}
