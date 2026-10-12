import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Permission } from '../api/types';
import { ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { useAuth } from './AuthContext';

/** Only same-app paths: never redirect to an absolute or protocol-relative URL taken from navigation state. */
export function safeInternalPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (value.startsWith('/login')) return '/';
  return value;
}

export function UnavailableScreen({ retryAfterSeconds, onRetry }: { retryAfterSeconds: number | null; onRetry: () => void }) {
  return (
    <main className="centered" id="main">
      <ErrorState title="Сервіс тимчасово недоступний" onRetry={onRetry}>
        {`Не вдалося перевірити сесію. Дані не втрачено — повторіть спробу пізніше.${formatRetry(retryAfterSeconds)}`}
      </ErrorState>
    </main>
  );
}

/** Protected area: waits for `me`, shows "unavailable" (not logout) on 503/network, sends anonymous users to login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state, checkSession } = useAuth();
  const location = useLocation();
  if (state.status === 'checking') return <main className="centered" id="main"><LoadingState label="Перевірка сесії…" /></main>;
  if (state.status === 'unavailable') return <UnavailableScreen retryAfterSeconds={state.retryAfterSeconds} onRetry={checkSession} />;
  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname, reason: state.reason }} />;
  }
  return children;
}

export function Forbidden() {
  return (
    <section className="page" aria-labelledby="forbidden-title">
      <h1 id="forbidden-title" className="page__title">Недостатньо прав</h1>
      <p className="page__lead">Ваша роль не має доступу до цього розділу. Зверніться до адміністратора, якщо доступ потрібен.</p>
    </section>
  );
}

/** UX only — the backend enforces every permission independently. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? children : <Forbidden />;
}
