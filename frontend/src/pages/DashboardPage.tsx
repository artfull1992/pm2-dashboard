import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { dashboardApi } from '../api/client';
import type { AttentionReason, DashboardView, RecentAction } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { ProcessStatusBadge } from '../components/Inventory';
import { ACTION_LABELS } from '../components/processActions';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader, Section, StatusIndicator } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate, StatusBadge } from './ServersPage';

// Read-only system overview (ADR-020). One aggregated request (exact totals of everything, bounded lists), polled
// every 15 s while the tab is visible. Unknown metrics are "—", never 0; data of an offline server is not shown as
// current; after a failed refresh the last data stays, clearly labelled with the time of the last good answer.

const REASON_TEXT: Record<AttentionReason, string> = {
  offline: 'Агент не звітує (офлайн)',
  never_connected: 'Агент ще жодного разу не звітував',
  inventory_unavailable: 'PM2 exporter недоступний',
  inventory_stale: 'Дані PM2 застарілі',
  inventory_not_reported: 'Агент ще не надіслав дані PM2',
};
const INVENTORY_TEXT = { current: 'Актуально', stale: 'Застарілі', unavailable: 'Exporter недоступний', not_reported: 'Немає даних' } as const;
const COMMAND_TEXT: Record<RecentAction['status'], string> = {
  queued: 'У черзі', dispatched: 'Виконується', succeeded: 'Виконано', failed: 'Не вдалося', rejected: 'Відхилено', expired: 'Протерміновано', unknown: 'Результат невідомий',
};
const timeFormat = new Intl.DateTimeFormat('uk-UA', { timeStyle: 'medium' });
const n = (v: number) => new Intl.NumberFormat('uk-UA').format(v);
const load = (v: number) => v.toFixed(2);

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} с тому`;
  if (s < 3600) return `${String(Math.floor(s / 60))} хв тому`;
  return `${String(Math.floor(s / 3600))} год тому`;
}

/** Summary number. Only a non-zero problem count is coloured; normal values stay neutral. */
function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' }) {
  return (
    <div className={`metric${tone === 'bad' ? ' metric--bad' : tone === 'warn' ? ' metric--warn' : ''}`}>
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      <span className="metric__detail">{detail}</span>
    </div>
  );
}

function Partial({ shown, total, what }: { shown: number; total: number; what: string }) {
  return total > shown ? <p className="hint">{`Показано ${String(shown)} з ${String(total)} ${what}.`}</p> : null;
}

/** Hostname under the server name only when it says something new. */
const extraHostname = (name: string, hostname: string | undefined) => (hostname && hostname.trim().toLowerCase() !== name.trim().toLowerCase() ? hostname : null);

function Overview({ d, outdated, scoped }: { d: DashboardView; outdated: boolean; scoped: boolean }) {
  const s = d.servers;
  const p = d.processes;
  const staleServers = d.inventory.stale + d.inventory.unavailable + d.inventory.notReported;
  const serverProblems = d.attentionServers.total > 0;
  const processProblems = d.attentionProcesses.total > 0;
  return (
    <>
      {/* Exact numbers always (zeros included) — never an implied "everything is fine". */}
      <div className={`metrics dash-stats${outdated ? ' dash--outdated' : ''}`} role="group" aria-label="Підсумки">
          <Stat label="Сервери онлайн" value={`${n(s.online)} з ${n(s.active)}`} tone={s.active === 0 ? 'neutral' : s.online === s.active ? 'ok' : 'warn'}
            detail={s.inactive > 0 ? `активних; ще ${n(s.inactive)} неактивних не враховано` : 'активних серверів'} />
          <Stat label="Не звітують" value={n(s.offline + s.neverConnected)} tone={s.offline + s.neverConnected > 0 ? 'bad' : 'neutral'}
            detail={`офлайн ${n(s.offline)} · без першого звіту ${n(s.neverConnected)}`} />
          <Stat label="PM2-процеси зараз" value={n(p.live.total)} tone="neutral"
            detail={`працюють ${n(p.live.online)} · перехідні ${n(p.live.transitional)}`} />
          <Stat label="Проблемні сервіси" value={n(p.live.problem)} tone={p.live.problem > 0 ? 'bad' : 'neutral'} detail="помилка, зупинено, очікує рестарту або невідомо" />
          <Stat label="Неактуальні дані" value={n(p.notLive)} tone={p.notLive + staleServers > 0 ? 'warn' : 'neutral'}
            detail={`процесів зі старим станом · серверів без актуального PM2: ${n(staleServers)}`} />
      </div>

      <Section title="Потребують уваги" titleId="attention-title">
        {s.active === 0 ? (scoped
          ? <EmptyState title="Немає наданих серверів">Огляд показує лише сервери й сервіси, до яких адміністратор надав вам доступ («Користувачі» → «Доступи»).</EmptyState>
          : <EmptyState title="Ще немає активних серверів">Додайте сервер і підключіть агента на сторінці «Сервери».</EmptyState>)
          : !serverProblems && !processProblems ? (
            // "No problems" is said only about current data; stale data is named separately, never counted as healthy.
            <p className="calm" role="status">
              <StatusIndicator tone="ok">Проблем немає</StatusIndicator>
              <span className="hint">{p.notLive > 0 ? ` серед актуальних даних; ${n(p.notLive)} процесів мають неактуальний стан.` : ': усі активні сервери звітують, проблемних сервісів немає.'}</span>
            </p>
          ) : (
            // Only categories that have something take space; one category uses the whole width.
            <div className="attention">
              {serverProblems ? (
                <div className="attention__group attention__group--servers">
                  <h3 className="split__title">{`Сервери (${n(d.attentionServers.total)})`}</h3>
                  <ul className="list">
                    {d.attentionServers.items.map((a) => (
                      <li key={a.id}>
                        <Link to={`/servers/${a.id}`}>{a.name}</Link> <StatusBadge status={a.status} />
                        <span className="list__meta">{REASON_TEXT[a.reason]}{a.lastSeenAt ? ` · останній сигнал ${formatDate(a.lastSeenAt)}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                  <Partial shown={d.attentionServers.items.length} total={d.attentionServers.total} what="серверів" />
                </div>
              ) : null}
              {processProblems ? (
                <div className="attention__group attention__group--processes">
                  <h3 className="split__title">{`Сервіси з проблемним статусом (${n(d.attentionProcesses.total)})`}</h3>
                  <ul className="list">
                    {d.attentionProcesses.items.map((a) => (
                      <li key={`${a.serverId}:${String(a.pmId)}`}>
                        <span className="mono">{a.name}</span> <ProcessStatusBadge status={a.status} />
                        <span className="list__meta">
                          <Link to={`/servers/${a.serverId}`}>{a.serverName}</Link> · PM2 id {a.pmId}
                          {a.restarts === null ? '' : ` · рестартів усього ${n(a.restarts)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Partial shown={d.attentionProcesses.items.length} total={d.attentionProcesses.total} what="сервісів" />
                </div>
              ) : null}
              {serverProblems && !processProblems ? <p className="hint attention__note">Проблемних сервісів серед актуальних даних немає; сервіси серверів без актуальних даних тут не враховано.</p> : null}
            </div>
          )}
      </Section>

      {d.serverList.items.length > 0 ? (
        <Section title="Сервери" titleId="dash-servers-title" meta="Стан агента й поточне навантаження; системний моніторинг серверів — у Zabbix"
          actions={<><Link to="/servers">Усі сервери →</Link> <Link to="/applications">Усі застосунки →</Link></>}>
          <div className="table-wrap">
            <table className={`table${outdated ? ' table--outdated dash--outdated' : ''}`}>
              <caption className="visually-hidden">Активні сервери: стан агента, останній сигнал, поточний load average і дані PM2</caption>
              <thead>
                <tr>
                  <th scope="col">Сервер</th><th scope="col">Стан</th><th scope="col">Останній сигнал</th>
                  <th scope="col" className="num">Load avg 1/5/15</th><th scope="col">Сервіси PM2</th>
                </tr>
              </thead>
              <tbody>
                {d.serverList.items.map((srv) => (
                  <tr key={srv.id}>
                    <th scope="row"><Link to={`/servers/${srv.id}`}>{srv.name}</Link>{extraHostname(srv.name, srv.metrics?.hostname) ? <span className="cell-meta">{srv.metrics?.hostname}</span> : null}</th>
                    <td><StatusBadge status={srv.status} /></td>
                    <td className="date secondary">{srv.lastSeenAt ? formatDate(srv.lastSeenAt) : '—'}</td>
                    <td className="num">{srv.metrics ? srv.metrics.loadAverage.map(load).join(' / ') : '—'}</td>
                    <td>
                      {srv.inventory.state === 'current' && srv.status === 'online'
                        ? <StatusIndicator tone="muted">{INVENTORY_TEXT.current}</StatusIndicator>
                        : <StatusIndicator tone="warn">{srv.status !== 'online' && srv.inventory.state === 'current' ? 'Сервер офлайн' : INVENTORY_TEXT[srv.inventory.state]}</StatusIndicator>}
                      {srv.processes ? <span className="cell-meta">{`${n(srv.processes.online)} з ${n(srv.processes.total)} працюють`}{srv.processes.problem > 0 ? <span className="cell-meta--strong">{` · проблемних: ${n(srv.processes.problem)}`}</span> : null}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="table-note">Load avg — довжина черги процесів за 1/5/15 хв, не відсоток CPU; лише з останнього heartbeat онлайн-сервера, для офлайн-серверів не показується. «—» — значення невідоме.</p>
          </div>
          <Partial shown={d.serverList.items.length} total={d.serverList.total} what="активних серверів (за назвою)" />
        </Section>
      ) : null}

      {d.recentActions ? (
        <Section title="Останні керуючі дії" titleId="dash-actions-title">
          {d.recentActions.items.length === 0 ? <p className="list__empty">Керуючих дій ще не було.</p> : (
            <ul className="list">
              {d.recentActions.items.map((a) => (
                <li key={a.id}>
                  <span>{ACTION_LABELS[a.action]}</span> <span className="mono">{a.serviceName ?? a.targetKey}</span> на <Link to={`/servers/${a.serverId}`}>{a.serverName}</Link>
                  <span className="list__meta">
                    {a.overdue ? 'Дедлайн минув, остаточний статус ще не зафіксовано' : COMMAND_TEXT[a.status]} · {formatDate(a.requestedAt)}{a.requestedByMe ? ' · ви' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </>
  );
}

export function DashboardPage() {
  const loadDashboard = useCallback((signal: AbortSignal) => dashboardApi.get(signal), []);
  const { state, reload } = usePolledResource(loadDashboard, 'dashboard');
  const { state: auth } = useAuth();
  // Local time of the last SUCCESSFUL answer (client clock only, so server/client skew does not matter).
  const [now, setNow] = useState(() => Date.now());
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;
  const receivedAt = state.status === 'ready' ? state.receivedAt : state.status === 'error' ? state.receivedAt : null;
  const received = data && receivedAt !== null ? { at: receivedAt } : null;
  useEffect(() => { const t = setInterval(() => { setNow(Date.now()); }, 5_000); return () => { clearInterval(t); }; }, []);

  if (state.status === 'forbidden') return <Forbidden />;
  const age = received ? now - received.at : 0;
  const outdated = data !== null && received !== null && (state.status === 'error' || age > data.windows.onlineSeconds * 1000);
  const email = auth.status === 'authenticated' ? auth.session.user.email : '';

  const refreshing = state.status === 'ready' && state.refreshing;
  return (
    <section className="page dash" aria-labelledby="dashboard-title">
      <PageHeader title="Огляд" titleId="dashboard-title"
        meta={<span>{received ? `Стан на ${timeFormat.format(new Date(received.at))} (${ago(age)}) · оновлюється кожні 15 с, поки вкладка відкрита` : `Вітаємо, ${email}.`}</span>}
        actions={<button type="button" className="button" onClick={reload} disabled={refreshing}>{refreshing ? 'Оновлення…' : 'Оновити'}</button>} />
      {state.status === 'loading' ? <LoadingState label="Завантаження огляду…" /> : null}
      {state.status === 'error' ? (
        <ErrorState title={data ? 'Не вдалося оновити огляд' : 'Не вдалося завантажити огляд'} onRetry={reload}>
          {data && received
            ? `Нижче — останні відомі дані станом на ${timeFormat.format(new Date(received.at))}; поточний стан може відрізнятися.${formatRetry(state.retryAfterSeconds)}`
            : `Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}
        </ErrorState>
      ) : null}
      {outdated && state.status !== 'error' ? (
        <p className="notice notice--warning" role="status">{`Дані не оновлювались ${ago(age).replace(' тому', '')}: статуси нижче можуть бути неактуальними.`}</p>
      ) : null}
      {data ? <Overview d={data} outdated={outdated} scoped={auth.status === 'authenticated' && auth.session.user.role !== 'admin'} /> : null}
      {state.status === 'not_found' ? <EmptyState title="Огляд недоступний">Спробуйте оновити сторінку пізніше.</EmptyState> : null}
      <details className="disclosure">
        <summary>Як читати ці дані</summary>
        <p className="hint">{`Онлайн — heartbeat за останні ${String(data?.windows.onlineSeconds ?? 90)} с; дані PM2 актуальні, якщо зібрані за останні ${String(data?.windows.inventoryFreshSeconds ?? 180)} с. Рестарти — накопичений лічильник PM2. Списки обмежені; у заголовку — повна кількість.`}</p>
      </details>
    </section>
  );
}
