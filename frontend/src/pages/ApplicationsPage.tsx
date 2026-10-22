import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { applicationsApi, SEARCH_MAX_LENGTH, serversApi } from '../api/client';
import { type ApplicationItem, PROCESS_STATUSES, type ProcessStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { ActionMenu } from '../components/ActionMenu';
import { ApplicationsTable, PROCESS_STATUS_LABELS } from '../components/Inventory';
import { ApplicationDetail, type DetailTab } from '../components/ApplicationDetail';
import { CommandStatusList, type CommandRequest, controlReady, rowMenu, useProcessCommands } from '../components/processActions';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';
import { useServerCapabilities } from '../components/useServerCapabilities';
import { formatDate } from './ServersPage';

// PM2 processes of all servers (ADR-016). Filters, the name search and the page cursor live in the URL, so the polled
// resource is keyed by them: switching a filter never shows rows of the previous filter (Task 007.1 rule). The search
// is server-side (all applications, keyset pages); typing is debounced and writes one history entry per pause.
//
// Row actions (start/stop/restart, logs) are the same as on the server page (processActions) and follow the same
// rules: permissions, API switch, broker report, allowlist + broker-confirmed target, live inventory. Capabilities are
// loaded per server only when a row menu or panel is opened (useServerCapabilities) — no polling per server or per row
// — and checked again right before a command is sent. Every action is addressed by the row's serverId + confirmed
// targetKey. One application can be expanded (ApplicationDetail): its tabs load only when opened; a new list (filter,
// search, page) or a row that disappears or changes identity closes it. The whole view is mounted per session.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,400}$/;
export const SEARCH_DEBOUNCE_MS = 300;

function readFilter(params: URLSearchParams) {
  const serverId = params.get('serverId');
  const status = params.get('status');
  const cursor = params.get('cursor');
  const q = (params.get('q') ?? '').trim();
  return {
    serverId: serverId && UUID_RE.test(serverId) ? serverId : null,
    status: status && (PROCESS_STATUSES as readonly string[]).includes(status) ? status as ProcessStatus : null,
    cursor: cursor && CURSOR_RE.test(cursor) ? cursor : null,
    q: q !== '' && q.length <= SEARCH_MAX_LENGTH ? q : null,
  };
}

export function ApplicationsPage() {
  const { state: auth } = useAuth();
  const sessionKey = auth.status === 'authenticated' ? auth.session.csrfToken : 'anonymous';
  return <ApplicationsView key={sessionKey} />;
}

interface Expanded { listKey: string; key: string; name: string; tab: DetailTab }

function ApplicationsView() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = readFilter(params);
  const { serverId, status, cursor, q } = filter;
  const key = `${serverId ?? ''}|${status ?? ''}|${q ?? ''}|${cursor ?? ''}`;
  const load = useCallback((signal: AbortSignal) => applicationsApi.list({ serverId, status, cursor, q }, signal), [serverId, status, cursor, q]);
  const { state, reload } = usePolledResource(load, key);
  const loadServers = useCallback((signal: AbortSignal) => serversApi.list(signal), []);
  const { state: servers } = usePolledResource(loadServers, 'servers');
  const serverFieldId = useId();
  const statusFieldId = useId();
  const searchFieldId = useId();
  const canControl = can('processes:control');
  const canLogs = can('logs:read');
  const caps = useServerCapabilities({ canControl, canLogs });
  const { ensure, invalidate, retain } = caps;
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const refocus = useRef<string | null>(null);
  const onChanged = useCallback((changed: string) => { invalidate(changed); reload(); setHistoryVersion((v) => v + 1); }, [invalidate, reload]);
  // Right before the POST: the target must still be confirmed, allowed and controllable (fresh capabilities).
  const verify = useCallback(async (request: CommandRequest): Promise<string | null> => {
    const fresh = await ensure(request.serverId, { fresh: true });
    if (!fresh) return 'Не вдалося перевірити стан керування. Спробуйте ще раз.';
    const target = fresh.control?.targets.find((t) => t.targetKey === request.target.targetKey);
    const same = target && target.name === request.target.name && target.pmId === request.target.pmId && target.matchStatus === 'ok' && target.actions.includes(request.action);
    return controlReady(fresh.control) && same ? null : 'Стан процесу або керування змінився — дію не надіслано. Відкрийте меню ще раз.';
  }, [ensure]);
  const { ask, dialog, tracked, isBusy, limitReached } = useProcessCommands({ onChanged, verify });

  // Search box: local draft, committed to the URL after a pause; Back/Forward bring the URL value back into the box
  // (only when it really differs, so a trailing space being typed is not lost when the debounced value lands).
  const [draft, setDraft] = useState(q ?? '');
  const [urlQ, setUrlQ] = useState(q ?? '');
  if ((q ?? '') !== urlQ) {
    setUrlQ(q ?? '');
    if (draft.trim() !== (q ?? '')) setDraft(q ?? '');
  }
  const commitSearch = useCallback((value: string) => {
    const next = value.trim().slice(0, SEARCH_MAX_LENGTH);
    if (next === (q ?? '')) return;
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set('q', next);
      else p.delete('q');
      p.delete('cursor'); // a new search starts from the first page
      return p;
    });
  }, [q, setParams]);
  useEffect(() => {
    const timer = setTimeout(() => { commitSearch(draft); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [draft, commitSearch]);

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

  // A new list (filter, search, page) closes the panel; so does a row that vanished or changed identity (same key,
  // other name) in a fresh answer. Derived during render (no effect): the panel never shows another process.
  const expandedApp = expanded && data && expanded.listKey === key
    ? data.items.find((a) => a.key === expanded.key && a.name === expanded.name) ?? null : null;
  if (expanded && (expanded.listKey !== key || (state.status === 'ready' && !expandedApp))) setExpanded(null);
  // After collapsing, focus goes back to the row's toggle (if the row is still there).
  useEffect(() => {
    if (expanded || !refocus.current) return;
    const want = refocus.current;
    [...document.querySelectorAll<HTMLElement>('[data-row-toggle]')].find((el) => el.dataset.rowToggle === want)?.focus();
    refocus.current = null;
  }, [expanded]);

  const open = useCallback((app: ApplicationItem, tab: DetailTab) => {
    setExpanded({ listKey: key, key: app.key, name: app.name, tab });
    void ensure(app.serverId);
  }, [ensure, key]);
  const collapse = useCallback((app: ApplicationItem) => { refocus.current = app.key; setExpanded(null); }, []);

  if (state.status === 'forbidden') return <Forbidden />;
  const serverOptions = servers.status === 'ready' ? servers.data.items : [];
  const loadedCaps = (app: ApplicationItem) => {
    const entry = caps.entries.get(app.serverId);
    return entry?.status === 'ready' ? entry.caps : null;
  };
  const menuFor = (app: ApplicationItem) => {
    const loaded = loadedCaps(app);
    const menu = loaded ? rowMenu({
      app, canControl, canLogs, control: loaded.control, logs: loaded.logs,
      busy: (loaded.control?.targets ?? []).some((t) => t.name === app.name && t.pmId === app.pmId && isBusy(app.serverId, t.targetKey)), limitReached,
      onAction: (target, action) => { ask({ serverId: app.serverId, serverName: app.serverName, target, action }); },
      // In this list logs open inline, in the application's panel.
      onLogs: () => { open(app, 'logs'); },
    }) : { items: [], reasons: [] as string[], rowReasons: [] as string[] };
    if (loaded?.failed) menu.reasons.unshift('Не вдалося перевірити можливості — відкрийте меню ще раз');
    return { loaded, ...menu };
  };
  const renderActions = (app: ApplicationItem) => {
    const { loaded, items, reasons } = menuFor(app);
    return <ActionMenu name={`${app.name} на ${app.serverName}`} items={items} note={reasons.join('. ') || null}
      loading={!loaded} onOpen={() => { void ensure(app.serverId); }} />;
  };
  const expansion = {
    expandedKey: expandedApp?.key ?? null,
    onToggle: (app: ApplicationItem) => { if (expandedApp?.key === app.key) collapse(app); else open(app, 'overview'); },
    renderDetail: (app: ApplicationItem) => {
      const { loaded, items, reasons } = menuFor(app);
      return (
        <ApplicationDetail app={app} tab={expanded?.tab ?? 'overview'} onTab={(tab) => { setExpanded({ listKey: key, key: app.key, name: app.name, tab }); }}
          onClose={() => { collapse(app); }} caps={loaded} items={items} reasons={reasons}
          canControl={canControl} canLogs={canLogs} historyVersion={historyVersion} />
      );
    },
  };
  const notCurrent = data ? data.items.filter((a) => a.inventoryState !== 'current' || a.serverStatus !== 'online').length : 0;
  // A shared collection time is shown above the table only when every row has the same one; rows always keep theirs.
  const times = data ? [...new Set(data.items.map((a) => a.collectedAt))] : [];
  const collected = times.length === 1 ? formatDate(times[0] ?? null) : null;
  const filtered = Boolean(serverId || status || q);

  return (
    <section className="page" aria-labelledby="apps-title">
      <PageHeader title="Застосунки" titleId="apps-title"
        meta={<span>PM2-процеси всіх серверів.</span>} />

      <div className="toolbar" role="group" aria-label="Фільтри">
        <div className="field field--search">
          <label htmlFor={searchFieldId}>Пошук за назвою</label>
          <div className="search-box">
            <input id={searchFieldId} type="search" value={draft} maxLength={SEARCH_MAX_LENGTH} autoComplete="off" spellCheck={false}
              onChange={(e) => { setDraft(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') commitSearch(draft); }} />
            {draft ? <button type="button" className="button button--small" onClick={() => { setDraft(''); commitSearch(''); }}>Очистити</button> : null}
          </div>
        </div>
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
        <EmptyState title={filtered ? 'Нічого не знайдено' : 'Ще немає даних про процеси'}>
          {q ? `Немає застосунків, у назві яких є «${q}»${serverId || status ? ' (з урахуванням фільтрів)' : ''}.`
            : filtered ? 'За цим фільтром процесів немає.'
              : can('servers:manage') ? 'Процеси з’являться, коли на сервері буде налаштовано PM2 exporter і агент передасть inventory.'
                : 'Ви бачите лише сервіси, до яких адміністратор надав доступ. Наданих сервісів немає або їхній inventory ще не надійшов.'}
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
      {data && data.items.length > 0 ? (
        <ApplicationsTable items={data.items} showServer caption="PM2-процеси" expansion={expansion}
          renderActions={canControl || canLogs ? renderActions : undefined} />
      ) : null}
      {data && (cursor || data.nextCursor) ? (
        <div className="pager">
          {cursor ? <button type="button" className="button" onClick={() => { goTo(null); }}>На першу сторінку</button> : null}
          {data.nextCursor ? <button type="button" className="button" onClick={() => { goTo(data.nextCursor); }}>Наступна сторінка</button> : null}
        </div>
      ) : null}
      {dialog}
    </section>
  );
}
