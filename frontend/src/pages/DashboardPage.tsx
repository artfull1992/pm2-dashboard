import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { dashboardApi } from '../api/client';
import type { AttentionReason, DashboardServer, DashboardView, RecentAction } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { formatMemory, formatUptime, ProcessStatusBadge } from '../components/Inventory';
import { ACTION_LABELS } from '../components/ProcessControl';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
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

function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' }) {
  return (
    <div className={`dash-stat dash-stat--${tone}`}>
      <span className="dash-stat__label">{label}</span>
      <strong className="dash-stat__value">{value}</strong>
      <span className="dash-stat__detail">{detail}</span>
    </div>
  );
}

function Memory({ m }: { m: NonNullable<DashboardServer['metrics']>['memory'] }) {
  if (m.totalBytes === 0 || m.usedPercent === null) return <span>—<span className="visually-hidden"> (обсяг пам'яті невідомий)</span></span>;
  const label = `Зайнято ${String(m.usedPercent)} % (${formatMemory(m.usedBytes)} з ${formatMemory(m.totalBytes)})`;
  return (
    <div className="dash-mem">
      <span>{formatMemory(m.usedBytes)} / {formatMemory(m.totalBytes)} · {m.usedPercent} %</span>
      <span className="meter" role="img" aria-label={label}><span className="meter__fill" style={{ width: `${String(Math.min(100, m.usedPercent))}%` }} /></span>
    </div>
  );
}

function Partial({ shown, total, what }: { shown: number; total: number; what: string }) {
  return total > shown ? <p className="hint">{`Показано ${String(shown)} з ${String(total)} ${what}.`}</p> : null;
}

function Overview({ d, outdated }: { d: DashboardView; outdated: boolean }) {
  const s = d.servers;
  const p = d.processes;
  const staleServers = d.inventory.stale + d.inventory.unavailable + d.inventory.notReported;
  return (
    <>
      <div className={`dash-stats${outdated ? ' dash--outdated' : ''}`} aria-label="Підсумки">
        <Stat label="Сервери онлайн" value={`${n(s.online)} з ${n(s.active)}`} tone={s.active === 0 ? 'neutral' : s.online === s.active ? 'ok' : 'warn'}
          detail={s.inactive > 0 ? `активних; ще ${n(s.inactive)} неактивних не враховано` : 'активних серверів'} />
        <Stat label="Не звітують" value={n(s.offline + s.neverConnected)} tone={s.offline + s.neverConnected > 0 ? 'bad' : 'neutral'}
          detail={`офлайн ${n(s.offline)} · без першого звіту ${n(s.neverConnected)}`} />
        <Stat label="PM2-процеси зараз" value={n(p.live.total)} tone="neutral"
          detail={`працюють ${n(p.live.online)} · перехідні ${n(p.live.transitional)} (лише актуальні дані)`} />
        <Stat label="Проблемні сервіси" value={n(p.live.problem)} tone={p.live.problem > 0 ? 'bad' : 'neutral'} detail="помилка, зупинено, очікує рестарту або невідомо" />
        <Stat label="Неактуальні дані" value={n(p.notLive)} tone={p.notLive + staleServers > 0 ? 'warn' : 'neutral'}
          detail={`процесів зі старим станом · серверів без актуального PM2: ${n(staleServers)}`} />
      </div>

      <section className="card dash-attention" aria-labelledby="attention-title">
        <h2 id="attention-title" className="card__title">Потребують уваги</h2>
        {s.active === 0 ? <EmptyState title="Ще немає активних серверів">Додайте сервер і підключіть агента на сторінці «Сервери».</EmptyState> : (
          <div className="dash-attention__cols">
            <div>
              <h3 className="dash-subtitle">{`Сервери (${n(d.attentionServers.total)})`}</h3>
              {d.attentionServers.items.length === 0 ? <p className="hint">Усі активні сервери звітують і мають актуальні дані PM2.</p> : (
                <ul className="dash-list">
                  {d.attentionServers.items.map((a) => (
                    <li key={a.id}>
                      <Link to={`/servers/${a.id}`}>{a.name}</Link> <StatusBadge status={a.status} />
                      <span className="dash-list__why">{REASON_TEXT[a.reason]}{a.lastSeenAt ? ` · останній сигнал ${formatDate(a.lastSeenAt)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Partial shown={d.attentionServers.items.length} total={d.attentionServers.total} what="серверів" />
            </div>
            <div>
              <h3 className="dash-subtitle">{`Сервіси з проблемним статусом (${n(d.attentionProcesses.total)})`}</h3>
              {d.attentionProcesses.items.length === 0 ? <p className="hint">Серед актуальних даних проблемних сервісів немає. Сервіси серверів без актуальних даних тут не враховано — див. список серверів.</p> : (
                <ul className="dash-list">
                  {d.attentionProcesses.items.map((a) => (
                    <li key={`${a.serverId}:${String(a.pmId)}`}>
                      <span className="mono">{a.name}</span> <ProcessStatusBadge status={a.status} />
                      <span className="dash-list__why">
                        <Link to={`/servers/${a.serverId}`}>{a.serverName}</Link> · PM2 id {a.pmId}
                        {a.restarts === null ? '' : ` · рестартів усього ${n(a.restarts)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Partial shown={d.attentionProcesses.items.length} total={d.attentionProcesses.total} what="сервісів" />
            </div>
          </div>
        )}
      </section>

      {d.serverList.items.length > 0 ? (
        <section className="card services-card" aria-labelledby="dash-servers-title">
          <div className="services-heading">
            <div><p className="eyebrow">Поточний знімок</p><h2 id="dash-servers-title" className="card__title">Сервери</h2></div>
            <Link to="/applications">Усі застосунки →</Link>
          </div>
          <div className="table-wrap">
            <table className={`table service-table${outdated ? ' dash--outdated' : ''}`}>
              <caption className="visually-hidden">Активні сервери з поточними метриками останнього heartbeat</caption>
              <thead>
                <tr>
                  <th scope="col">Сервер</th><th scope="col">Стан</th><th scope="col">Останній сигнал</th><th scope="col">Uptime</th>
                  <th scope="col"><abbr title="Середня довжина черги виконання за 1/5/15 хв; не відсоток CPU">Load avg</abbr> 1/5/15</th>
                  <th scope="col">Пам'ять ОС</th><th scope="col">Сервіси PM2</th>
                </tr>
              </thead>
              <tbody>
                {d.serverList.items.map((srv) => (
                  <tr key={srv.id}>
                    <th scope="row"><Link to={`/servers/${srv.id}`}>{srv.name}</Link>{srv.metrics ? <span className="hint"><br />{srv.metrics.hostname}</span> : null}</th>
                    <td><StatusBadge status={srv.status} /></td>
                    <td>{srv.lastSeenAt ? formatDate(srv.lastSeenAt) : '—'}</td>
                    <td>{srv.metrics ? formatUptime(srv.metrics.uptimeSeconds) : '—'}</td>
                    <td>{srv.metrics ? <>{srv.metrics.loadAverage.map(load).join(' / ')}<span className="hint"><br />{`ядер: ${String(srv.metrics.cpuCount)}`}</span></> : '—'}</td>
                    <td>{srv.metrics ? <Memory m={srv.metrics.memory} /> : '—'}</td>
                    <td>
                      <span className={`badge badge--${srv.inventory.state === 'current' && srv.status === 'online' ? 'online' : 'stale'}`}>{srv.status !== 'online' && srv.inventory.state === 'current' ? 'Сервер офлайн' : INVENTORY_TEXT[srv.inventory.state]}</span>
                      {srv.processes ? <span className="dash-procs">{`${n(srv.processes.online)} з ${n(srv.processes.total)} працюють`}{srv.processes.problem > 0 ? <span className="dash-problem">{` · проблемних: ${n(srv.processes.problem)}`}</span> : null}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">Метрики — останній heartbeat онлайн-сервера; для офлайн-серверів не показуються. Пам'ять ОС: зайнято = всього − вільно (не пам'ять застосунків). «—» — значення невідоме.</p>
          </div>
          <Partial shown={d.serverList.items.length} total={d.serverList.total} what="активних серверів (за назвою)" />
          <p><Link to="/servers">Усі сервери →</Link></p>
        </section>
      ) : null}

      {d.recentActions ? (
        <section className="card" aria-labelledby="dash-actions-title">
          <h2 id="dash-actions-title" className="card__title">Останні керуючі дії</h2>
          {d.recentActions.items.length === 0 ? <p className="hint">Керуючих дій ще не було.</p> : (
            <ul className="dash-list">
              {d.recentActions.items.map((a) => (
                <li key={a.id}>
                  <strong>{ACTION_LABELS[a.action]}</strong> <span className="mono">{a.targetKey}</span> на <Link to={`/servers/${a.serverId}`}>{a.serverName}</Link>
                  <span className="dash-list__why">
                    {a.overdue ? 'Дедлайн минув, остаточний статус ще не зафіксовано' : COMMAND_TEXT[a.status]} · {formatDate(a.requestedAt)}{a.requestedByMe ? ' · ви' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
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

  return (
    <section className="page dash" aria-labelledby="dashboard-title">
      <div className="dash-head">
        <div>
          <h1 id="dashboard-title" className="page__title">Огляд</h1>
          <p className="page__lead">
            {received ? `Стан на ${timeFormat.format(new Date(received.at))} (${ago(age)}) · оновлюється кожні 15 с, поки вкладка відкрита` : `Вітаємо, ${email}.`}
          </p>
        </div>
        <button type="button" className="button" onClick={reload} disabled={state.status === 'ready' && state.refreshing}>
          {state.status === 'ready' && state.refreshing ? 'Оновлення…' : '↻ Оновити'}
        </button>
      </div>
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
      {data ? <Overview d={data} outdated={outdated} /> : null}
      {state.status === 'not_found' ? <EmptyState title="Огляд недоступний">Спробуйте оновити сторінку пізніше.</EmptyState> : null}
      <p className="hint">{`Онлайн — heartbeat за останні ${String(data?.windows.onlineSeconds ?? 90)} с; дані PM2 актуальні, якщо зібрані за останні ${String(data?.windows.inventoryFreshSeconds ?? 180)} с. Рестарти — накопичений лічильник PM2.`}</p>
    </section>
  );
}
