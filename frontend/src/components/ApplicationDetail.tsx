import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ApiError, controlApi } from '../api/client';
import type { ApplicationItem, CommandView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate, StatusBadge } from '../pages/ServersPage';
import type { MenuItem } from './ActionMenu';
import { FreshnessBadge, formatCount, formatCpu, formatMemory, formatUptime, ProcessStatusBadge } from './Inventory';
import { LogTail } from './LogViewer';
import { ACTION_LABELS, commandStatusText, controlTargetFor, logTargetFor } from './processActions';
import type { ServerCapabilities } from './useServerCapabilities';

// Expanded application in the applications list. Everything here is loaded only for the open tab: the overview uses
// the table row it already has; logs mount the shared bounded log tail (one read cycle, gone on tab switch/collapse);
// the history asks the API for the commands of the ONE broker-confirmed control target of this row. Actions are the
// same menu items as the row menu (same confirmation, limits and tracking) — no second implementation.

export type DetailTab = 'overview' | 'logs' | 'history';
const TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Огляд' }, { id: 'logs', label: 'Логи' }, { id: 'history', label: 'Історія дій' },
];

export function ApplicationDetail({ app, tab, onTab, onClose, caps, items, reasons, canControl, canLogs, historyVersion }: {
  app: ApplicationItem;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onClose: () => void;
  /** Capabilities of the row's server; null while they load. */
  caps: ServerCapabilities | null;
  /** The row's menu items and reasons (rowMenu) — the same actions as the row menu. */
  items: MenuItem[];
  reasons: string[];
  canControl: boolean;
  canLogs: boolean;
  /** Changes when a command of this server was accepted or finished: the open history reloads. */
  historyVersion: number;
}) {
  const base = useId();
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const actions = items.filter((i) => i.key !== 'logs');
  const select = (next: DetailTab) => { onTab(next); tabRefs.current[next]?.focus(); };
  const onTabKey = (event: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = event.key === 'ArrowRight' ? (i + 1) % TABS.length : event.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    select(TABS[to]?.id ?? 'overview');
  };

  return (
    <div className="app-detail" role="region" aria-label={`Деталі: ${app.name} на ${app.serverName}`}>
      <div className="app-detail__head">
        <div className="app-detail__title">
          <strong className="mono">{app.name}</strong>
          <span className="app-detail__meta">
            {app.serverName}
            <ProcessStatusBadge status={app.status} />
            <FreshnessBadge state={app.inventoryState} serverStatus={app.serverStatus} />
          </span>
        </div>
        <div className="app-detail__actions">
          {actions.map((item) => (
            <button key={item.key} type="button" className={`button button--small${item.danger ? ' button--danger' : ''}`}
              aria-disabled={item.disabled || undefined} onClick={() => { if (!item.disabled) item.onSelect(); }}>{item.label}</button>
          ))}
          <button type="button" className="button button--small" onClick={onClose}>Згорнути</button>
        </div>
      </div>
      {reasons.length > 0 ? <p className="hint app-detail__reasons">{reasons.join('. ')}</p> : null}

      <div role="tablist" aria-label="Розділи застосунку" className="log-tabs app-detail__tabs" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`${base}-${t.id}-tab`}
            aria-selected={tab === t.id} aria-controls={`${base}-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
            className={`log-tab ${tab === t.id ? 'log-tab--active' : ''}`} onClick={() => { onTab(t.id); }}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-${tab}`} aria-labelledby={`${base}-${tab}-tab`} className="app-detail__panel">
        {tab === 'overview' ? <Overview app={app} caps={caps} canControl={canControl} actions={actions} reasons={reasons} /> : null}
        {tab === 'logs' ? <LogsTab app={app} caps={caps} canLogs={canLogs} /> : null}
        {tab === 'history' ? <HistoryTab app={app} caps={caps} canControl={canControl} version={historyVersion} /> : null}
      </div>
    </div>
  );
}

function Overview({ app, caps, canControl, actions, reasons }: { app: ApplicationItem; caps: ServerCapabilities | null; canControl: boolean; actions: MenuItem[]; reasons: string[] }) {
  const control = !canControl ? 'Немає права керування процесами.'
    : !caps ? 'Перевіряється…'
      : actions.some((a) => !a.disabled) ? `Доступно: ${actions.filter((a) => !a.disabled).map((a) => a.label).join(', ')}.`
        : reasons.length > 0 ? reasons.join('. ') : 'Керування недоступне.';
  const rows: [string, ReactNode][] = [
    ['Статус', <ProcessStatusBadge key="s" status={app.status} />],
    ['Сервер', <span key="v">{app.serverName}{app.serverStatus === 'online' ? null : <> <StatusBadge status={app.serverStatus} /></>}</span>],
    ['PM2 id', String(app.pmId)],
    ['Режим', app.execMode ?? '—'],
    ['CPU', formatCpu(app.cpuPercent)],
    ["Пам'ять", formatMemory(app.memoryBytes)],
    ['Аптайм', formatUptime(app.uptimeSeconds)],
    ['Рестарти', formatCount(app.restarts)],
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
  if (target) return <LogTail key={`${app.serverId}:${target.targetKey}`} serverId={app.serverId} serverName={app.serverName} targetKey={target.targetKey} name={app.name} />;
  const lv = caps.logs;
  const why = !lv ? (caps.failed ? 'Не вдалося перевірити доступ до логів — згорніть і розгорніть ще раз.' : 'Перегляд логів недоступний.')
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
      {state.status === 'error' ? <p className="notice notice--warning" role="alert">Не вдалося завантажити історію. Згорніть і розгорніть ще раз.</p> : null}
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
