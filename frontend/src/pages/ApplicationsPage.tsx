import { useCallback, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { applicationsApi, serversApi } from '../api/client';
import { type ApplicationItem, PROCESS_STATUSES, type ProcessStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { ActionMenu } from '../components/ActionMenu';
import { ApplicationsTable, PROCESS_STATUS_LABELS } from '../components/Inventory';
import { LogViewer } from '../components/LogViewer';
import { CommandStatusList, type CommandRequest, controlReady, rowMenu, useProcessCommands } from '../components/processActions';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';
import { useServerCapabilities } from '../components/useServerCapabilities';
import { formatDate } from './ServersPage';

// PM2 processes of all servers (ADR-016). Filters and the page cursor live in the URL, so the polled resource is
// keyed by them: switching a filter never shows rows of the previous filter (Task 007.1 rule).
//
// Row actions (start/stop/restart, logs) are the same as on the server page (processActions) and follow the same
// rules: permissions, API switch, broker report, allowlist + broker-confirmed target, live inventory. Capabilities are
// loaded per server only when a row menu is opened (useServerCapabilities) — no polling per server or per row — and
// checked again right before a command is sent. Every action is addressed by the row's serverId + confirmed
// targetKey. The whole view is mounted per session: logout or a new session drops dialogs, commands and caches.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,400}$/;

function readFilter(params: URLSearchParams) {
  const serverId = params.get('serverId');
  const status = params.get('status');
  const cursor = params.get('cursor');
  return {
    serverId: serverId && UUID_RE.test(serverId) ? serverId : null,
    status: status && (PROCESS_STATUSES as readonly string[]).includes(status) ? status as ProcessStatus : null,
    cursor: cursor && CURSOR_RE.test(cursor) ? cursor : null,
  };
}

export function ApplicationsPage() {
  const { state: auth } = useAuth();
  const sessionKey = auth.status === 'authenticated' ? auth.session.csrfToken : 'anonymous';
  return <ApplicationsView key={sessionKey} />;
}

function ApplicationsView() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = readFilter(params);
  const { serverId, status, cursor } = filter;
  const key = `${serverId ?? ''}|${status ?? ''}|${cursor ?? ''}`;
  const load = useCallback((signal: AbortSignal) => applicationsApi.list({ serverId, status, cursor }, signal), [serverId, status, cursor]);
  const { state, reload } = usePolledResource(load, key);
  const loadServers = useCallback((signal: AbortSignal) => serversApi.list(signal), []);
  const { state: servers } = usePolledResource(loadServers, 'servers');
  const serverFieldId = useId();
  const statusFieldId = useId();
  const canControl = can('processes:control');
  const canLogs = can('logs:read');
  const caps = useServerCapabilities({ canControl, canLogs });
  const { ensure, invalidate, retain } = caps;
  const [logView, setLogView] = useState<{ serverId: string; serverName: string; targetKey: string; name: string } | null>(null);
  const closeLogs = useCallback(() => { setLogView(null); }, []);
  const onChanged = useCallback((changed: string) => { invalidate(changed); reload(); }, [invalidate, reload]);
  // Right before the POST: the target must still be confirmed, allowed and controllable (fresh capabilities).
  const verify = useCallback(async (request: CommandRequest): Promise<string | null> => {
    const fresh = await ensure(request.serverId, { fresh: true });
    if (!fresh) return 'Не вдалося перевірити стан керування. Спробуйте ще раз.';
    const target = fresh.control?.targets.find((t) => t.targetKey === request.target.targetKey);
    const same = target && target.name === request.target.name && target.pmId === request.target.pmId && target.matchStatus === 'ok' && target.actions.includes(request.action);
    return controlReady(fresh.control) && same ? null : 'Стан процесу або керування змінився — дію не надіслано. Відкрийте меню ще раз.';
  }, [ensure]);
  const { ask, dialog, tracked, isBusy, limitReached } = useProcessCommands({ onChanged, verify });

  const setFilter = (name: 'serverId' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete('cursor'); // a new filter starts from the first page
    setParams(next);
  };
  const goTo = (nextCursor: string | null) => {
    const next = new URLSearchParams(params);
    if (nextCursor) next.set('cursor', nextCursor);
    else next.delete('cursor');
    setParams(next);
  };

  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;
  // Capabilities are kept only for the servers of the rows on screen (filter/page changes drop the others).
  const serverIds = data ? [...new Set(data.items.map((a) => a.serverId))].join(',') : '';
  useEffect(() => { retain(serverIds ? serverIds.split(',') : []); }, [serverIds, retain]);

  if (state.status === 'forbidden') return <Forbidden />;
  const serverOptions = servers.status === 'ready' ? servers.data.items : [];
  const renderActions = (app: ApplicationItem) => {
    const entry = caps.entries.get(app.serverId);
    const loaded = entry?.status === 'ready' ? entry.caps : null;
    const { items, reasons } = loaded ? rowMenu({
      app, canControl, canLogs, control: loaded.control, logs: loaded.logs,
      busy: (loaded.control?.targets ?? []).some((t) => t.name === app.name && t.pmId === app.pmId && isBusy(app.serverId, t.targetKey)), limitReached,
      onAction: (target, action) => { ask({ serverId: app.serverId, serverName: app.serverName, target, action }); },
      onLogs: (target) => { setLogView({ serverId: app.serverId, serverName: app.serverName, targetKey: target.targetKey, name: app.name }); },
    }) : { items: [], reasons: [] };
    if (loaded?.failed) reasons.unshift('Не вдалося перевірити можливості — відкрийте меню ще раз');
    return <ActionMenu name={`${app.name} на ${app.serverName}`} items={items} note={reasons.join('. ') || null}
      loading={!loaded} onOpen={() => { void ensure(app.serverId); }} />;
  };
  const notCurrent = data ? data.items.filter((a) => a.inventoryState !== 'current' || a.serverStatus !== 'online').length : 0;
  // A shared collection time is shown above the table only when every row has the same one; rows always keep theirs.
  const times = data ? [...new Set(data.items.map((a) => a.collectedAt))] : [];
  const collected = times.length === 1 ? formatDate(times[0] ?? null) : null;

  return (
    <section className="page" aria-labelledby="apps-title">
      <PageHeader title="Застосунки" titleId="apps-title"
        meta={<span>PM2-процеси всіх серверів.</span>} />

      <div className="toolbar" role="group" aria-label="Фільтри">
        <div className="field">
          <label htmlFor={serverFieldId}>Сервер</label>
          <select id={serverFieldId} value={serverId ?? ''} onChange={(e) => { setFilter('serverId', e.target.value); }}>
            <option value="">Усі сервери</option>
            {serverOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {serverId && !serverOptions.some((s) => s.id === serverId) ? <option value={serverId}>Обраний сервер</option> : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor={statusFieldId}>Статус процесу</label>
          <select id={statusFieldId} value={status ?? ''} onChange={(e) => { setFilter('status', e.target.value); }}>
            <option value="">Усі статуси</option>
            {PROCESS_STATUSES.map((s) => <option key={s} value={s}>{PROCESS_STATUS_LABELS[s]}</option>)}
          </select>
        </div>
      </div>

      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'not_found' ? <EmptyState title="Не знайдено">Перевірте фільтр.</EmptyState> : null}
      {state.status === 'error' ? (
        <ErrorState title={data ? 'Не вдалося оновити дані' : 'Не вдалося завантажити застосунки'} onRetry={reload}>
          {`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}${data ? ' Показано попередні дані.' : ''}`}
        </ErrorState>
      ) : null}
      {data && data.items.length === 0 ? (
        <EmptyState title={serverId || status ? 'Нічого не знайдено' : 'Ще немає даних про процеси'}>
          {serverId || status
            ? 'За цим фільтром процесів немає.'
            : 'Процеси з’являться, коли на сервері буде налаштовано PM2 exporter і агент передасть inventory.'}
        </EmptyState>
      ) : null}
      {data && data.items.length > 0 && notCurrent === 0 && collected ? (
        <p className="freshness" role="status"><span className="status status--ok">{`Усі рядки актуальні · зібрано ${collected}`}</span></p>
      ) : null}
      {data && notCurrent > 0 ? (
        <p className="notice notice--warning" role="status">
          {`${String(notCurrent)} з ${String(data.items.length)} рядків не актуальні (сервер офлайн, застарілий або недоступний inventory) — дивіться колонку «Дані».`}
        </p>
      ) : null}
      <CommandStatusList tracked={tracked} showServer />
      {data && data.items.length > 0 ? <ApplicationsTable items={data.items} showServer caption="PM2-процеси" renderActions={canControl || canLogs ? renderActions : undefined} /> : null}
      {data && (cursor || data.nextCursor) ? (
        <div className="pager">
          {cursor ? <button type="button" className="button" onClick={() => { goTo(null); }}>На першу сторінку</button> : null}
          {data.nextCursor ? <button type="button" className="button" onClick={() => { goTo(data.nextCursor); }}>Наступна сторінка</button> : null}
        </div>
      ) : null}
      {logView ? (
        <LogViewer key={`${logView.serverId}:${logView.targetKey}`} serverId={logView.serverId} serverName={logView.serverName}
          targetKey={logView.targetKey} name={logView.name} onClose={closeLogs} />
      ) : null}
      {dialog}
    </section>
  );
}
