import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, applicationsApi, serversApi } from '../api/client';
import type { ApplicationItem, IssuedCredential, ServerDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { Dialog } from '../components/Dialog';
import { freshness } from '../components/appState';
import { ApplicationsTable, InventorySummary } from '../components/Inventory';
import { ProcessControl, type RowActions } from '../components/ProcessControl';
import { ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader } from '../components/ui';
import { formatAgo } from '../components/time';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate, mutationErrorMessage, StatusBadge } from './ServersPage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Server context (stage 3.1): agent signal, the only host metric Node Control keeps (ADR-023; host monitoring is
 * Zabbix's job) — the current load average — and the agent version. An offline server's last load is not shown as
 * current: the value is «—» and the reason is said once. The applications below are the main part of the page.
 */
function ServerContext({ server }: { server: ServerDetail }) {
  const s = server.snapshot;
  const online = server.status === 'online';
  return (
    <>
      <dl className="app-metrics server-context">
        <div><dt>Сигнал агента</dt><dd><span className="num">{server.lastSeenAt ? formatAgo(server.lastSeenAt) : '—'}</span>
          <span className="server-context__meta">{server.lastSeenAt ? formatDate(server.lastSeenAt) : 'агент ще не звітував'}</span></dd></div>
        {s && online ? (
          <div role="group" aria-label="Поточне навантаження"><dt>Load average 1 / 5 / 15 хв</dt>
            <dd><span className="num">{s.loadAverage.map((n) => n.toFixed(2)).join(' / ')}</span><span className="server-context__meta">черга процесів, не відсоток CPU</span></dd></div>
        ) : (
          <div><dt>Load average 1 / 5 / 15 хв</dt><dd><span className="num">—</span><span className="server-context__meta">{s ? 'сервер не онлайн' : 'даних ще немає'}</span></dd></div>
        )}
        <div><dt>Агент</dt><dd><span className="num">{s ? s.agentVersion : '—'}</span><span className="server-context__meta">{s ? `${s.platform} / ${s.arch}` : 'даних ще немає'}</span></dd></div>
      </dl>
      {!s ? <p className="hint">Агент ще не надсилав даних.</p> : null}
      {s && !online ? <p className="notice notice--warning" role="status">{`Поточне навантаження невідоме: сервер не онлайн (останній сигнал ${formatDate(server.lastSeenAt)}).`}</p> : null}
      <p className="hint">Системний моніторинг сервера (CPU, пам'ять, диски) — у Zabbix.</p>
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
        </> : null}
        <dt>Додано</dt><dd>{formatDate(server.createdAt)}</dd>
        <dt>Активність</dt><dd>{server.isActive ? 'активний' : 'неактивний — виключений з моніторингу'}</dd>
      </dl>
    </details>
  );
}

type Confirm = null | 'issue' | 'revoke';

/** The hostname only when it says something the server name does not (no duplicate). */
const extraHostname = (server: ServerDetail) => {
  const h = server.snapshot?.hostname;
  return h && h.trim().toLowerCase() !== server.name.trim().toLowerCase() ? h : null;
};

// Counts only what the projection may call current: stale or offline rows are not counted as working.
const summary = (items: ApplicationItem[]) => {
  const live = items.filter((app) => freshness(app) === 'live');
  const online = live.filter((app) => app.status === 'online').length;
  const other = live.length - online;
  const unknown = items.length - live.length;
  return `${String(items.length)} сервісів · працюють ${String(online)}${other > 0 ? ` · потребують уваги ${String(other)}` : ''}${unknown > 0 ? ` · стан невідомий ${String(unknown)}` : ''}`;
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
          {current.items.length > 0 ? <ApplicationsTable items={current.items} caption="PM2-процеси сервера" renderActions={renderActions} /> : <p className="hint">Немає зібраних процесів PM2.</p>}
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
    <section className="page ds" aria-labelledby="sd-title">
      <PageHeader title={server ? server.name : 'Сервер'} titleId="sd-title" crumbs={<Link to="/servers">← Сервери</Link>}
        status={server ? <>{<StatusBadge status={server.status} />}{server.isActive ? null : <span className="tag">неактивний</span>}</> : null}
        meta={server ? <span>{`Останній сигнал: ${formatDate(server.lastSeenAt)}`}{extraHostname(server) ? ` · хост ${extraHostname(server) ?? ''}` : ''}</span> : null} />
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити дані" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {server ? (
        <>
          <ServerContext server={server} />
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
