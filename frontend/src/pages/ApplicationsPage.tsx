import { useCallback, useId } from 'react';
import { useSearchParams } from 'react-router';
import { applicationsApi, serversApi } from '../api/client';
import { PROCESS_STATUSES, type ProcessStatus } from '../api/types';
import { Forbidden } from '../auth/guards';
import { ApplicationsTable, PROCESS_STATUS_LABELS } from '../components/Inventory';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate } from './ServersPage';

// Read-only list of PM2 processes from all servers (ADR-016). Filters and the page cursor live in the URL, so the
// polled resource is keyed by them: switching a filter never shows rows of the previous filter (Task 007.1 rule).
// There are deliberately no start/stop/restart controls.

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

  if (state.status === 'forbidden') return <Forbidden />;
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;
  const serverOptions = servers.status === 'ready' ? servers.data.items : [];
  const notCurrent = data ? data.items.filter((a) => a.inventoryState !== 'current' || a.serverStatus !== 'online').length : 0;
  // A shared collection time is shown above the table only when every row has the same one; rows always keep theirs.
  const times = data ? [...new Set(data.items.map((a) => a.collectedAt))] : [];
  const collected = times.length === 1 ? formatDate(times[0] ?? null) : null;

  return (
    <section className="page" aria-labelledby="apps-title">
      <PageHeader title="Застосунки" titleId="apps-title"
        meta={<span>PM2-процеси всіх серверів. Керування й логи — на сторінці сервера.</span>} />

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
      {data && data.items.length > 0 ? <ApplicationsTable items={data.items} showServer caption="PM2-процеси" /> : null}
      {data && (cursor || data.nextCursor) ? (
        <div className="pager">
          {cursor ? <button type="button" className="button" onClick={() => { goTo(null); }}>На першу сторінку</button> : null}
          {data.nextCursor ? <button type="button" className="button" onClick={() => { goTo(data.nextCursor); }}>Наступна сторінка</button> : null}
        </div>
      ) : null}
    </section>
  );
}
