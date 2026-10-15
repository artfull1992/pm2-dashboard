import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, applicationsApi, serversApi } from '../api/client';
import type { IssuedCredential, ServerDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { Dialog } from '../components/Dialog';
import { ApplicationsTable, formatMemory, formatUptime, InventorySummary } from '../components/Inventory';
import { ProcessControl, type RowActions } from '../components/ProcessControl';
import { ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate, mutationErrorMessage, StatusBadge } from './ServersPage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Key numbers of the last heartbeat; an offline server's numbers are labelled as the last known snapshot. */
function Vitals({ server }: { server: ServerDetail }) {
  const s = server.snapshot;
  if (!s) return <p className="hint">Агент ще не надсилав даних.</p>;
  const total = s.memory.totalBytes;
  const used = total > 0 ? total - s.memory.freeBytes : null;
  const usedPercent = used === null ? null : Math.round((used / total) * 100);
  const outdated = server.status !== 'online';
  return (
    <>
      {outdated ? <p className="notice notice--warning" role="status">{`Сервер не онлайн — нижче останній відомий знімок (${formatDate(server.lastSeenAt)}), не поточний стан.`}</p> : null}
      <div className={`metrics${outdated ? ' dash--outdated' : ''}`} aria-label="Показники останнього heartbeat">
        <div className="metric">
          <span className="metric__label">Load average 1 / 5 / 15 хв</span>
          <strong className="metric__value">{s.loadAverage.map((n) => n.toFixed(2)).join(' / ')}</strong>
          <span className="metric__detail">{`черга процесів, не відсоток CPU · ядер: ${String(s.cpuCount)}`}</span>
        </div>
        <div className="metric">
          <span className="metric__label">Пам'ять ОС</span>
          <strong className="metric__value">{usedPercent === null ? '—' : `${String(usedPercent)} %`}</strong>
          <span className="metric__detail">{used === null ? 'обсяг невідомий' : `зайнято ${formatMemory(used)} з ${formatMemory(total)}`}</span>
        </div>
        <div className="metric">
          <span className="metric__label">Аптайм ОС</span>
          <strong className="metric__value">{formatUptime(s.uptimeSeconds)}</strong>
          <span className="metric__detail">{`агент ${s.agentVersion}`}</span>
        </div>
      </div>
    </>
  );
}

function SystemDetails({ server }: { server: ServerDetail }) {
  const s = server.snapshot;
  return (
    <details className="disclosure">
      <summary>Системні подробиці</summary>
      <dl className="facts">
        {s ? <>
          <dt>Хост</dt><dd>{s.hostname}</dd>
          <dt>Платформа</dt><dd>{`${s.platform} / ${s.arch}`}</dd>
          <dt>Версія агента</dt><dd>{s.agentVersion}</dd>
          <dt>CPU</dt><dd>{`${String(s.cpuCount)} ядер`}</dd>
          <dt>Пам'ять</dt><dd>{`вільно ${formatMemory(s.memory.freeBytes)} з ${formatMemory(s.memory.totalBytes)}`}</dd>
        </> : null}
        <dt>Додано</dt><dd>{formatDate(server.createdAt)}</dd>
        <dt>Активність</dt><dd>{server.isActive ? 'активний' : 'неактивний — виключений з моніторингу'}</dd>
      </dl>
    </details>
  );
}

type Confirm = null | 'issue' | 'revoke';

const summary = (items: { status: string }[]) => {
  const online = items.filter((app) => app.status === 'online').length;
  const other = items.length - online;
  return `${String(items.length)} сервісів · працюють ${String(online)}${other > 0 ? ` · потребують уваги ${String(other)}` : ''} (за останнім збором)`;
};

/**
 * PM2 inventory of this server (read-only). Its own polled resource keyed by the server id: after navigation to
 * another server nothing of the previous server's applications is shown (Task 007.1 rule).
 */
function ServerApplications({ serverId, refresh, renderActions }: { serverId: string; refresh: number; renderActions?: RowActions | undefined }) {
  const load = useCallback((signal: AbortSignal) => applicationsApi.forServer(serverId, signal), [serverId]);
  const { state, reload } = usePolledResource(load, serverId);
  // A finished control command asks for a fresh inventory view (the exporter/Agent cadence still applies).
  useEffect(() => { if (refresh > 0) reload(); }, [refresh, reload]);
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;
  const current = data && data.serverId === serverId ? data : null;
  return (
    <>
      <div className="section__head">
        <div>
          <h2 id="apps-title" className="section__title">Сервіси сервера</h2>
          {current ? <p className="section__meta">{summary(current.items)}</p> : null}
        </div>
        <div className="section__actions"><button type="button" className="button button--small" onClick={reload}>Оновити</button></div>
      </div>
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити застосунки" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {current ? (
        <>
          <InventorySummary inventory={current.inventory} serverStatus={current.serverStatus} />
          {current.items.length > 0 ? <ApplicationsTable items={current.items} showServer={false} caption="PM2-процеси сервера" renderActions={renderActions} /> : <p className="hint">Немає зібраних процесів PM2.</p>}
        </>
      ) : null}
    </>
  );
}

// Mounted with key = server id + session (see ServerDetailPage): switching server or session remounts it, so a
// confirmation, error or issued token of the previous server/session can never be shown or acted upon.
function CredentialControls({ server, onChanged }: { server: ServerDetail; onChanged: () => void }) {
  const { state, sessionExpired } = useAuth();
  const inflight = useRef<AbortController | null>(null);
  // Unmount (navigation, session change) cancels the pending mutation and drops its result. Cancelling the request
  // does not undo it — the server may already have applied it; nothing is retried automatically.
  useEffect(() => () => { inflight.current?.abort(); }, []);
  const [confirm, setConfirm] = useState<Confirm>(null);
  // The one-time secret lives only here and is dropped when the dialog closes; it is never logged or stored.
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const closeIssued = useCallback(() => { setIssued(null); setCopied(false); }, []);
  const closeConfirm = useCallback(() => { setConfirm(null); }, []);
  if (state.status !== 'authenticated') return null;
  const { csrfToken } = state.session;

  const run = async (action: 'issue' | 'revoke') => {
    const serverId = server.id;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setPending(true);
    setError(null);
    try {
      if (action === 'issue') {
        const result = await serversApi.issueCredential(serverId, csrfToken, controller.signal);
        if (controller.signal.aborted) return;
        // A response for another server than the one this control belongs to is never shown.
        if (result.serverId !== serverId) { setError(mutationErrorMessage(new ApiError('unexpected'))); return; }
        setIssued(result);
      } else {
        const result = await serversApi.revokeCredential(serverId, csrfToken, controller.signal);
        if (controller.signal.aborted) return;
        if (result.serverId !== serverId) { setError(mutationErrorMessage(new ApiError('unexpected'))); return; }
      }
      onChanged();
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      setError(mutationErrorMessage(e));
    } finally {
      if (inflight.current === controller) inflight.current = null;
      if (!controller.signal.aborted) {
        setPending(false);
        setConfirm(null);
      }
    }
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.token); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <section className="section" aria-labelledby="cred-title">
      <div className="section__head">
        <div>
          <h2 id="cred-title" className="section__title">Ключ агента</h2>
          <p className="section__meta">{server.hasActiveCredential ? 'Ключ видано. Нова видача відкличе попередній ключ.' : 'Активного ключа немає — агент не може надсилати дані.'}</p>
        </div>
      </div>
      <div className="button-row">
        <button type="button" className={`button ${server.hasActiveCredential ? '' : 'button--primary'}`} disabled={pending || !server.isActive}
          onClick={() => { if (server.hasActiveCredential) setConfirm('issue'); else void run('issue'); }}>
          {server.hasActiveCredential ? 'Видати новий ключ' : 'Видати ключ'}
        </button>
        {server.hasActiveCredential ? (
          <button type="button" className="button button--danger" disabled={pending} onClick={() => { setConfirm('revoke'); }}>Відкликати ключ</button>
        ) : null}
      </div>
      {error ? <p className="field__error" role="alert">{error}</p> : null}

      {confirm ? (
        <Dialog
          title={confirm === 'revoke' ? 'Відкликати ключ агента?' : 'Видати новий ключ?'}
          onClose={closeConfirm}
          actions={(
            <>
              <button type="button" className="button" onClick={closeConfirm}>Скасувати</button>
              <button type="button" className={`button ${confirm === 'revoke' ? 'button--danger' : 'button--primary'}`} disabled={pending} onClick={() => { void run(confirm); }}>
                {confirm === 'revoke' ? 'Відкликати' : 'Видати новий'}
              </button>
            </>
          )}
        >
          <p>{confirm === 'revoke'
            ? `Агент сервера «${server.name}» більше не зможе надсилати дані, доки не буде видано новий ключ.`
            : `Поточний ключ сервера «${server.name}» буде відкликано одразу; агент працюватиме лише з новим ключем.`}</p>
        </Dialog>
      ) : null}

      {issued ? (
        <Dialog title="Ключ агента видано" onClose={closeIssued}
          actions={<button type="button" className="button button--primary" onClick={closeIssued}>Я зберіг ключ — закрити</button>}>
          <p>Скопіюйте ключ зараз і запишіть його в конфігурацію агента на сервері. <strong>Після закриття вікна ключ більше не буде показано.</strong></p>
          <label className="field">
            <span>Ключ</span>
            <input className="mono" readOnly value={issued.token} onFocus={(e) => { e.target.select(); }} aria-describedby="token-hint" />
          </label>
          <p id="token-hint" className="hint">Не надсилайте ключ у месенджери й не зберігайте його в репозиторії.</p>
          <button type="button" className="button" onClick={() => { void copy(); }}>{copied ? 'Скопійовано' : 'Копіювати'}</button>
        </Dialog>
      ) : null}
    </section>
  );
}

export function ServerDetailPage() {
  const { id = '' } = useParams();
  const { can, state: auth } = useAuth();
  const load = useCallback((signal: AbortSignal) => serversApi.get(id, signal), [id]);
  const { state, reload } = usePolledResource(load, id);
  // Identity of the session the controls act for; a new session (or logout) remounts them with empty state.
  // The CSRF token is stable for the lifetime of one server session and is never rendered.
  const sessionKey = auth.status === 'authenticated' ? auth.session.csrfToken : 'anonymous';
  const [refresh, setRefresh] = useState(0);
  const bumpRefresh = useCallback(() => { setRefresh((n) => n + 1); }, []);

  if (!UUID_RE.test(id) || state.status === 'not_found') {
    return (
      <section className="page" aria-labelledby="sd-title">
        <PageHeader title="Сервер не знайдено" titleId="sd-title" crumbs={<Link to="/servers">← Сервери</Link>} />
      </section>
    );
  }
  if (state.status === 'forbidden') return <Forbidden />;
  if (state.status === 'loading') return <LoadingState />;
  const loaded = state.status === 'ready' ? state.data : state.data;
  // Defence in depth: the hook never returns another key's data, and the API echoes the requested id.
  const server = loaded && loaded.id === id ? loaded : null;

  return (
    <section className="page" aria-labelledby="sd-title">
      <PageHeader title={server ? server.name : 'Сервер'} titleId="sd-title" crumbs={<Link to="/servers">← Сервери</Link>}
        status={server ? <>{<StatusBadge status={server.status} />}{server.isActive ? null : <span className="tag">неактивний</span>}</> : null}
        meta={server ? <span>{`Останній сигнал: ${formatDate(server.lastSeenAt)}`}</span> : null} />
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити дані" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {server ? (
        <>
          <Vitals server={server} />
          <ProcessControl key={`${server.id}:${sessionKey}`} serverId={server.id} serverName={server.name} onFinished={bumpRefresh}>
            {(renderActions) => <ServerApplications serverId={server.id} refresh={refresh} renderActions={renderActions} />}
          </ProcessControl>
          <SystemDetails server={server} />
          {can('servers:manage') ? <CredentialControls key={`${server.id}:${sessionKey}`} server={server} onChanged={reload} /> : null}
        </>
      ) : null}
    </section>
  );
}
