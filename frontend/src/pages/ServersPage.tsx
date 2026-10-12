import { type SyntheticEvent, useCallback, useId, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, serversApi } from '../api/client';
import type { ServerStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { usePolledResource } from '../components/usePolledResource';

export const STATUS_LABELS: Record<ServerStatus, string> = { online: 'Онлайн', offline: 'Офлайн', never_connected: 'Ще не підключався' };
const dateFormat = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' });
export const formatDate = (iso: string | null) => (iso ? dateFormat.format(new Date(iso)) : '—');

export function StatusBadge({ status }: { status: ServerStatus }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABELS[status]}</span>;
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

function CreateServerForm({ onCreated }: { onCreated: () => void }) {
  const { state, sessionExpired } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputId = useId();
  const errorId = useId();
  if (state.status !== 'authenticated') return null;
  const { csrfToken } = state.session;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() === '') { setError('Введіть назву сервера.'); return; }
    setPending(true);
    setError(null);
    try {
      await serversApi.create(name.trim(), csrfToken);
      setName('');
      onCreated();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      setError(mutationErrorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="inline-form" onSubmit={(e) => { void onSubmit(e); }} noValidate aria-label="Додати сервер">
      <div className="field">
        <label htmlFor={inputId}>Назва нового сервера</label>
        <input id={inputId} value={name} maxLength={100} onChange={(e) => { setName(e.target.value); }} disabled={pending}
          aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
      </div>
      <button type="submit" className="button button--primary" disabled={pending}>{pending ? 'Додавання…' : 'Додати сервер'}</button>
      {error ? <p id={errorId} className="field__error" role="alert">{error}</p> : null}
    </form>
  );
}

export function ServersPage() {
  const { can } = useAuth();
  const load = useCallback((signal: AbortSignal) => serversApi.list(signal), []);
  const { state, reload } = usePolledResource(load);

  if (state.status === 'forbidden') return <Forbidden />;
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;

  return (
    <section className="page" aria-labelledby="servers-title">
      <h1 id="servers-title" className="page__title">Сервери</h1>
      {can('servers:manage') ? <CreateServerForm onCreated={reload} /> : null}
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити список" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {data && data.items.length === 0 ? (
        <EmptyState title="Ще немає підключених серверів">
          {can('servers:manage') ? 'Додайте сервер і видайте йому ключ агента.' : 'Сервери з’являться тут після підключення агента.'}
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
                  <td><Link to={`/servers/${server.id}`}>{server.name}</Link>{server.isActive ? null : ' (неактивний)'}</td>
                  <td><StatusBadge status={server.status} /></td>
                  <td>{formatDate(server.lastSeenAt)}</td>
                  <td>{server.hasActiveCredential ? 'Видано' : 'Немає'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data?.nextAfterId ? <p className="page__lead">Показано перші 100 серверів.</p> : null}
    </section>
  );
}
