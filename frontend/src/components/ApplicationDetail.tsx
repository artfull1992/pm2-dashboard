import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import { ApiError, controlApi } from '../api/client';
import type { ApplicationItem, CommandView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate, StatusBadge } from '../pages/ServersPage';
import { ActionMenu, type MenuItem } from './ActionMenu';
import { staleLabel } from './ApplicationList';
import { FreshnessBadge, formatCount, formatCpu, formatMemory, formatUptime, ProcessStatusBadge } from './Inventory';
import { LogTail } from './LogViewer';
import { ACTION_LABELS, commandStatusText, controlTargetFor, logTargetFor } from './processActions';
import type { ServerCapabilities } from './useServerCapabilities';

// Details of the selected application (applications workspace, redesign B stage 2): the right pane of the split view
// (≥1280 px) or a separate view with «Назад до списку» below that width. Everything is loaded only for the open tab:
// the overview uses the row data it already has; logs mount the shared bounded log tail (gone on tab switch, another
// process or a lost confirmation); the history asks the API for the commands of the ONE broker-confirmed control target.
// Actions are the shared menu items (same confirmation, limits and tracking): «Перезапустити» is a visible neutral
// button, the other commands are in the «Дії» menu.
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

function presenceNotice(p: Presence, serverName: string): { text: string; warn: boolean } | null {
  switch (p.kind) {
    case 'page': return null;
    case 'filtered': return { text: 'Застосунок не відповідає поточним фільтрам списку — деталі залишаються відкритими.', warn: false };
    case 'other_page': return { text: 'Застосунок є в inventory сервера, але не на поточній сторінці списку.', warn: false };
    case 'checking': return { text: 'Перевіряємо, чи процес ще є в inventory сервера… Показано останні відомі дані; команди тимчасово недоступні.', warn: true };
    case 'missing': return { text: `Процесу більше немає серед доступних вам процесів сервера «${serverName}» за поточним inventory${p.collectedAt ? ` (зібрано ${formatDate(p.collectedAt)})` : ''}: його видалено, перейменовано, PM2 id відповідає іншому процесу або доступ відкликано. Дані, логи й команди недоступні.`, warn: true };
    case 'uncertain': return { text: `Не вдалося підтвердити, що процес ще існує: ${p.why}. Показано останні відомі дані; команди заблоковано.`, warn: true };
    case 'unverified': return { text: 'Не вдалося перевірити поточний inventory сервера. Показано останні відомі дані; команди заблоковано, доки перевірка не вдасться.', warn: true };
    case 'revoked': return { text: 'Доступ до цього застосунку або його сервера більше не надано. Деталі й логи приховано.', warn: true };
  }
}

export function ApplicationDetail({ app, presence, tab, onTab, caps, items, reasons, canControl, canLogs, historyVersion, onMenuOpen, onClose, onBack, headingRef }: {
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
  /** The «Дії» menu was opened: capabilities are revalidated. */
  onMenuOpen: () => void;
  /** Split view: clears the selection. */
  onClose?: (() => void) | undefined;
  /** Separate view: back to the list (filters, page and scroll position are kept). */
  onBack?: (() => void) | undefined;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  const base = useId();
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const confirmed = confirmedPresence(presence);
  const actions = items.filter((i) => i.key !== 'logs');
  const restart = actions.find((i) => i.key === 'restart');
  const others = actions.filter((i) => i.key !== 'restart');
  const select = (next: DetailTab) => { onTab(next); tabRefs.current[next]?.focus(); };
  const onTabKey = (event: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = event.key === 'ArrowRight' ? (i + 1) % TABS.length : event.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    select(TABS[to]?.id ?? 'overview');
  };
  const notice = presenceNotice(presence, app.serverName);
  const stale = staleLabel(app);

  return (
    <div className={`app-detail${tab === 'logs' && !gone(presence) ? ' app-detail--logs' : ''}`} role="region" aria-label={`Деталі: ${app.name} на ${app.serverName}`}>
      {onBack ? (
        <div className="app-detail__nav">
          <button type="button" className="button button--small" onClick={onBack}>← Назад до списку</button>
        </div>
      ) : null}
      <div className="app-detail__head">
        <div className="app-detail__title">
          <h2 ref={headingRef} tabIndex={-1} className="app-detail__name mono">{app.name}</h2>
          <span className="app-detail__meta">
            <span>{app.serverName}</span>
            {gone(presence) ? null : <><ProcessStatusBadge status={app.status} /><FreshnessBadge state={app.inventoryState} serverStatus={app.serverStatus} /></>}
          </span>
        </div>
        {onClose ? <button type="button" className="button button--ghost icon-button app-detail__close" aria-label="Закрити деталі" title="Закрити деталі" onClick={onClose}>✕</button> : null}
      </div>
      {notice ? <p className={`notice${notice.warn ? ' notice--warning' : ''} app-detail__presence`} role="status">{notice.text}</p> : null}
      {gone(presence) ? null : (
        <>
          <dl className={`app-metrics${stale ? ' app-metrics--stale' : ''}`}>
            <div><dt>CPU</dt><dd className="num">{formatCpu(app.cpuPercent)}</dd></div>
            <div><dt>Пам'ять</dt><dd className="num">{formatMemory(app.memoryBytes)}</dd></div>
            <div><dt>Аптайм</dt><dd className="num">{formatUptime(app.uptimeSeconds)}</dd></div>
          </dl>
          {stale ? <p className="hint app-detail__stale">{`⚠ Останні відомі значення (${stale}), зібрано ${formatDate(app.collectedAt)}.`}</p> : null}
          {canControl || actions.length > 0 ? (
            <div className="app-detail__actions">
              {restart ? (
                <button type="button" className="button" aria-disabled={restart.disabled || undefined}
                  onClick={() => { if (!restart.disabled) restart.onSelect(); }}>{restart.label}</button>
              ) : null}
              {canControl ? <ActionMenu name={`${app.name} на ${app.serverName}`} items={others} note={reasons.join('. ') || null}
                loading={!caps} onOpen={onMenuOpen} /> : null}
            </div>
          ) : null}
          {confirmed && reasons.length > 0 ? <p className="hint app-detail__reasons">{reasons.join('. ')}</p> : null}

          <div role="tablist" aria-label="Розділи застосунку" className="log-tabs app-detail__tabs" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`${base}-${t.id}-tab`}
                aria-selected={tab === t.id} aria-controls={`${base}-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
                className={`log-tab ${tab === t.id ? 'log-tab--active' : ''}`} onClick={() => { onTab(t.id); }}>{t.label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`${base}-${tab}`} aria-labelledby={`${base}-${tab}-tab`} className="app-detail__panel">
            {tab === 'overview' ? <Overview app={app} caps={caps} canControl={canControl} confirmed={confirmed} actions={actions} reasons={reasons} /> : null}
            {tab === 'logs' ? <LogsTab app={app} caps={caps} canLogs={canLogs} /> : null}
            {tab === 'history' ? <HistoryTab app={app} caps={caps} canControl={canControl} version={historyVersion} /> : null}
          </div>
        </>
      )}
    </div>
  );
}

/** Split view without a selection. */
export function DetailPlaceholder() {
  return (
    <div className="app-detail app-detail--empty">
      <p>Оберіть застосунок, щоб переглянути деталі.</p>
      <p className="hint">Статус, ресурси, логи та історію дій буде показано тут.</p>
    </div>
  );
}

function Overview({ app, caps, canControl, confirmed, actions, reasons }: { app: ApplicationItem; caps: ServerCapabilities | null; canControl: boolean; confirmed: boolean; actions: MenuItem[]; reasons: string[] }) {
  const control = !canControl ? 'Немає права керування процесами.'
    : !confirmed ? 'Заблоковано: наявність процесу не підтверджено.'
      : !caps ? 'Перевіряється…'
        : actions.some((a) => !a.disabled) ? `Доступно: ${actions.filter((a) => !a.disabled).map((a) => a.label).join(', ')}.`
          : reasons.length > 0 ? reasons.join('. ') : 'Керування недоступне.';
  const rows: [string, ReactNode][] = [
    ['PM2 id', String(app.pmId)],
    ['Режим', app.execMode ?? '—'],
    ['Рестарти (усього)', formatCount(app.restarts)],
    ['Сервер', <span key="v">{app.serverName}{app.serverStatus === 'online' ? null : <> <StatusBadge status={app.serverStatus} /></>}</span>],
    ['Зібрано', formatDate(app.collectedAt)],
    ['Дані', <FreshnessBadge key="f" state={app.inventoryState} serverStatus={app.serverStatus} />],
    ['Керування', control],
  ];
  return (
    <dl className="detail-list">
      {rows.map(([k, v]) => <div key={k} className="detail-list__row"><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function LogsTab({ app, caps, canLogs }: { app: ApplicationItem; caps: ServerCapabilities | null; canLogs: boolean }) {
  if (!canLogs) return <p className="hint">Немає права на перегляд логів.</p>;
  if (!caps) return <p role="status">Перевірка доступу до логів…</p>;
  const target = logTargetFor(app, caps.logs && caps.logs.serverId === app.serverId ? caps.logs : null);
  if (target) return <LogTail key={`${app.serverId}:${target.targetKey}:${app.name}`} serverId={app.serverId} serverName={app.serverName} targetKey={target.targetKey} name={app.name} collectedAt={app.collectedAt} />;
  const lv = caps.logs;
  const why = !lv ? (caps.failed ? 'Не вдалося перевірити доступ до логів — відкрийте вкладку ще раз.' : 'Перегляд логів недоступний.')
    : lv.state === 'unsupported' ? 'Перегляд логів не підтримується агентом цього сервера.'
      : lv.state === 'not_connected' ? 'Агент не на зв’язку — логи недоступні.'
        : lv.state === 'broker_unavailable' ? 'Логи тимчасово недоступні (broker).' : 'Логи цього процесу не дозволені на сервері (allowlist) або процес не підтверджено.';
  return <p className="hint">{why}</p>;
}

function HistoryTab({ app, caps, canControl, version }: { app: ApplicationItem; caps: ServerCapabilities | null; canControl: boolean; version: number }) {
  if (!canControl) return <p className="hint">Історія команд зіставляється через підтверджену ціль керування — доступна користувачам із правом керування.</p>;
  if (!caps) return <p role="status">Перевірка цілі керування…</p>;
  const target = controlTargetFor(app, caps.control && caps.control.serverId === app.serverId ? caps.control : null);
  if (!target) {
    return <p className="hint">{caps.failed
      ? 'Не вдалося перевірити ціль керування — історію не показано.'
      : 'Для цього процесу немає підтвердженої цілі керування (ім’я + PM2 id) — історію команд неможливо надійно зіставити. Це не означає, що команд не було.'}</p>;
  }
  return <TargetHistory key={`${app.serverId}:${target.targetKey}`} serverId={app.serverId} targetKey={target.targetKey} version={version} />;
}

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
    <div className="history">
      <p className="hint">{`Команди цілі «${targetKey}» з allowlist цього сервера (останні 10). Ключ цілі може відповідати й попереднім процесам із тим самим налаштуванням.`}</p>
      {state.status === 'loading' ? <p role="status">Завантаження історії…</p> : null}
      {state.status === 'error' ? <p className="notice notice--warning" role="alert">Не вдалося завантажити історію. Відкрийте вкладку ще раз.</p> : null}
      {state.status === 'ready' && state.items.length === 0 ? <p className="hint">Команд для цієї цілі ще не було.</p> : null}
      {state.status === 'ready' && state.items.length > 0 ? (
        <ul className="control-history">
          {state.items.map((c) => (
            <li key={c.id}><span className="hint num">{formatDate(c.requestedAt)}</span> {ACTION_LABELS[c.action]} — {commandStatusText(c)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
