import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, fetchAuditPage } from '../api/client';
import type { AuditItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { actionText, actorOf, contextRows, detailRows, eventLabel, fullTime, isKnownEvent, listTime, OUTCOME, reasonLabel, searchText, targetOf, technicalRows } from '../components/auditEvents';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { formatClock } from '../components/time';
import { StatusIndicator } from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';

// Audit log (ADR-011; design AUD-01…05, docs/design/part-01, admin only: audit:read). GET /api/audit returns pages of
// 25 newest-first BY ID (keyset `id < beforeId`) — the server's order is kept as it is, chunks are appended in that
// order (never re-sorted by time on the client) and duplicates are dropped by the string id (ids may exceed the
// safe integer range). «Показати старіші» asks for the next chunk with the API's nextBeforeId; a failed chunk keeps
// everything already loaded and is retried with the same cursor. «Оновити» explicitly reloads the newest chunk and
// starts the list from the top (accumulated older chunks are dropped; no silent inserts above the row being read).
// Nothing is polled. Search and filters work only on the loaded events and say so. Details open in the shared modal
// drawer from the loaded row only (no extra request). 401 ends the session; 403 shows «forbidden» and drops the list.

const RECORDS_QUERY = '(max-width: 760px)';

interface Filters { q: string; event: string | null; outcome: AuditItem['outcome'] | null }
const NO_FILTERS: Filters = { q: '', event: null, outcome: null };
const active = (f: Filters) => f.q.trim() !== '' || f.event !== null || f.outcome !== null;
function matches(item: AuditItem, f: Filters) {
  const q = f.q.trim().toLocaleLowerCase('uk-UA');
  return (!f.event || item.event === f.event) && (!f.outcome || item.outcome === f.outcome) && (q === '' || searchText(item).includes(q));
}

type Failure = { retryAfterSeconds: number | null };
interface Journal {
  items: AuditItem[];
  next: string | null;
  /** Local time of the newest-chunk answer the list starts with. */
  receivedAt: number | null;
  status: 'loading' | 'ready' | 'error' | 'forbidden';
  error: Failure | null;
  /** The older chunk: in flight, or failed (retry repeats the same cursor). */
  more: 'idle' | 'loading' | Failure;
  /** «Оновити» in flight / failed (the loaded list stays until a new first chunk arrives). */
  refresh: 'idle' | 'loading' | Failure;
}
const INITIAL: Journal = { items: [], next: null, receivedAt: null, status: 'loading', error: null, more: 'idle', refresh: 'idle' };

function Outcome({ item }: { item: AuditItem }) {
  const o = OUTCOME[item.outcome];
  return <StatusIndicator tone={o.tone}>{o.label}</StatusIndicator>;
}

/** The action in words; an unknown event code stays visibly a code (plain text). */
function ActionName({ item }: { item: AuditItem }) {
  return isKnownEvent(item.event) ? <>{actionText(item)}</> : <span className="mono">{actionText(item)}</span>;
}

type RowsRef = (el: HTMLElement | null) => void;

function AuditTable({ items, onOpen, rowsRef }: { items: AuditItem[]; onOpen: (i: AuditItem) => void; rowsRef: RowsRef }) {
  return (
    <div className="audit__scroll workpanel__rows" ref={rowsRef}>
      <table className="table table--dense audit-table">
        <caption className="visually-hidden">Події журналу аудиту в порядку журналу, нові зверху</caption>
        <thead>
          <tr><th scope="col">Час · місцевий</th><th scope="col">Ініціатор</th><th scope="col">Дія</th><th scope="col">Ціль · контекст</th><th scope="col">Результат</th></tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const a = actorOf(item);
            const t = targetOf(item);
            return (
              <tr key={item.id}>
                <td className="date"><time dateTime={item.occurredAt}>{listTime(item.occurredAt)}</time></td>
                <td><span className="audit__actor" title={a.full ?? undefined}>{a.label}</span>{a.note ? <span className="cell-meta">{a.note}</span> : null}</td>
                <th scope="row">
                  <button type="button" className="link-button audit__open" aria-haspopup="dialog" onClick={() => { onOpen(item); }}><ActionName item={item} /></button>
                </th>
                <td><span className="audit__target">{t.primary}</span>{t.secondary ? <span className="cell-meta">{t.secondary}</span> : null}</td>
                <td><Outcome item={item} />{item.details.reason ? <span className="cell-meta">{reasonLabel(item.details.reason)}</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditRecords({ items, onOpen, rowsRef }: { items: AuditItem[]; onOpen: (i: AuditItem) => void; rowsRef: RowsRef }) {
  return (
    <ul ref={rowsRef} className="audit-records workpanel__rows" aria-label="Події журналу аудиту в порядку журналу, нові зверху">
      {items.map((item) => {
        const a = actorOf(item);
        const t = targetOf(item);
        return (
          <li key={item.id}>
            <article className="audit-record" aria-label={`${actionText(item)}: ${OUTCOME[item.outcome].label}`}>
              <div className="audit-record__head">
                <button type="button" className="link-button audit__open" aria-haspopup="dialog" onClick={() => { onOpen(item); }}><ActionName item={item} /></button>
                <Outcome item={item} />
              </div>
              <p className="audit-record__line">{t.secondary ? `${t.primary} · ${t.secondary}` : t.primary}</p>
              {item.details.reason ? <p className="audit-record__line secondary">{reasonLabel(item.details.reason)}</p> : null}
              <p className="audit-record__meta"><span className="audit__actor">{a.label}</span><time dateTime={item.occurredAt}>{listTime(item.occurredAt)}</time></p>
              {a.note ? <p className="audit-record__line secondary">{a.note}</p> : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

function AuditDrawer({ item, onClose, fallbackFocus }: { item: AuditItem; onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  const a = actorOf(item);
  const t = targetOf(item);
  const rows = detailRows(item.details);
  const d = item.details;
  const control = item.event.startsWith('process.command_') && item.outcome === 'success';
  return (
    <Dialog title={actionText(item)} eyebrow="Подія аудиту" className="dialog--drawer" onClose={onClose} fallbackFocus={fallbackFocus}
      headerAction={<button type="button" className="button button--ghost icon-button" aria-label="Закрити деталі" onClick={onClose}>✕</button>}
      actions={<button type="button" className="button" onClick={onClose}>Закрити</button>}>
      <section className="drawer-section" aria-labelledby="audit-result">
        <h3 id="audit-result" className="drawer-section__title">Результат</h3>
        <Outcome item={item} />
        {d.reason ? <p className="hint">{`Причина: ${reasonLabel(d.reason)}`}</p> : null}
        {control ? <p className="hint">Успіх керуючої дії не означає, що процес зараз працює справно: поточний стан — у «Застосунках».</p> : null}
      </section>
      <section className="drawer-section" aria-labelledby="audit-who">
        <h3 id="audit-who" className="drawer-section__title">Хто, коли й над чим</h3>
        <dl className="facts">
          <dt>Час</dt><dd><time dateTime={item.occurredAt}>{fullTime(item.occurredAt)}</time></dd>
          <dt>Ініціатор</dt><dd>{a.label}{a.note ? <span className="cell-meta">{a.note}</span> : null}</dd>
          <dt>Ціль</dt><dd>{t.primary}</dd>
          <dt>Контекст</dt><dd>{t.secondary ?? '—'}</dd>
        </dl>
      </section>
      <section className="drawer-section" aria-labelledby="audit-origin">
        <h3 id="audit-origin" className="drawer-section__title">Учасники й походження назв</h3>
        <dl className="facts">
          {contextRows(item).map((r) => <div key={r.label} className="facts__row"><dt>{r.label}</dt><dd>{r.value}<span className="cell-meta">{r.origin}</span></dd></div>)}
        </dl>
        <p className="hint">Email і назви серверів — поточні на момент перегляду, а не знімок на момент події.</p>
      </section>
      <section className="drawer-section" aria-labelledby="audit-details">
        <h3 id="audit-details" className="drawer-section__title">Подробиці</h3>
        {rows.length > 0 ? (
          <dl className="facts">{rows.map(([label, value]) => <div key={label} className="facts__row"><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        ) : <p className="hint">Подробиць ця подія не містить.</p>}
      </section>
      <details className="disclosure audit__ids">
        <summary>Технічні ідентифікатори</summary>
        <dl className="facts mono">
          {technicalRows(item).map(([label, v]) => <div key={label} className="facts__row"><dt>{label}</dt><dd>{v}</dd></div>)}
        </dl>
      </details>
      <p className="hint">Показано лише дозволені поля події. Секрети й сирі дані не виводяться.</p>
    </Dialog>
  );
}

export function AuditPage() {
  const { sessionExpired, bindSession } = useAuth();
  const ids = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const records = useMediaQuery(RECORDS_QUERY);
  const [journal, setJournal] = useState<Journal>(INITIAL);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const seq = useRef(0);

  /**
   * One request at a time; only the latest one of this session may change the journal (abort is a helper — late
   * answers are dropped by the sequence and the session binding even when the transport already delivered them).
   */
  const request = useCallback((kind: 'first' | 'more' | 'refresh', cursor: string | null) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const mine = ++seq.current;
    const binding = bindSession();
    const live = () => mine === seq.current && !current.signal.aborted && binding.current();
    fetchAuditPage(cursor, current.signal).then(
      (page) => {
        if (!live()) return;
        setJournal((j) => {
          if (kind === 'more') {
            const seen = new Set(j.items.map((i) => i.id));
            return { ...j, items: [...j.items, ...page.items.filter((i) => !seen.has(i.id))], next: page.nextBeforeId, more: 'idle' };
          }
          return { items: page.items, next: page.nextBeforeId, receivedAt: Date.now(), status: 'ready', error: null, more: 'idle', refresh: 'idle' };
        });
        if (kind === 'refresh' && scrollRef.current) scrollRef.current.scrollTop = 0;
      },
      (error: unknown) => {
        if (!live() || !(error instanceof ApiError) || error.kind === 'aborted') return;
        if (error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error.kind === 'forbidden') { setOpenId(null); setJournal({ ...INITIAL, status: 'forbidden' }); return; }
        const failure = { retryAfterSeconds: error.retryAfterSeconds };
        setJournal((j) => (kind === 'more' ? { ...j, more: failure } : kind === 'refresh' ? { ...j, refresh: failure } : { ...j, status: 'error', error: failure }));
      },
    );
  }, [bindSession, sessionExpired]);

  useEffect(() => {
    request('first', null);
    return () => { seq.current += 1; controller.current?.abort(); };
  }, [request]);

  if (journal.status === 'forbidden') return <Forbidden />;
  const { items } = journal;
  const shown = items.filter((i) => matches(i, filters));
  const open = openId ? items.find((i) => i.id === openId) ?? null : null;
  const filtering = active(filters);
  const events = [...new Set(items.map((i) => i.event))].sort((x, y) => eventLabel(x).localeCompare(eventLabel(y), 'uk'));
  const loadingMore = journal.more === 'loading';
  const moreFailed = typeof journal.more === 'object' ? journal.more : null;
  const refreshFailed = typeof journal.refresh === 'object' ? journal.refresh : null;
  const ready = journal.status === 'ready';

  const retryFirst = () => { setJournal(INITIAL); request('first', null); };
  const loadOlder = () => {
    if (!journal.next) return;
    setJournal((j) => ({ ...j, more: 'loading', refresh: 'idle' }));
    request('more', journal.next);
  };
  const refresh = () => {
    setOpenId(null);
    setJournal((j) => ({ ...j, refresh: 'loading', more: 'idle' }));
    request('refresh', null);
  };
  const rowsRef: RowsRef = (el) => { scrollRef.current = el; };

  return (
    <section className="page page--workspace audit" aria-labelledby="audit-title">
      <header className="page-header">
        <div className="page-header__main"><h1 id="audit-title" className="page__title" ref={titleRef} tabIndex={-1}>Журнал аудиту</h1></div>
        {ready ? (
          <div className="page-header__actions">
            <button type="button" className="button" onClick={refresh} disabled={journal.refresh === 'loading'}>{journal.refresh === 'loading' ? 'Оновлення…' : 'Оновити'}</button>
          </div>
        ) : null}
      </header>

      <div className="toolbar workspace-filters audit__filters" role="group" aria-label="Пошук і фільтри серед завантажених подій" aria-describedby={`${ids}-hint`}>
        <div className="field field--search">
          <label htmlFor={`${ids}-q`}>Пошук серед завантажених подій</label>
          <input id={`${ids}-q`} type="search" value={filters.q} maxLength={100} autoComplete="off" spellCheck={false} placeholder="Дія, ціль або ID"
            onChange={(e) => { setFilters({ ...filters, q: e.target.value }); }} />
        </div>
        <div className="field field--select">
          <label htmlFor={`${ids}-event`}>Дія</label>
          <select id={`${ids}-event`} value={filters.event ?? ''} onChange={(e) => { setFilters({ ...filters, event: e.target.value || null }); }}>
            <option value="">Усі дії</option>
            {events.map((ev) => <option key={ev} value={ev}>{eventLabel(ev)}</option>)}
            {filters.event && !events.includes(filters.event) ? <option value={filters.event}>{eventLabel(filters.event)}</option> : null}
          </select>
        </div>
        <div className="field field--select">
          <label htmlFor={`${ids}-outcome`}>Результат</label>
          <select id={`${ids}-outcome`} value={filters.outcome ?? ''} onChange={(e) => { setFilters({ ...filters, outcome: (e.target.value || null) as Filters['outcome'] }); }}>
            <option value="">Усі результати</option>
            {(['success', 'failure', 'denied'] as const).map((o) => <option key={o} value={o}>{OUTCOME[o].label}</option>)}
          </select>
        </div>
        {filtering ? <button type="button" className="button toolbar__reset" onClick={() => { setFilters(NO_FILTERS); }}>Скинути</button> : null}
      </div>
      <p id={`${ids}-hint`} className="hint workpanel__hint">Пошук і фільтри діють лише серед завантажених подій.</p>

      {refreshFailed ? (
        <div className="notice notice--warning status-bar" role="status">
          <span>{`Не вдалося оновити журнал. Показано раніше завантажені події${journal.receivedAt ? ` (отримано о ${formatClock(new Date(journal.receivedAt).toISOString())})` : ''}.${formatRetry(refreshFailed.retryAfterSeconds)}`}</span>
          <button type="button" className="button button--small" onClick={refresh}>Повторити</button>
        </div>
      ) : null}

      <div className="incidents-card audit-card">
        <div className="app-list__caption">
          <span className="num">
            {ready ? `Завантажено: ${String(items.length)}${filtering ? ` · знайдено: ${String(shown.length)}` : ''} · нові записи журналу зверху` : journal.status === 'loading' ? 'Завантаження…' : 'Журнал недоступний'}
          </span>
          <span>{journal.receivedAt ? `Отримано о ${formatClock(new Date(journal.receivedAt).toISOString())}` : null}</span>
        </div>
        {journal.status === 'loading' ? <LoadingState label="Завантаження журналу…" /> : null}
        {journal.status === 'error' ? (
          <ErrorState title="Не вдалося завантажити журнал" onRetry={retryFirst}>
            {`Сервіс тимчасово недоступний — це не означає, що подій немає.${formatRetry(journal.error?.retryAfterSeconds ?? null)}`}
          </ErrorState>
        ) : null}
        {ready && items.length === 0 ? <EmptyState title="Подій ще немає">Журнал порожній.</EmptyState> : null}
        {ready && items.length > 0 && shown.length === 0 ? (
          <div className="state state--empty">
            <h2 className="state__title">Серед завантажених подій збігів немає</h2>
            <p className="state__text">{`Пошук і фільтри діють лише серед завантажених подій.${journal.next ? ' Старіші події можуть містити збіги — «Показати старіші».' : ''}`}</p>
            <button type="button" className="button" onClick={() => { setFilters(NO_FILTERS); }}>Скинути фільтри</button>
          </div>
        ) : null}
        {shown.length > 0 ? (
          records ? <AuditRecords items={shown} onOpen={(i) => { setOpenId(i.id); }} rowsRef={rowsRef} /> : <AuditTable items={shown} onOpen={(i) => { setOpenId(i.id); }} rowsRef={rowsRef} />
        ) : null}
        {ready && items.length > 0 ? (
          <nav className="pager incidents__pager audit__pager" aria-label="Старіші події журналу">
            <span className="pager__page" role="status">
              {moreFailed ? `Не вдалося завантажити старіші події. Завантажені записи збережено.${formatRetry(moreFailed.retryAfterSeconds)}`
                : loadingMore ? 'Завантаження старіших подій…' : journal.next ? 'Є старіші події' : 'Старіших подій немає'}
            </span>
            {journal.next ? (
              <button type="button" className="button button--small" onClick={loadOlder} disabled={loadingMore || journal.refresh === 'loading'}>{moreFailed ? 'Повторити' : 'Показати старіші'}</button>
            ) : null}
          </nav>
        ) : null}
      </div>
      <p className="hint">Порядок — серверний, за номером запису журналу (нові зверху). Час — місцевий; повна дата й зона — у деталях.</p>

      {open ? <AuditDrawer key={open.id} item={open} onClose={() => { setOpenId(null); }} fallbackFocus={() => titleRef.current} /> : null}
    </section>
  );
}
