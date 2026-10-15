import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchAuditPage } from '../api/client';
import type { AuditItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader, StatusIndicator, type Tone } from '../components/ui';

const EVENT_LABELS: Record<string, string> = {
  'admin.bootstrap': 'Створення адміністратора',
  'auth.login': 'Вхід',
  'auth.logout': 'Вихід',
  'authz.denied': 'Відмова в доступі',
  'auth.password_change': 'Зміна власного пароля',
  'user.created': 'Створення користувача',
  'user.create_rejected': 'Створення користувача відхилено',
  'user.role_changed': 'Зміна ролі',
  'user.deactivated': 'Деактивація користувача',
  'user.activated': 'Активація користувача',
  'user.update_rejected': 'Зміну користувача відхилено',
};
const OUTCOME_LABELS: Record<AuditItem['outcome'], string> = { success: 'Успіх', failure: 'Невдача', denied: 'Відмовлено' };
const OUTCOME_TONES: Record<AuditItem['outcome'], Tone> = { success: 'muted', failure: 'bad', denied: 'warn' };
const REASON_LABELS: Record<string, string> = {
  invalid_credentials: 'невірні облікові дані', inactive_user: 'неактивний користувач', stale_credentials: 'облікові дані змінено паралельно',
  invalid_current_password: 'невірний поточний пароль', email_taken: 'email уже зайнятий', self_change: 'зміна власного облікового запису',
  last_admin: 'останній активний адміністратор',
};
const dateFormat = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' });

/** Details are rendered as plain text from an allowlist of keys — never as HTML. */
function describeDetails(details: AuditItem['details']): string {
  const parts: string[] = [];
  if (details.reason) parts.push(`причина: ${REASON_LABELS[details.reason] ?? details.reason}`);
  if (details.permission) parts.push(`дозвіл: ${details.permission}`);
  if (details.route) parts.push(`маршрут: ${details.route}`);
  if (details.targetKey) parts.push(`сервіс: ${details.targetKey}`);
  if (details.action) parts.push(`дія: ${details.action}`);
  if (details.targetUserId) parts.push(`користувач: ${details.targetUserId.slice(0, 8)}`);
  if (details.role) parts.push(`роль: ${details.role}`);
  if (details.fromRole && details.toRole) parts.push(`роль: ${details.fromRole} → ${details.toRole}`);
  if (details.sessionsRevoked !== undefined) parts.push(`завершено сесій: ${String(details.sessionsRevoked)}`);
  return parts.join('; ') || '—';
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'forbidden' }
  | { status: 'error'; retryAfterSeconds: number | null };

export function AuditPage() {
  const { sessionExpired } = useAuth();
  const [items, setItems] = useState<AuditItem[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<string | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const controller = useRef<AbortController | null>(null);

  /** Applies a result only if its request is still the current one (no stale pages after unmount/logout). */
  const request = useCallback((beforeId: string | null): Promise<void> => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    return fetchAuditPage(beforeId, current.signal).then(
      (page) => {
        if (current.signal.aborted) return;
        setItems((prev) => (beforeId === null ? page.items : [...prev, ...page.items]));
        setNextBeforeId(page.nextBeforeId);
        setLoad({ status: 'ready' });
      },
      (error: unknown) => {
        if (current.signal.aborted || !(error instanceof ApiError) || error.kind === 'aborted') return;
        if (error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error.kind === 'forbidden') { setLoad({ status: 'forbidden' }); return; }
        setLoad({ status: 'error', retryAfterSeconds: error.retryAfterSeconds });
      },
    );
  }, [sessionExpired]);

  useEffect(() => {
    void request(null);
    return () => { controller.current?.abort(); };
  }, [request, reloadKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    await request(nextBeforeId);
    setLoadingMore(false);
  };

  const retry = () => {
    setLoad({ status: 'loading' });
    setReloadKey((k) => k + 1);
  };

  if (load.status === 'forbidden') return <Forbidden />;

  return (
    <section className="page" aria-labelledby="audit-title">
      <PageHeader title="Журнал аудиту" titleId="audit-title" meta={<span>Події безпеки й керування, від нових до старіших. Час — повна локальна дата.</span>} />
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? (
        <ErrorState title="Не вдалося завантажити журнал" onRetry={retry}>
          {`Сервіс тимчасово недоступний.${formatRetry(load.retryAfterSeconds)}`}
        </ErrorState>
      ) : null}
      {load.status === 'ready' && items.length === 0 ? <EmptyState title="Подій ще немає" /> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Події безпеки, від нових до старіших</caption>
            <thead>
              <tr>
                <th scope="col">Час</th>
                <th scope="col">Подія</th>
                <th scope="col">Результат</th>
                <th scope="col">Користувач (ID)</th>
                <th scope="col">Запит (ID)</th>
                <th scope="col">Деталі</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="date"><time dateTime={item.occurredAt}>{dateFormat.format(new Date(item.occurredAt))}</time></td>
                  <td>{EVENT_LABELS[item.event] ?? item.event}</td>
                  <td><StatusIndicator tone={OUTCOME_TONES[item.outcome]}>{OUTCOME_LABELS[item.outcome]}</StatusIndicator></td>
                  <td className="mono secondary">{item.actorUserId ?? '—'}</td>
                  <td className="mono secondary">{item.requestId ?? '—'}</td>
                  <td>{describeDetails(item.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {load.status === 'ready' && nextBeforeId !== null ? (
        <button type="button" className="button" onClick={() => { void loadMore(); }} disabled={loadingMore}>
          {loadingMore ? 'Завантаження…' : 'Показати старіші'}
        </button>
      ) : null}
    </section>
  );
}
