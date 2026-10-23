import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { applicationsApi, SEARCH_MAX_LENGTH, serversApi } from '../api/client';
import { type ApplicationItem, PROCESS_STATUSES, type ProcessStatus, type ServerApplications } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { ApplicationDetail, confirmedPresence, DetailPlaceholder, type DetailTab, type Presence } from '../components/ApplicationDetail';
import { ApplicationList, appIdentity, isLive, ListHead, ListSkeleton, PanelMessage } from '../components/ApplicationList';
import { PROCESS_STATUS_LABELS } from '../components/Inventory';
import { CommandStatusList, type CommandRequest, controlReady, rowMenu, useProcessCommands } from '../components/processActions';
import { ErrorState, formatRetry } from '../components/StatusMessage';
import { usePolledResource } from '../components/usePolledResource';
import { PHONE_QUERY, SPLIT_VIEW_QUERY, useMediaQuery } from '../components/useMediaQuery';
import { useServerCapabilities } from '../components/useServerCapabilities';
import { formatDate } from './ServersPage';

// PM2 processes of all servers (ADR-016) as a master-detail workspace (redesign B, stage 2). Filters, the name search
// and the page cursor live in the URL, so the polled list is keyed by them: switching a filter never shows rows of the
// previous filter (Task 007.1 rule). The search is server-side (keyset pages of 50, ordered by name and server);
// typing is debounced and writes one history entry per pause. Counts are only what the page itself shows — the API
// has no totals, so the page never claims "N of M".
//
// Layout: from 1280 px the compact list and the details of the selected process are side by side (~56/44), each
// scrolling on its own within the viewport height. Below 1280 px the list is full width and choosing a process opens
// its details as a separate (non-modal) view; «Назад до списку» returns to the same filters, page and scroll position.
//
// Selection is local state (not in the URL) and survives filter, search and page changes. It is identified by key +
// serverId + source + name (a PM2 id can be reused). When the process is not in the rows on screen, the page asks the
// existing GET /api/servers/:id/applications (polled like the list, only while needed) to tell apart: outside the
// filter / on another page (still present), confirmed gone from a current inventory, not confirmable (stale or
// unavailable inventory, offline server, truncated answer), the check failed, or access revoked (403/404). Only a
// confirmed process shows its data as current and may be controlled; nothing is ever substituted by another process.
//
// Actions are the shared processActions (permissions, API switch, broker report, allowlist + broker-confirmed target,
// live inventory, confirmation, tracking). Capabilities are loaded per server only when needed (rows' servers and the
// selected one are retained) and checked again right before a command is sent. The whole view is mounted per session:
// a new session starts without a selection, details or logs.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,400}$/;
export const SEARCH_DEBOUNCE_MS = 300;
/** GET /api/servers/:id/applications returns at most this many rows: a miss in a full answer proves nothing. */
const SERVER_APPS_LIMIT = 500;

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
type Filter = Pick<ReturnType<typeof readFilter>, 'serverId' | 'status' | 'q'>;

const matchesFilter = (app: ApplicationItem, f: Filter) => (!f.serverId || app.serverId === f.serverId) && (!f.status || app.status === f.status)
  && (!f.q || app.name.toLowerCase().includes(f.q.toLowerCase()));

/** Where the selected process is, judged from the server's current inventory (when it is not among the rows). */
function presenceFromInventory(inv: ServerApplications, id: string, filter: Filter): { presence: Presence; app: ApplicationItem | null } {
  const found = inv.items.find((a) => appIdentity(a) === id) ?? null;
  if (found) return { presence: { kind: matchesFilter(found, filter) ? 'other_page' : 'filtered' }, app: found };
  if (inv.items.length >= SERVER_APPS_LIMIT) return { presence: { kind: 'uncertain', why: 'відповідь сервера обмежена 500 процесами' }, app: null };
  if (inv.serverStatus !== 'online') return { presence: { kind: 'uncertain', why: 'сервер не онлайн' }, app: null };
  if (inv.inventory.state === 'current') return { presence: { kind: 'missing', collectedAt: inv.inventory.collectedAt }, app: null };
  const why = inv.inventory.state === 'stale' ? 'inventory сервера застарілий' : inv.inventory.state === 'unavailable' ? 'inventory сервера недоступний' : 'сервер ще не передавав inventory';
  return { presence: { kind: 'uncertain', why }, app: null };
}

const timeFormat = new Intl.DateTimeFormat('uk-UA', { timeStyle: 'medium' });

export function ApplicationsPage() {
  const { state: auth } = useAuth();
  const sessionKey = auth.status === 'authenticated' ? auth.session.csrfToken : 'anonymous';
  return <ApplicationsView key={sessionKey} />;
}

interface Selection { id: string; serverId: string; last: ApplicationItem }

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
  const split = useMediaQuery(SPLIT_VIEW_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  // Below 1280 px: the list or the details of the selection (a separate view).
  const [view, setView] = useState<'list' | 'detail'>('list');
  const listScroll = useRef(0);
  const restoreList = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const [historyVersion, setHistoryVersion] = useState(0);
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
  const resetFilters = () => {
    setDraft('');
    const next = new URLSearchParams(params);
    for (const name of ['serverId', 'status', 'q', 'cursor']) next.delete(name);
    setParams(next);
  };
  const goTo = (nextCursor: string | null) => {
    const next = new URLSearchParams(params);
    if (nextCursor) next.set('cursor', nextCursor);
    else next.delete('cursor');
    setParams(next);
  };

  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;

  // The selected process among the rows on screen (same identity, not just the same key).
  const onPage = selection && data ? data.items.find((a) => appIdentity(a) === selection.id) ?? null : null;
  // Not among the rows: check the server's current inventory (polled only while needed; never another process).
  const checkServer = selection && !onPage ? selection.serverId : null;
  const loadCheck = useCallback((signal: AbortSignal) => (checkServer ? applicationsApi.forServer(checkServer, signal) : Promise.resolve(null)), [checkServer]);
  const { state: check } = usePolledResource(loadCheck, `check:${checkServer ?? ''}`);

  let presence: Presence = { kind: 'checking' };
  let selected: ApplicationItem | null = selection?.last ?? null;
  if (selection && onPage) {
    presence = { kind: 'page' };
    selected = onPage;
  } else if (selection) {
    if (check.status === 'forbidden' || check.status === 'not_found') presence = { kind: 'revoked' };
    else if (check.status === 'ready' && check.data) {
      const found = presenceFromInventory(check.data, selection.id, { serverId, status, q });
      presence = found.presence;
      if (found.app) selected = found.app;
    } else if (check.status === 'error') presence = { kind: 'unverified' };
  }
  // Remember the latest confirmed data of the selection (shown, labelled, while a later check is pending or fails).
  const confirmedNow = selection && selected && confirmedPresence(presence) && selected !== selection.last ? selected : null;
  if (selection && confirmedNow) setSelection({ ...selection, last: confirmedNow });

  // Capabilities are kept for the servers of the rows on screen and of the selection.
  const serverIds = [...new Set([...(data ? data.items.map((a) => a.serverId) : []), ...(selection ? [selection.serverId] : [])])].sort().join(',');
  useEffect(() => { retain(serverIds ? serverIds.split(',') : []); }, [serverIds, retain]);

  const select = useCallback((app: ApplicationItem) => {
    setSelection({ id: appIdentity(app), serverId: app.serverId, last: app });
    void ensure(app.serverId);
    if (!split) {
      listScroll.current = window.scrollY;
      focusHeading.current = true;
      setView('detail');
    }
  }, [ensure, split]);
  const backToList = () => { restoreList.current = true; setView('list'); };

  const showDetail = !split && view === 'detail' && selection !== null;
  // Separate views: the details start at the top with focus on their heading; going back restores the list's
  // scroll position and focuses the selected row (if it is still on the page).
  useLayoutEffect(() => {
    if (showDetail && focusHeading.current) {
      focusHeading.current = false;
      window.scrollTo(0, 0);
      heading.current?.focus();
    }
    if (!showDetail && restoreList.current) {
      restoreList.current = false;
      window.scrollTo(0, listScroll.current);
      const id = selection?.id;
      const row = id ? [...document.querySelectorAll<HTMLElement>('[data-app-row]')].find((el) => el.dataset.appRow === id) : undefined;
      row?.focus({ preventScroll: true });
    }
  }, [showDetail, selection?.id]);

  if (state.status === 'forbidden') return <Forbidden />;
  const serverOptions = servers.status === 'ready' ? servers.data.items : [];
  const lastSeenOf = (id: string) => serverOptions.find((s) => s.id === id)?.lastSeenAt ?? null;

  const loadedCaps = (app: ApplicationItem) => {
    const entry = caps.entries.get(app.serverId);
    return entry?.status === 'ready' ? entry.caps : null;
  };
  const menuFor = (app: ApplicationItem, confirmed: boolean) => {
    const loaded = loadedCaps(app);
    const menu = loaded ? rowMenu({
      app, canControl, canLogs, control: loaded.control, logs: loaded.logs,
      busy: (loaded.control?.targets ?? []).some((t) => t.name === app.name && t.pmId === app.pmId && isBusy(app.serverId, t.targetKey)), limitReached,
      onAction: (target, action) => { ask({ serverId: app.serverId, serverName: app.serverName, target, action }); },
      onLogs: () => { setTab('logs'); },
    }) : { items: [], reasons: [] as string[], rowReasons: [] as string[] };
    if (loaded?.failed) menu.reasons.unshift('Не вдалося перевірити можливості — відкрийте меню ще раз');
    // An unconfirmed process is never controlled: the commands stay visible but blocked.
    if (!confirmed) return { loaded, items: menu.items.map((i) => (i.key === 'logs' ? i : { ...i, disabled: true })), reasons: ['Наявність процесу не підтверджено — команди заблоковано', ...menu.reasons] };
    return { loaded, items: menu.items, reasons: menu.reasons };
  };

  const notCurrent = data ? data.items.filter((a) => !isLive(a)).length : 0;
  // A shared collection time is shown only when every row has the same one; rows always keep their own warnings.
  const times = data ? [...new Set(data.items.map((a) => a.collectedAt))] : [];
  const shared = times.length === 1 ? times[0] ?? null : null;
  const collected = shared ? { full: formatDate(shared), time: timeFormat.format(new Date(shared)) } : null;
  const filtered = Boolean(serverId || status || q);
  const refreshed = state.status === 'ready' ? state.receivedAt : state.status === 'error' ? state.receivedAt : null;

  let detail = null;
  if (selection && selected) {
    const confirmed = confirmedPresence(presence);
    const { loaded, items, reasons } = menuFor(selected, confirmed);
    detail = (
      <ApplicationDetail key={selection.id} app={selected} presence={presence} tab={tab} onTab={setTab} caps={loaded} items={items} reasons={reasons}
        canControl={canControl} canLogs={canLogs} historyVersion={historyVersion} lastSeenAt={lastSeenOf(selected.serverId)}
        onMenuOpen={() => { void ensure(selected.serverId); }} onBack={split ? undefined : backToList} headingRef={heading} />
    );
  }

  const filtersActive = filtered || Boolean(cursor) || draft !== '';
  const empty = data !== null && data.items.length === 0;
  const pager = data && (cursor || data.nextCursor) ? (
    <div className="pager app-list__footer" role="group" aria-label="Сторінки списку">
      {cursor ? <button type="button" className="button button--small" aria-label="На першу сторінку" onClick={() => { goTo(null); }}>« Перша</button> : null}
      {data.nextCursor ? <button type="button" className="button button--small" aria-label="Наступна сторінка" onClick={() => { goTo(data.nextCursor); }}>Наступна »</button> : null}
    </div>
  ) : null;
  const emptyText = q ? `Немає застосунків, у назві яких є «${q}»${serverId || status ? ' (з урахуванням фільтрів)' : ''}.`
    : filtered ? 'Немає застосунків за поточним пошуком і фільтрами.'
      : can('servers:manage') ? 'Процеси з’являться, коли на сервері буде налаштовано PM2 exporter і агент передасть inventory.'
        : 'Ви бачите лише сервіси, до яких адміністратор надав доступ. Наданих сервісів немає або їхній inventory ще не надійшов.';
  // Phone details (APP-14): the global header and the list filters give their height to the log; «До списку
  // застосунків» brings them back with the same values. Tablet details (APP-15) keep both above the panel.
  const chrome = !(showDetail && phone);

  return (
    <section className={`page page--workspace${split ? ' page--split' : ''}`} aria-labelledby="apps-title">
      {chrome ? (
        <header className="workspace-header">
          <p className="workspace-header__eyebrow">Робочий простір</p>
          <h1 id="apps-title" className="page__title">Застосунки</h1>
        </header>
      ) : <h1 id="apps-title" className="visually-hidden">Застосунки</h1>}

      <CommandStatusList tracked={tracked} showServer />

      {chrome ? (
        <div className="toolbar workspace-filters" role="group" aria-label="Фільтри">
          <div className="field field--search">
            <label htmlFor={searchFieldId}>Пошук за назвою</label>
            <div className="search-box">
              <input id={searchFieldId} type="search" value={draft} maxLength={SEARCH_MAX_LENGTH} autoComplete="off" spellCheck={false} placeholder="Наприклад, app-api"
                onChange={(e) => { setDraft(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') commitSearch(draft); }} />
              {draft ? <button type="button" className="button button--small" onClick={() => { setDraft(''); commitSearch(''); }}>Очистити</button> : null}
            </div>
          </div>
          <div className="field field--select">
            <label htmlFor={serverFieldId}>Сервер</label>
            <select id={serverFieldId} value={serverId ?? ''} onChange={(e) => { setFilter('serverId', e.target.value); }}>
              <option value="">Усі сервери</option>
              {serverOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {serverId && !serverOptions.some((s) => s.id === serverId) ? <option value={serverId}>Обраний сервер</option> : null}
            </select>
          </div>
          <div className="field field--select">
            <label htmlFor={statusFieldId}>Статус</label>
            <select id={statusFieldId} value={status ?? ''} onChange={(e) => { setFilter('status', e.target.value); }}>
              <option value="">Усі статуси</option>
              {PROCESS_STATUSES.map((s) => <option key={s} value={s}>{PROCESS_STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          {filtersActive && !empty ? <button type="button" className="button toolbar__reset" onClick={resetFilters}>Скинути фільтри</button> : null}
        </div>
      ) : null}

      {showDetail ? detail : (
        <div className="workspace">
          <section className="app-list" aria-label="Список застосунків">
            <div className="app-list__caption">
              <span className="num">{data ? `На цій сторінці: ${String(data.items.length)}` : state.status === 'loading' ? 'Завантаження…' : 'Список недоступний'}</span>
              <span title={refreshed ? `Оновлено ${timeFormat.format(refreshed)}` : undefined}>
                {state.status === 'ready' && state.refreshing ? 'Оновлення…'
                  : data && data.items.length > 0 ? (notCurrent > 0 ? `Є неактуальні дані: ${String(notCurrent)}` : collected ? `Усі дані актуальні · ${collected.time}` : 'Усі дані актуальні') : null}
              </span>
            </div>
            {state.status === 'error' ? (
              <div className="app-list__error">
                <ErrorState title={data ? 'Не вдалося оновити дані' : 'Не вдалося завантажити застосунки'} onRetry={reload}>
                  {`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}${data ? ' Показано попередні дані.' : ''}`}
                </ErrorState>
              </div>
            ) : null}
            {state.status === 'loading' ? <><ListHead /><ListSkeleton /><p role="status" className="visually-hidden">Завантаження застосунків…</p></> : null}
            {state.status === 'not_found' ? <PanelMessage symbol="⌕" title="Не знайдено"><p className="hint">Перевірте фільтр.</p></PanelMessage> : null}
            {empty ? (
              <>
                <ListHead />
                <PanelMessage symbol="⌕" title={filtered ? 'Нічого не знайдено' : 'Ще немає даних про процеси'}>
                  <p className="hint">{emptyText}</p>
                  {filtersActive ? <button type="button" className="button" onClick={resetFilters}>Скинути фільтри</button> : null}
                </PanelMessage>
              </>
            ) : null}
            {data && data.items.length > 0 ? <ApplicationList items={data.items} selected={selection?.id ?? null} onSelect={select} label="PM2-процеси" /> : null}
            {pager}
          </section>
          {split ? <div className="workspace__detail">{detail ?? <DetailPlaceholder loading={state.status === 'loading'} />}</div> : null}
        </div>
      )}
      {dialog}
    </section>
  );
}
