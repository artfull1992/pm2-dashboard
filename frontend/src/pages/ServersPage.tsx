import { type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, serversApi } from '../api/client';
import type { ServerStatus, ServerSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { FormDialog } from '../components/Dialog';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader, StatusIndicator, type Tone } from '../components/ui';
import { usePolledResource } from '../components/usePolledResource';

export const STATUS_LABELS: Record<ServerStatus, string> = { online: 'Онлайн', offline: 'Офлайн', never_connected: 'Ще не підключався' };
const STATUS_TONES: Record<ServerStatus, Tone> = { online: 'ok', offline: 'bad', never_connected: 'muted' };
const dateFormat = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' });
export const formatDate = (iso: string | null) => (iso ? dateFormat.format(new Date(iso)) : '—');

export function StatusBadge({ status }: { status: ServerStatus }) {
  return <StatusIndicator tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</StatusIndicator>;
}

export function mutationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Спробуйте ще раз.';
  switch (error.kind) {
    case 'conflict': return 'Сервер із такою назвою вже існує або він неактивний.';
    case 'invalid_request': return 'Перевірте введені дані.';
    case 'forbidden': return 'Недостатньо прав для цієї дії.';
    case 'not_found': return 'Сервер не знайдено.';
    case 'unavailable': case 'network': case 'timeout': return `Сервіс тимчасово недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    default: return 'Неочікувана помилка. Спробуйте ще раз.';
  }
}

/** Creation result is unknown when no answer arrived: the server may exist already, so the list is reloaded first. */
const createUnknown = (error: unknown) => error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout');

/**
 * Create form in a dialog. The request is sent once, bound to the session and aborted on unmount: an answer that
 * arrives after navigation, logout or a new login changes nothing (the server may still have created the record).
 */
function CreateServerDialog({ onCreated, onUnknown, onClose }: { onCreated: (server: ServerSummary) => void; onUnknown: () => void; onClose: () => void }) {
  const { state, sessionExpired, bindSession } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();
  useEffect(() => () => { inflight.current?.abort(); }, []);
  if (state.status !== 'authenticated') return null;
  const { csrfToken } = state.session;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (name.trim() === '') { setError('Введіть назву сервера.'); return; }
    setPending(true);
    setError(null);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    try {
      const created = await serversApi.create(name.trim(), csrfToken, controller.signal);
      if (stale()) return;
      onCreated(created);
    } catch (e) {
      if (stale()) return;
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      if (createUnknown(e)) {
        setError('Відповідь не отримано — сервер міг бути створений. Перевірте список серверів, перш ніж повторювати.');
        onUnknown();
      } else {
        setError(mutationErrorMessage(e));
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <FormDialog title="Новий сервер" submitLabel="Додати" pendingLabel="Додавання…" pending={pending} dirty={name.trim() !== ''}
      onSubmit={(e) => { void onSubmit(e); }} onClose={onClose}>
      <div className="field">
        <label htmlFor={inputId}>Назва нового сервера</label>
        <input id={inputId} value={name} maxLength={100} onChange={(e) => { setName(e.target.value); }} disabled={pending} autoComplete="off"
          aria-invalid={error ? true : undefined} aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(' ')} />
        <p id={hintId} className="hint">Ключ агента видається на сторінці сервера після створення.</p>
      </div>
      {error ? <p id={errorId} className="form-error" role="alert">{error}</p> : null}
    </FormDialog>
  );
}

export function ServersPage() {
  const { can } = useAuth();
  const load = useCallback((signal: AbortSignal) => serversApi.list(signal), []);
  const { state, reload } = usePolledResource(load, 'servers');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ServerSummary | null>(null);
  const closeCreate = useCallback(() => { setCreating(false); }, []);

  if (state.status === 'forbidden') return <Forbidden />;
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;
  const manage = can('servers:manage');
  const online = data ? data.items.filter((s) => s.status === 'online').length : 0;

  return (
    <section className="page" aria-labelledby="servers-title">
      <PageHeader title="Сервери" titleId="servers-title"
        meta={data ? <span>{`${String(data.items.length)} серверів · онлайн ${String(online)} · онлайн = сигнал агента за останні ${String(data.onlineWindowSeconds)} с`}</span> : null}
        actions={manage ? <button type="button" className="button button--primary" onClick={() => { setCreated(null); setCreating(true); }}>Додати сервер</button> : null} />
      {created ? (
        <p className="notice status-bar" role="status">
          <span>{`Сервер «${created.name}» додано. Відкрийте його, щоб видати ключ агента.`}</span>
          <Link to={`/servers/${created.id}`}>Відкрити</Link>
        </p>
      ) : null}
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити список" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {data && data.items.length === 0 ? (
        <EmptyState title="Ще немає підключених серверів">
          {manage ? 'Додайте сервер і видайте йому ключ агента.' : 'Сервери з’являться тут після підключення агента.'}
        </EmptyState>
      ) : null}
      {data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">{`Сервери; онлайн — останній сигнал за ${String(data.onlineWindowSeconds)} с`}</caption>
            <thead><tr><th scope="col">Назва</th><th scope="col">Стан</th><th scope="col">Останній сигнал</th><th scope="col">Ключ агента</th></tr></thead>
            <tbody>
              {data.items.map((server) => (
                <tr key={server.id}>
                  <td><Link to={`/servers/${server.id}`}>{server.name}</Link>{server.isActive ? null : <span className="tag">неактивний</span>}</td>
                  <td><StatusBadge status={server.status} /></td>
                  <td className="date secondary">{formatDate(server.lastSeenAt)}</td>
                  <td className="secondary">{server.hasActiveCredential ? 'Видано' : 'Немає'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data?.nextAfterId ? <p className="hint">Показано перші 100 серверів.</p> : null}
      {creating ? (
        <CreateServerDialog onClose={closeCreate} onUnknown={reload}
          onCreated={(server) => { setCreating(false); setCreated(server); reload(); }} />
      ) : null}
    </section>
  );
}
