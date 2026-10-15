import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { alertsApi } from '../api/client';
import type { AlertRule, AlertsStatus, Incident } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader, Section, StatusIndicator } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate } from './ServersPage';

// Alerts (ADR-021): read-only view of the engine/delivery state, active incidents and a paged resolved history.
// Never says "all good" when the engine is off or nothing has been evaluated yet. Delivery details: admin only
// (the API decides; they are simply absent for other roles). Settings live in the server environment, not here.

const RULE_TITLE: Record<AlertRule, string> = {
  server_offline: 'Сервер не звітує', inventory_stale: 'Дані PM2 неактуальні', process_down: 'PM2-процес не працює',
  process_cpu: 'Високе CPU процесу (PM2)', server_memory: 'Висока пам’ять ОС (правило виведено)', process_restarts: 'Часті рестарти',
};
const RESOLUTION_TEXT = {
  recovered: 'Відновлено', process_gone: 'Процес зник з PM2 (відновлення не підтверджено)', excluded: 'Сервер виключено з моніторингу',
  retired: 'Правило виведено з експлуатації (не відновлення)',
} as const;
const DELIVERY_TEXT = {
  none: 'Не надсилалось', queued: 'У черзі', sending: 'Надсилається', sent: 'Надіслано', failed: 'Не доставлено',
  unknown: 'Результат невідомий (можливий дублікат)', dropped: 'Відкинуто: черга переповнена',
} as const;

function detailText(i: Incident): string {
  const d = i.detail;
  switch (i.rule) {
    case 'server_offline': return d.lastSeenAt ? `Останній сигнал ${formatDate(d.lastSeenAt)}` : 'Останній сигнал невідомий';
    case 'inventory_stale': return d.state === 'unavailable' ? 'Exporter недоступний' : 'Дані застарілі';
    case 'process_down': return d.status === 'errored' ? 'Статус errored' : 'Статус stopped (можливо, навмисно)';
    case 'process_cpu': return `CPU ${d.value === undefined || d.value === null ? '—' : String(d.value)} % (поріг ${String(d.threshold ?? '—')} %)`;
    case 'server_memory': return `Зайнято ${d.value === undefined || d.value === null ? '—' : String(d.value)} % (поріг ${String(d.threshold ?? '—')} %)`;
    case 'process_restarts': return `+${String(d.delta ?? '—')} рестартів за ${String(Math.max(1, Math.round((d.spanSeconds ?? 0) / 60)))} хв`;
  }
}

function IncidentTable({ items, resolved }: { items: Incident[]; resolved: boolean }) {
  const delivery = items.some((i) => i.notification !== null);
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">{resolved ? 'Закриті інциденти' : 'Активні проблеми'}</caption>
        <thead>
          <tr>
            <th scope="col">Проблема</th><th scope="col">Сервер / сервіс</th><th scope="col">Показник</th>
            <th scope="col">Початок</th><th scope="col">{resolved ? 'Закрито' : 'Останнє спостереження'}</th>
            {delivery ? <th scope="col">Сповіщення</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <th scope="row">
                {RULE_TITLE[i.rule]}
                <span className="cell-meta"><StatusIndicator tone={resolved ? 'muted' : i.severity === 'critical' ? 'bad' : 'warn'}>{i.severity === 'critical' ? 'Критично' : 'Попередження'}</StatusIndicator></span>
              </th>
              <td>
                <Link to={`/servers/${i.serverId}`}>{i.serverName}</Link>
                {i.processName ? <span className="cell-meta"><span className="mono">{i.processName}</span>{i.pmId === null ? null : ` · PM2 id ${String(i.pmId)}`}</span> : null}
                {!resolved && i.serverStatus !== 'online' && i.rule !== 'server_offline' ? <span className="cell-meta cell-meta--strong">{i.serverStatus === 'inactive' ? 'Сервер неактивний' : 'Сервер не звітує: стан не оновлюється'}</span> : null}
              </td>
              <td>{detailText(i)}</td>
              <td className="date">{formatDate(i.openedAt)}</td>
              <td className="date">{resolved ? <>{formatDate(i.resolvedAt)}<span className="cell-meta">{i.resolution ? RESOLUTION_TEXT[i.resolution] : ''}</span></> : formatDate(i.lastObservedAt)}</td>
              {delivery ? (
                <td>{i.notification ? (i.notification.notify ? <>{DELIVERY_TEXT[i.notification.state]}{i.notification.lastError ? <span className="cell-meta">{`${i.notification.lastError} · спроб: ${String(i.notification.attempts)}`}</span> : null}</> : <span className="secondary">Без сповіщення (повтор у межах cooldown)</span>) : '—'}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Three different pictures: engine off (warning), running (quiet line), unknown (rendered by the caller as an error). */
function StatusBanner({ s }: { s: AlertsStatus }) {
  if (!s.engine.enabled) {
    return <p className="notice notice--warning" role="status">Рушій сповіщень вимкнено: проблеми зараз не відстежуються і не надсилаються. Наведені записи (якщо є) — з часу, коли він працював.</p>;
  }
  const failedLast = s.engine.lastEvaluationOk === false;
  return (
    <div className="freshness" role="status">
      <StatusIndicator tone={failedLast ? 'bad' : s.engine.lastEvaluationAt ? 'ok' : 'muted'}>
        {s.engine.lastEvaluationAt
          ? `Остання перевірка: ${formatDate(s.engine.lastEvaluationAt)}${failedLast ? ' — з помилкою' : ''}.`
          : 'Рушій увімкнено, але перевірок ще не було.'}
      </StatusIndicator>
      <span>{s.delivery.enabled ? 'Надсилання в Slack увімкнено.' : 'Надсилання в Slack вимкнено: інциденти лише записуються.'}</span>
    </div>
  );
}

function AdminPanel({ a }: { a: NonNullable<AlertsStatus['admin']> }) {
  const t = a.thresholds;
  return (
    <details className="disclosure" aria-labelledby="alerts-admin-title">
      <summary id="alerts-admin-title">Доставка й налаштування (адміністратор)</summary>
      <dl className="facts">
        <dt>Slack webhook</dt><dd>{a.webhookConfigured ? 'Налаштовано (значення не показується)' : 'Не налаштовано'}</dd>
        <dt>Черга</dt><dd>{`у черзі ${String(a.queue.queued)} · надсилається ${String(a.queue.sending)} · надіслано ${String(a.queue.sent)} · не доставлено ${String(a.queue.failed)} · невідомо ${String(a.queue.unknown)} · відкинуто ${String(a.queue.dropped)}`}</dd>
        <dt>Остання доставка</dt><dd>{a.lastSentAt ? formatDate(a.lastSentAt) : '—'}{a.lastDeliveryError ? ` · остання помилка: ${a.lastDeliveryError}` : ''}</dd>
        <dt>Пороги</dt><dd>{`CPU процесу ≥ ${String(t.cpuOpenPercent)} % (відновлення < ${String(t.cpuClosePercent)} %), підтвердження ${String(t.confirmSamples)}/${String(t.recoverSamples)} зборів; рестарти ≥ ${String(t.restartsThreshold)} за ${String(t.restartsWindowMinutes)} хв`}</dd>
        <dt>Цикл і cooldown</dt><dd>{`перевірка кожні ${String(a.intervalSeconds)} с · cooldown ${String(a.cooldownMinutes)} хв · нагадування ${a.reminderMinutes > 0 ? `кожні ${String(a.reminderMinutes)} хв` : 'вимкнено'} · до ${String(a.maxAttempts)} спроб · черга ≤ ${String(a.queueMax)}`}</dd>
      </dl>
      <p className="hint"><Link to="/settings/integrations">Налаштувати Slack</Link> · <Link to="/settings/rules">Правила сповіщень</Link></p>
    </details>
  );
}

export function AlertsPage() {
  const { can } = useAuth();
  const loadStatus = useCallback((signal: AbortSignal) => alertsApi.status(signal), []);
  const status = usePolledResource(loadStatus, 'alerts-status');
  const loadActive = useCallback((signal: AbortSignal) => alertsApi.list('active', null, signal), []);
  const active = usePolledResource(loadActive, 'alerts-active');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const loadResolved = useCallback((signal: AbortSignal) => alertsApi.list('resolved', cursor, signal), [cursor]);
  const resolved = usePolledResource(loadResolved, `alerts-resolved:${cursor ?? 'first'}`);

  if (status.state.status === 'forbidden' || active.state.status === 'forbidden') return <Forbidden />;
  const s = status.state.status === 'ready' ? status.state.data : status.state.status === 'error' ? status.state.data : null;
  const a = active.state.status === 'ready' ? active.state.data : active.state.status === 'error' ? active.state.data : null;
  const r = resolved.state.status === 'ready' ? resolved.state.data : resolved.state.status === 'error' ? resolved.state.data : null;

  return (
    <section className="page" aria-labelledby="alerts-title">
      <PageHeader title="Сповіщення" titleId="alerts-title"
        actions={can('alerts:manage') ? <Link className="button" to="/settings/rules">Налаштувати</Link> : null} />
      {status.state.status === 'loading' ? <LoadingState label="Завантаження стану…" /> : null}
      {status.state.status === 'error' ? <ErrorState title="Не вдалося отримати стан рушія" onRetry={status.reload}>{`Стан невідомий.${formatRetry(status.state.retryAfterSeconds)}`}</ErrorState> : null}
      {s ? <StatusBanner s={s} /> : null}

      <Section title={`Активні проблеми${a ? ` (${String(a.items.length)}${a.nextBefore ? '+' : ''})` : ''}`} titleId="alerts-active-title">
        {active.state.status === 'loading' ? <LoadingState /> : null}
        {active.state.status === 'error' ? <ErrorState title="Не вдалося оновити список" onRetry={active.reload}>{`Показано останні відомі дані.${formatRetry(active.state.retryAfterSeconds)}`}</ErrorState> : null}
        {a && a.items.length === 0 ? (
          <EmptyState title="Активних інцидентів немає">
            {!s ? 'Стан рушія невідомий.' : !s.engine.enabled ? 'Рушій вимкнено — це не означає, що проблем немає.'
              : s.engine.lastEvaluationAt ? `За останньою перевіркою (${formatDate(s.engine.lastEvaluationAt)}) відкритих проблем немає.` : 'Перевірок ще не було.'}
          </EmptyState>
        ) : null}
        {a && a.items.length > 0 ? <IncidentTable items={a.items} resolved={false} /> : null}
        {a?.nextBefore ? <p className="hint">{`Показано перші ${String(a.items.length)} активних.`}</p> : null}
      </Section>

      <Section title="Закриті інциденти" titleId="alerts-history-title" meta="Історія, від нових до старіших">
        {resolved.state.status === 'loading' ? <LoadingState /> : null}
        {resolved.state.status === 'error' ? <ErrorState title="Не вдалося завантажити історію" onRetry={resolved.reload}>{formatRetry(resolved.state.retryAfterSeconds)}</ErrorState> : null}
        {r && r.items.length === 0 ? <EmptyState title="Закритих інцидентів немає" /> : null}
        {r && r.items.length > 0 ? <IncidentTable items={r.items} resolved /> : null}
        <nav className="pager" aria-label="Сторінки історії">
          <button type="button" className="button button--small" disabled={cursors.length === 1} onClick={() => { setCursors(cursors.slice(0, -1)); }}>Новіші</button>
          <span className="pager__page">{`Сторінка ${String(cursors.length)}`}</span>
          <button type="button" className="button button--small" disabled={resolved.state.status !== 'ready' || !r?.nextBefore}
            onClick={() => { if (r?.nextBefore) setCursors([...cursors, r.nextBefore]); }}>Старіші</button>
        </nav>
      </Section>

      {s?.admin ? <AdminPanel a={s.admin} /> : null}
    </section>
  );
}
