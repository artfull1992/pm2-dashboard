import { type KeyboardEvent, useCallback, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { alertsApi, ALERTS_PAGE_SIZE } from '../api/client';
import type { AlertRule, AlertsStatus, Incident } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { Dialog } from '../components/Dialog';
import { delivery, metric, RESOLUTION_TEXT, RULE_ORDER, RULE_TITLE, searchText, SERVER_STATUS_TEXT, SEVERITY_TEXT, shortTime } from '../components/incidents';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { formatAgo, formatClock } from '../components/time';
import { StatusIndicator } from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate } from './ServersPage';

// Alerts (ADR-021; design NTF-01…07, docs/design/part-01). Two tabs over the existing read-only API: active problems
// and history, each with its own cursor stack (GET /api/alerts?state=…&before=…, pages of 25, server order: active by
// opening, history by closing time, newest first). Only the visible tab and the engine status are polled; a page
// opened by a cursor is anchored by it, so refreshes never shift older pages.
//
// Search and the server / type filters work only on the page in hand (the API has no search or filters) and say so;
// they never hide «Старіші». The active count in the tab is the engine status' scoped activeCount (everything this
// user may see), never the page length; it is not shown when the status is unknown.
//
// Details open in a modal drawer built only from the row (no extra request). Its identity is the incident id: when a
// refresh no longer contains it (closed elsewhere, access changed) the drawer closes instead of keeping old data.
// Delivery is admin data: without it (notification = null) no column and no guess. Nothing here controls processes,
// acknowledges, resolves or resends anything; settings live under «Налаштування».

type Tab = 'active' | 'resolved';
const TABS: { id: Tab; label: string }[] = [{ id: 'active', label: 'Активні проблеми' }, { id: 'resolved', label: 'Історія' }];
/** Records instead of the table (phones and 200 % zoom of a laptop window). */
const RECORDS_QUERY = '(max-width: 760px)';

interface Filters { q: string; server: { id: string; name: string } | null; rule: AlertRule | null }
const NO_FILTERS: Filters = { q: '', server: null, rule: null };
const filtersActive = (f: Filters) => f.q.trim() !== '' || f.server !== null || f.rule !== null;
function matches(i: Incident, f: Filters) {
  const q = f.q.trim().toLocaleLowerCase('uk-UA');
  return (!f.server || i.serverId === f.server.id) && (!f.rule || i.rule === f.rule) && (q === '' || searchText(i).includes(q));
}

function ProblemState({ i }: { i: Incident }) {
  return i.status === 'firing'
    ? <span className={`severity severity--${i.severity}`}>{`Активна · ${SEVERITY_TEXT[i.severity]}`}</span>
    : <span className="severity severity--muted">Закрито</span>;
}

function DeliveryState({ n, deliveryOn }: { n: NonNullable<Incident['notification']>; deliveryOn: boolean | null }) {
  const d = delivery(n);
  const meta = [
    n.notify && (n.state === 'queued' || n.state === 'sending') && deliveryOn === false ? 'надсилання зараз вимкнено' : null,
    n.notify && n.state === 'unknown' ? 'можливо, надіслано двічі' : null,
    n.notify ? null : 'повтор у межах cooldown',
  ].filter((x): x is string => x !== null);
  return (
    <>
      <StatusIndicator tone={d.tone}>{d.label}</StatusIndicator>
      {meta.length > 0 ? <span className="cell-meta">{meta.join(' · ')}</span> : null}
    </>
  );
}

function serverNote(i: Incident) {
  if (i.status !== 'firing' || i.serverStatus === 'online' || i.rule === 'server_offline') return null;
  return i.serverStatus === 'inactive' ? 'Сервер неактивний' : 'Сервер не звітує: стан не оновлюється';
}

function IncidentTable({ items, resolved, withDelivery, deliveryOn, onOpen }: {
  items: Incident[]; resolved: boolean; withDelivery: boolean; deliveryOn: boolean | null; onOpen: (i: Incident) => void;
}) {
  return (
    <div className="incidents__scroll">
      <table className="table table--dense incidents">
        <caption className="visually-hidden">{resolved ? 'Закриті проблеми' : 'Активні проблеми'}</caption>
        <thead>
          <tr>
            <th scope="col">Проблема / стан</th><th scope="col">Сервер / застосунок</th><th scope="col">Показник</th>
            <th scope="col">Початок</th><th scope="col">{resolved ? 'Закриття' : 'Спостереження'}</th>
            {withDelivery ? <th scope="col">Доставка</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const m = metric(i);
            const note = serverNote(i);
            return (
              <tr key={i.id}>
                <th scope="row">
                  <button type="button" className="link-button incidents__open" aria-haspopup="dialog" onClick={() => { onOpen(i); }}>{RULE_TITLE[i.rule]}</button>
                  <ProblemState i={i} />
                </th>
                <td>
                  <span className="incidents__server">{i.serverName}</span>
                  <span className="cell-meta incidents__app" title={i.processName ?? undefined}>{i.processName ?? '—'}</span>
                  {note ? <span className="cell-meta cell-meta--strong">{note}</span> : null}
                </td>
                <td>{m.value}{m.note ? <span className="cell-meta">{m.note}</span> : null}</td>
                <td className="date">{shortTime(i.openedAt)}</td>
                <td className="date">
                  {resolved ? shortTime(i.resolvedAt) : shortTime(i.lastObservedAt)}
                  {resolved ? <span className="cell-meta">{i.resolution ? RESOLUTION_TEXT[i.resolution] : 'Причину не передано'}</span> : null}
                </td>
                {withDelivery ? <td>{i.notification ? <DeliveryState n={i.notification} deliveryOn={deliveryOn} /> : '—'}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IncidentRecords({ items, resolved, deliveryOn, onOpen }: { items: Incident[]; resolved: boolean; deliveryOn: boolean | null; onOpen: (i: Incident) => void }) {
  return (
    <ul className="incident-records" aria-label={resolved ? 'Закриті проблеми' : 'Активні проблеми'}>
      {items.map((i) => {
        const m = metric(i);
        const note = serverNote(i);
        return (
          <li key={i.id}>
            <article className="incident-record" aria-label={`${RULE_TITLE[i.rule]}: ${i.serverName}${i.processName ? ` · ${i.processName}` : ''}`}>
              <div className="incident-record__head">
                <button type="button" className="link-button incidents__open" aria-haspopup="dialog" onClick={() => { onOpen(i); }}>{RULE_TITLE[i.rule]}</button>
                <ProblemState i={i} />
              </div>
              <p className="incident-record__line">{`${i.serverName} · ${i.processName ?? '—'}`}</p>
              {note ? <p className="incident-record__line cell-meta--strong">{note}</p> : null}
              <p className="incident-record__line"><strong>{m.value}</strong>{m.note ? ` · ${m.note}` : ''}</p>
              <p className="incident-record__times">
                <span>{`Початок ${shortTime(i.openedAt)}`}</span>
                <span>{resolved ? `Закрито ${shortTime(i.resolvedAt)}` : `Помічено ${shortTime(i.lastObservedAt)}`}</span>
              </p>
              {resolved ? <p className="incident-record__line secondary">{i.resolution ? RESOLUTION_TEXT[i.resolution] : 'Причину не передано'}</p> : null}
              {i.notification ? <div className="incident-record__line"><DeliveryState n={i.notification} deliveryOn={deliveryOn} /></div> : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

function IncidentDrawer({ i, receivedAt, stale, deliveryOn, onClose, fallbackFocus }: {
  i: Incident; receivedAt: number | null; stale: boolean; deliveryOn: boolean | null; onClose: () => void; fallbackFocus: () => HTMLElement | null;
}) {
  const m = metric(i);
  const resolved = i.status === 'resolved';
  const n = i.notification;
  const d = i.detail;
  const metricLabel = !resolved ? 'Останнє спостереження' : i.resolution === 'recovered' ? 'На момент закриття' : 'Останнє спостереження до закриття';
  return (
    <Dialog title={RULE_TITLE[i.rule]} eyebrow={resolved ? 'Закрита проблема' : 'Активна проблема'} className="dialog--drawer" onClose={onClose} fallbackFocus={fallbackFocus}
      headerAction={<button type="button" className="button button--ghost icon-button" aria-label="Закрити деталі" onClick={onClose}>✕</button>}
      actions={<button type="button" className="button" onClick={onClose}>Закрити</button>}>
      {stale ? <p className="notice notice--warning">{`Дані на момент останнього отримання${receivedAt ? ` (${formatClock(new Date(receivedAt).toISOString())})` : ''}: стан після цього невідомий.`}</p> : null}
      <section className="drawer-section" aria-labelledby="incident-state">
        <h3 id="incident-state" className="drawer-section__title">Стан проблеми</h3>
        <ProblemState i={i} />
        {resolved ? (
          <dl className="facts">
            <dt>Причина закриття</dt><dd>{i.resolution ? RESOLUTION_TEXT[i.resolution] : 'Не передано'}</dd>
          </dl>
        ) : <p className="hint">Умову проблеми підтвердив рушій перевірки. Стан проблеми — не стан процесу.</p>}
        {resolved && i.resolution !== 'recovered' ? <p className="hint">Закриття не означає, що процес відновився.</p> : null}
        {i.rule === 'process_down' && d.status === 'stopped' ? <p className="hint">stopped може бути навмисною зупинкою: рушій не знає її причини.</p> : null}
      </section>
      <section className="drawer-section" aria-labelledby="incident-object">
        <h3 id="incident-object" className="drawer-section__title">Об’єкт</h3>
        <dl className="facts">
          <dt>Сервер</dt><dd>{i.serverName}</dd>
          <dt>Стан сервера</dt><dd>{`${SERVER_STATUS_TEXT[i.serverStatus]} (на час отримання сторінки)`}</dd>
          <dt>Застосунок</dt><dd className="mono">{i.processName ?? '— (проблема сервера)'}</dd>
          {i.processName ? <><dt>PM2 id</dt><dd>{i.pmId === null ? '—' : String(i.pmId)}</dd></> : null}
          {i.processName ? (
            <><dt>Стан процесу</dt><dd>{i.rule === 'process_down' && d.status ? `${d.status} — останній стан, який бачив рушій` : 'Не передано: поточний стан PM2 дивіться в «Застосунках»'}</dd></>
          ) : null}
        </dl>
      </section>
      <section className="drawer-section" aria-labelledby="incident-metric">
        <h3 id="incident-metric" className="drawer-section__title">Показник</h3>
        <dl className="facts">
          <dt>{metricLabel}</dt><dd>{m.value}{m.note ? <span className="cell-meta">{m.note}</span> : null}</dd>
          <dt>Під час відкриття</dt><dd>—</dd>
        </dl>
        <p className="hint">Значення під час відкриття не передається. Останній показник його не замінює.</p>
      </section>
      <section className="drawer-section" aria-labelledby="incident-time">
        <h3 id="incident-time" className="drawer-section__title">Час (місцевий)</h3>
        <dl className="facts">
          <dt>Початок</dt><dd>{formatDate(i.openedAt)}</dd>
          <dt>Останнє спостереження рушієм</dt><dd>{formatDate(i.lastObservedAt)}</dd>
          {resolved ? <><dt>Закриття</dt><dd>{formatDate(i.resolvedAt)}</dd></> : null}
          <dt>Сторінку отримано браузером</dt><dd>{receivedAt ? formatDate(new Date(receivedAt).toISOString()) : '—'}</dd>
        </dl>
      </section>
      {n ? (
        <section className="drawer-section" aria-labelledby="incident-delivery">
          <h3 id="incident-delivery" className="drawer-section__title">Доставка повідомлення</h3>
          <dl className="facts">
            <dt>Стан</dt><dd><DeliveryState n={n} deliveryOn={deliveryOn} /></dd>
            <dt>Спроб</dt><dd>{String(n.attempts)}</dd>
            <dt>Остання помилка</dt><dd>{n.lastError ?? '—'}</dd>
          </dl>
          <p className="hint">«Надіслано» означає, що Slack прийняв повідомлення, а не що його прочитали. Помилка доставки не є станом процесу.</p>
          {deliveryOn === false ? <p className="hint">Зараз надсилання вимкнено. Стан стосується саме цього інциденту: повідомлення могло бути надіслане раніше.</p> : null}
        </section>
      ) : null}
    </Dialog>
  );
}

/** Engine and delivery state: off, never evaluated, last evaluation failed, running — or unknown (status failed). */
function EngineLine({ s }: { s: AlertsStatus }) {
  if (!s.engine.enabled) {
    return <p className="notice notice--warning" role="status">Рушій сповіщень вимкнено: проблеми зараз не відстежуються і не надсилаються. Наведені записи (якщо є) — з часу, коли він працював.</p>;
  }
  const failed = s.engine.lastEvaluationOk === false;
  return (
    <p className="freshness" role="status">
      <StatusIndicator tone={failed ? 'bad' : s.engine.lastEvaluationAt ? 'ok' : 'muted'}>
        {s.engine.lastEvaluationAt
          ? `Остання перевірка: ${formatDate(s.engine.lastEvaluationAt)}${failed ? ' — з помилкою' : ''}.`
          : 'Рушій увімкнено, але перевірок ще не було.'}
      </StatusIndicator>
      <span>{s.delivery.enabled ? 'Надсилання в Slack увімкнено.' : 'Надсилання в Slack зараз вимкнено: нові інциденти лише записуються.'}</span>
    </p>
  );
}

/** NTF-04: no active problems — said only after a successful evaluation; otherwise why it means nothing. */
function NoActive({ s }: { s: AlertsStatus | null }) {
  if (!s) return <EmptyState title="Активних проблем не отримано">Стан рушія невідомий — це не означає, що проблем немає.</EmptyState>;
  if (!s.engine.enabled) return <EmptyState title="Активних проблем не зафіксовано">Рушій вимкнено — це не означає, що проблем немає.</EmptyState>;
  if (!s.engine.lastEvaluationAt) return <EmptyState title="Активних проблем не зафіксовано">Перевірок ще не було.</EmptyState>;
  if (s.engine.lastEvaluationOk === false) return <EmptyState title="Активних проблем не зафіксовано">Остання перевірка завершилась з помилкою — поточний стан невідомий.</EmptyState>;
  return <EmptyState title="Активних проблем немає">{`За останньою перевіркою (${formatDate(s.engine.lastEvaluationAt)}) відкритих проблем у вашому доступі немає.`}</EmptyState>;
}

export function AlertsPage() {
  const { can } = useAuth();
  const ids = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const records = useMediaQuery(RECORDS_QUERY);
  const [tab, setTab] = useState<Tab>('active');
  const [cursors, setCursors] = useState<Record<Tab, (string | null)[]>>({ active: [null], resolved: [null] });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ active: null, resolved: null });

  const loadStatus = useCallback((signal: AbortSignal) => alertsApi.status(signal), []);
  const status = usePolledResource(loadStatus, 'alerts-status');
  const stack = cursors[tab];
  const cursor = stack.at(-1) ?? null;
  const loadList = useCallback((signal: AbortSignal) => alertsApi.list(tab, cursor, signal), [tab, cursor]);
  const list = usePolledResource(loadList, `alerts:${tab}:${cursor ?? 'first'}`);

  const forbidden = status.state.status === 'forbidden' || list.state.status === 'forbidden';
  const ls = list.state;
  const data = ls.status === 'ready' ? ls.data : ls.status === 'error' ? ls.data : null;
  const receivedAt = ls.status === 'ready' || ls.status === 'error' ? ls.receivedAt : null;
  const stale = ls.status === 'error' && data !== null;

  // The drawer follows the incident id in the latest answer; gone from it (closed elsewhere, access changed) or no
  // access at all → it closes (state adjusted while rendering, so no frame shows the old details).
  if (openId !== null && (forbidden || (ls.status === 'ready' && !ls.data.items.some((i) => i.id === openId)))) {
    setOpenId(null);
    if (!forbidden) setNotice('Проблеми більше немає на цій сторінці: її могли закрити або змінився доступ. Деталі закрито.');
  }

  if (forbidden) return <Forbidden />;
  const s = status.state.status === 'ready' ? status.state.data : null;
  const deliveryOn = s ? s.delivery.enabled : null;
  const items = data?.items ?? [];
  const shown = items.filter((i) => matches(i, filters));
  const withDelivery = items.some((i) => i.notification !== null);
  const open = openId ? items.find((i) => i.id === openId) ?? null : null;
  const active = filtersActive(filters);
  const serverOptions = [...new Map(items.map((i) => [i.serverId, i.serverName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'uk'));
  const pageNo = stack.length;

  const switchTab = (next: Tab) => { setTab(next); setOpenId(null); setNotice(null); };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const at = TABS.findIndex((t) => t.id === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]?.id ?? 'active';
    switchTab(id);
    tabRefs.current[id]?.focus();
  };
  const page = (next: (string | null)[]) => { setCursors({ ...cursors, [tab]: next }); setOpenId(null); setNotice(null); };
  const onOpen = (i: Incident) => { setNotice(null); setOpenId(i.id); };
  const resetFilters = () => { setFilters(NO_FILTERS); };
  const resolved = tab === 'resolved';
  const panelId = `${ids}-panel`;
  const hintId = `${ids}-hint`;

  return (
    <section className="page page--workspace alerts" aria-labelledby="alerts-title">
      <header className="page-header">
        <div className="page-header__main"><h1 id="alerts-title" className="page__title" ref={titleRef} tabIndex={-1}>Сповіщення</h1></div>
        {can('alerts:manage') ? <div className="page-header__actions"><Link className="button" to="/settings/rules">Налаштування</Link></div> : null}
      </header>

      {status.state.status === 'loading' ? <p className="freshness" role="status">Стан рушія завантажується…</p> : null}
      {status.state.status === 'error' || status.state.status === 'not_found' ? (
        <div className="notice notice--error status-bar" role="alert">
          <span>{`Не вдалося отримати стан рушія: стан перевірок невідомий.${status.state.status === 'error' ? formatRetry(status.state.retryAfterSeconds) : ''}`}</span>
          <button type="button" className="button button--small" onClick={status.reload}>Спробувати ще раз</button>
        </div>
      ) : null}
      {s ? <EngineLine s={s} /> : null}

      <div role="tablist" aria-label="Розділи сповіщень" className="app-tabs alerts__tabs" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`${ids}-${t.id}`} aria-selected={tab === t.id}
            aria-controls={panelId} tabIndex={tab === t.id ? 0 : -1} className={`app-tab${tab === t.id ? ' app-tab--active' : ''}`} onClick={() => { switchTab(t.id); }}>
            {t.id === 'active' && s ? `${t.label} · ${String(s.activeCount)}` : t.label}
          </button>
        ))}
      </div>

      <div className="toolbar workspace-filters alerts__filters" role="group" aria-label="Пошук і фільтри на цій сторінці" aria-describedby={hintId}>
        <div className="field field--search">
          <label htmlFor={`${ids}-q`}>Пошук на цій сторінці</label>
          <input id={`${ids}-q`} type="search" value={filters.q} maxLength={100} autoComplete="off" spellCheck={false} placeholder="Застосунок, сервер або тип проблеми"
            onChange={(e) => { setFilters({ ...filters, q: e.target.value }); }} />
        </div>
        <div className="field field--select">
          <label htmlFor={`${ids}-server`}>Сервер</label>
          <select id={`${ids}-server`} value={filters.server?.id ?? ''}
            onChange={(e) => { const id = e.target.value; setFilters({ ...filters, server: id ? { id, name: serverOptions.find(([k]) => k === id)?.[1] ?? id } : null }); }}>
            <option value="">Усі на сторінці</option>
            {serverOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            {filters.server && !serverOptions.some(([id]) => id === filters.server?.id) ? <option value={filters.server.id}>{`${filters.server.name} (немає на цій сторінці)`}</option> : null}
          </select>
        </div>
        <div className="field field--select">
          <label htmlFor={`${ids}-rule`}>Тип проблеми</label>
          <select id={`${ids}-rule`} value={filters.rule ?? ''} onChange={(e) => { setFilters({ ...filters, rule: (e.target.value || null) as AlertRule | null }); }}>
            <option value="">Усі типи</option>
            {RULE_ORDER.map((r) => <option key={r} value={r}>{RULE_TITLE[r]}</option>)}
          </select>
        </div>
        {active ? <button type="button" className="button toolbar__reset" onClick={resetFilters}>Скинути</button> : null}
      </div>
      <p id={hintId} className="hint alerts__hint">{`Пошук і фільтри застосовуються лише до цієї сторінки (до ${String(ALERTS_PAGE_SIZE)} записів), а не до всієї ${resolved ? 'історії' : 'кількості проблем'}.`}</p>

      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {ls.status === 'error' && data ? (
        <div className="notice notice--warning status-bar" role="status">
          <span>
            <strong>{`Дані застарілі · останнє отримання ${receivedAt ? `о ${formatClock(new Date(receivedAt).toISOString())} (${formatAgo(new Date(receivedAt).toISOString())})` : 'невідоме'}.`}</strong>
            {` Стан проблем і доставки після цього часу невідомий.${formatRetry(ls.retryAfterSeconds)}`}
          </span>
          <button type="button" className="button button--small" onClick={list.reload}>Оновити</button>
        </div>
      ) : null}

      <div role="tabpanel" id={panelId} aria-labelledby={`${ids}-${tab}`} className="incidents-card">
        <div className="app-list__caption">
          <span className="num">
            {data ? `На цій сторінці: ${String(items.length)}${active ? ` · за фільтром: ${String(shown.length)}` : ''}` : ls.status === 'loading' ? 'Завантаження…' : 'Список недоступний'}
            {!resolved && s ? ` · усього активних у вашому доступі: ${String(s.activeCount)}` : ''}
          </span>
          <span>{ls.status === 'ready' && ls.refreshing ? 'Оновлення…' : receivedAt && !stale ? `Отримано о ${formatClock(new Date(receivedAt).toISOString())}` : null}</span>
        </div>
        {ls.status === 'loading' ? <LoadingState label={resolved ? 'Завантаження історії…' : 'Завантаження проблем…'} /> : null}
        {(ls.status === 'error' && !data) || ls.status === 'not_found' ? (
          <ErrorState title={resolved ? 'Не вдалося отримати історію' : 'Не вдалося отримати проблеми'} onRetry={list.reload}>
            {`Стан невідомий — це не означає, що проблем немає.${ls.status === 'error' ? formatRetry(ls.retryAfterSeconds) : ''}`}
          </ErrorState>
        ) : null}
        {data && items.length === 0 ? (
          resolved ? <EmptyState title={pageNo > 1 ? 'На цій сторінці записів немає' : 'Закритих проблем немає'} />
            : pageNo > 1 ? <EmptyState title="На цій сторінці записів немає">Проблеми могли закрити після переходу.</EmptyState> : <NoActive s={s} />
        ) : null}
        {data && items.length > 0 && shown.length === 0 ? (
          <div className="state state--empty">
            <h2 className="state__title">На цій сторінці збігів немає</h2>
            <p className="state__text">{`Пошук і фільтри діють лише на цю сторінку.${data.nextBefore ? ' Старіші записи можуть містити збіги — перейдіть «Старіші».' : ''}`}</p>
            <button type="button" className="button" onClick={resetFilters}>Скинути фільтри</button>
          </div>
        ) : null}
        {shown.length > 0 ? (records
          ? <IncidentRecords items={shown} resolved={resolved} deliveryOn={deliveryOn} onOpen={onOpen} />
          : <IncidentTable items={shown} resolved={resolved} withDelivery={withDelivery} deliveryOn={deliveryOn} onOpen={onOpen} />) : null}
        {pageNo > 1 || data?.nextBefore ? (
          <nav className="pager incidents__pager" aria-label={resolved ? 'Сторінки історії' : 'Сторінки активних проблем'}>
            <span className="pager__page">{`Сторінка ${String(pageNo)}`}</span>
            <button type="button" className="button button--small" disabled={pageNo === 1} onClick={() => { page(stack.slice(0, -1)); }}>Новіші</button>
            <button type="button" className="button button--small" disabled={ls.status !== 'ready' || !data?.nextBefore}
              onClick={() => { if (data?.nextBefore) page([...stack, data.nextBefore]); }}>Старіші</button>
          </nav>
        ) : null}
      </div>
      {withDelivery && deliveryOn === false ? <p className="hint">«Доставка» — результат саме цього інциденту: його могли надіслати раніше, коли надсилання працювало. Зараз надсилання вимкнено.</p> : null}
      <p className="hint">Стан проблеми, стан процесу й доставка повідомлення — окремі значення. Закриття проблеми не завжди означає відновлення процесу.</p>

      {open ? <IncidentDrawer key={open.id} i={open} receivedAt={receivedAt} stale={stale} deliveryOn={deliveryOn} onClose={() => { setOpenId(null); }} fallbackFocus={() => titleRef.current} /> : null}
    </section>
  );
}
