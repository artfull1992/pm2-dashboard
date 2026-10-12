import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, serversApi } from '../api/client';
import type { IssuedCredential, ServerDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { Dialog } from '../components/Dialog';
import { ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { usePolledResource } from '../components/usePolledResource';
import { formatDate, mutationErrorMessage, StatusBadge } from './ServersPage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GiB = 1024 ** 3;
const formatGiB = (bytes: number) => `${(bytes / GiB).toFixed(1)} ГіБ`;

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days > 0 ? `${String(days)} д ` : ''}${String(hours)} год ${String(minutes)} хв`;
}

function Snapshot({ server }: { server: ServerDetail }) {
  const s = server.snapshot;
  if (!s) return <p className="page__lead">Агент ще не надсилав даних.</p>;
  return (
    <dl className="facts">
      <dt>Хост</dt><dd>{s.hostname}</dd>
      <dt>Платформа</dt><dd>{`${s.platform} / ${s.arch}`}</dd>
      <dt>Версія агента</dt><dd>{s.agentVersion}</dd>
      <dt>Аптайм</dt><dd>{formatUptime(s.uptimeSeconds)}</dd>
      <dt>CPU</dt><dd>{`${String(s.cpuCount)} ядер`}</dd>
      <dt>Load average (1/5/15 хв)</dt>
      <dd>{s.loadAverage.map((n) => n.toFixed(2)).join(' / ')} <span className="hint">— довжина черги процесів, не відсоток CPU</span></dd>
      <dt>Пам'ять</dt><dd>{`вільно ${formatGiB(s.memory.freeBytes)} з ${formatGiB(s.memory.totalBytes)}`}</dd>
    </dl>
  );
}

type Confirm = null | 'issue' | 'revoke';

function CredentialControls({ server, onChanged }: { server: ServerDetail; onChanged: () => void }) {
  const { state, sessionExpired } = useAuth();
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
    setPending(true);
    setError(null);
    try {
      if (action === 'issue') setIssued(await serversApi.issueCredential(server.id, csrfToken));
      else await serversApi.revokeCredential(server.id, csrfToken);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      setError(mutationErrorMessage(e));
    } finally {
      setPending(false);
      setConfirm(null);
    }
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.token); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <section className="card" aria-labelledby="cred-title">
      <h2 id="cred-title" className="card__title">Ключ агента</h2>
      <p className="card__text">{server.hasActiveCredential ? 'Ключ видано. Нова видача відкличе попередній ключ.' : 'Активного ключа немає — агент не може надсилати дані.'}</p>
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={pending || !server.isActive}
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
  const { can } = useAuth();
  const load = useCallback((signal: AbortSignal) => serversApi.get(id, signal), [id]);
  const { state, reload } = usePolledResource(load);

  if (!UUID_RE.test(id) || state.status === 'not_found') {
    return (
      <section className="page" aria-labelledby="sd-title">
        <h1 id="sd-title" className="page__title">Сервер не знайдено</h1>
        <p className="page__lead"><Link to="/servers">До списку серверів</Link></p>
      </section>
    );
  }
  if (state.status === 'forbidden') return <Forbidden />;
  if (state.status === 'loading') return <LoadingState />;
  const server = state.status === 'ready' ? state.data : state.data;

  return (
    <section className="page" aria-labelledby="sd-title">
      <p><Link to="/servers">← Сервери</Link></p>
      <h1 id="sd-title" className="page__title">{server ? server.name : 'Сервер'}</h1>
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити дані" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {server ? (
        <>
          <div className="cards">
            <article className="card">
              <h2 className="card__title">Стан</h2>
              <p><StatusBadge status={server.status} />{server.isActive ? null : ' · неактивний'}</p>
              <p className="card__text">Останній сигнал: {formatDate(server.lastSeenAt)}</p>
              <p className="card__text">Додано: {formatDate(server.createdAt)}</p>
            </article>
            <article className="card">
              <h2 className="card__title">Система</h2>
              <Snapshot server={server} />
            </article>
          </div>
          {can('servers:manage') ? <CredentialControls server={server} onChanged={reload} /> : null}
        </>
      ) : null}
    </section>
  );
}
