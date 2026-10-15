import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { ApiErrorKind } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { safeInternalPath } from '../auth/guards';
import { formatRetry } from '../components/StatusMessage';

export function loginErrorMessage(kind: ApiErrorKind, retryAfterSeconds: number | null): string {
  switch (kind) {
    case 'unauthorized': return 'Невірний email або пароль.';
    case 'forbidden': return 'Вхід із цієї адреси заборонено. Зверніться до адміністратора.';
    case 'rate_limited': return `Забагато спроб входу.${formatRetry(retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': case 'network': case 'timeout':
      return `Сервіс тимчасово недоступний.${formatRetry(retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'invalid_request': return 'Перевірте введені дані.';
    default: return 'Не вдалося увійти через неочікувану помилку. Спробуйте ще раз.';
  }
}

interface FieldErrors { email?: string; password?: string }

export function LoginPage() {
  const { state, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Incremented per failed attempt: focus moves to the password field after the re-render that re-enables it.
  const [failureSeq, setFailureSeq] = useState(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ids = { email: useId(), password: useId(), emailError: useId(), passwordError: useId() };

  useEffect(() => {
    if (failureSeq > 0) passwordRef.current?.focus();
  }, [failureSeq]);

  const navState = location.state as { from?: unknown; reason?: unknown } | null;
  const target = safeInternalPath(navState?.from);
  if (state.status === 'authenticated') return <Navigate to={target} replace />;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: FieldErrors = {};
    if (!/^[^@\s]+@[^@\s]+$/.test(email.trim())) errors.email = 'Введіть коректний email.';
    if (password.length === 0) errors.password = 'Введіть пароль.';
    setFieldErrors(errors);
    setFormError(null);
    if (errors.email) { emailRef.current?.focus(); return; }
    if (errors.password) { passwordRef.current?.focus(); return; }

    setPending(true);
    const outcome = await login(email, password);
    setPassword(''); // never keep the password after the request completed
    setPending(false);
    if (outcome.ok) {
      void navigate(target, { replace: true });
      return;
    }
    if (outcome.kind === 'aborted') return;
    setFormError(loginErrorMessage(outcome.kind, outcome.retryAfterSeconds));
    setFailureSeq((n) => n + 1);
  };

  const NOTICES: Record<string, string> = {
    expired: 'Сесія завершилась. Увійдіть знову.',
    logged_out: 'Ви вийшли з системи.',
    password_changed: 'Пароль змінено. Усі сесії завершено — увійдіть з новим паролем.',
  };
  const notice = typeof navState?.reason === 'string' ? NOTICES[navState.reason] ?? null : null;

  return (
    <main className="login" id="main">
      <form className="login__card" onSubmit={(e) => { void onSubmit(e); }} noValidate aria-labelledby="login-title">
        <h1 id="login-title" className="login__title">Node Control</h1>
        <p className="login__subtitle">Увійдіть, щоб продовжити</p>
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {formError ? <p className="form-error" role="alert">{formError}</p> : null}

        <div className="field">
          <label htmlFor={ids.email}>Email</label>
          <input
            ref={emailRef} id={ids.email} name="email" type="email" autoComplete="username" required
            value={email} onChange={(e) => { setEmail(e.target.value); }}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? ids.emailError : undefined}
            disabled={pending}
          />
          {fieldErrors.email ? <p id={ids.emailError} className="field__error">{fieldErrors.email}</p> : null}
        </div>

        <div className="field">
          <label htmlFor={ids.password}>Пароль</label>
          <input
            ref={passwordRef} id={ids.password} name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => { setPassword(e.target.value); }}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? ids.passwordError : undefined}
            disabled={pending}
          />
          {fieldErrors.password ? <p id={ids.passwordError} className="field__error">{fieldErrors.password}</p> : null}
        </div>

        <button type="submit" className="button button--primary button--block" disabled={pending}>
          {pending ? 'Вхід…' : 'Увійти'}
        </button>
      </form>
    </main>
  );
}
