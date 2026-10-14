import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, authApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABELS } from '../components/Layout';
import { formatRetry } from '../components/StatusMessage';

// Own account (ADR-019): email, role and the self-service password change. Passwords live only in this form's state:
// cleared after every request, on success (the whole private area is dropped) and on unmount. Never retried.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
/** Same rule as the server: Unicode code points, no trimming or normalization. */
export const passwordLength = (value: string) => Array.from(value).length;

export function passwordChangeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Спробуйте ще раз.';
  switch (error.kind) {
    case 'unprocessable': return 'Поточний пароль невірний.';
    case 'invalid_request': return `Новий пароль має містити від ${String(PASSWORD_MIN)} до ${String(PASSWORD_MAX)} символів і відрізнятися від поточного.`;
    case 'rate_limited': return `Забагато спроб зміни пароля.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': return `Сервіс тимчасово перевантажений або недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'network': case 'timeout':
      return 'Відповідь не отримано — пароль міг змінитися. Не надсилайте повторно: оновіть сторінку; якщо сесію завершено, увійдіть із новим паролем, інакше — з поточним.';
    default: return 'Неочікувана помилка. Спробуйте ще раз.';
  }
}

interface Errors { current?: string; next?: string; confirm?: string }

export function AccountPage() {
  const { state, sessionExpired, passwordChanged } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const refs = { current: useRef<HTMLInputElement>(null), next: useRef<HTMLInputElement>(null), confirm: useRef<HTMLInputElement>(null) };
  const ids = { current: useId(), next: useId(), confirm: useId(), currentError: useId(), nextError: useId(), confirmError: useId(), rule: useId() };

  // Unmount (navigation, logout, session change): abort and forget; state is discarded with the component.
  useEffect(() => () => { inflight.current?.abort(); }, []);

  if (state.status !== 'authenticated') return null;
  const { user, csrfToken } = state.session;

  const validate = (): Errors => {
    const e: Errors = {};
    if (current.length === 0) e.current = 'Введіть поточний пароль.';
    const len = passwordLength(next);
    if (len < PASSWORD_MIN || len > PASSWORD_MAX) e.next = `Від ${String(PASSWORD_MIN)} до ${String(PASSWORD_MAX)} символів.`;
    else if (next === current) e.next = 'Новий пароль має відрізнятися від поточного.';
    if (confirm !== next) e.confirm = 'Паролі не збігаються.';
    return e;
  };

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const found = validate();
    setErrors(found);
    setFormError(null);
    const first = (['current', 'next', 'confirm'] as const).find((k) => found[k]);
    if (first) { refs[first].current?.focus(); return; }

    setPending(true);
    const controller = new AbortController();
    inflight.current = controller;
    try {
      await authApi.changePassword(current, next, csrfToken, controller.signal);
      setCurrent(''); setNext(''); setConfirm('');
      passwordChanged(); // every session is gone: private area unmounts, login shows the notice
    } catch (error) {
      if (controller.signal.aborted) return;
      setCurrent(''); setNext(''); setConfirm('');
      if (error instanceof ApiError && (error.kind === 'unauthorized' || error.kind === 'conflict')) { sessionExpired(); return; }
      setFormError(passwordChangeError(error));
      refs.current.current?.focus();
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (inflight.current === controller) inflight.current = null;
    }
  };

  const field = (key: 'current' | 'next' | 'confirm', label: string, value: string, set: (v: string) => void, autoComplete: string) => {
    const errorId = ids[`${key}Error`];
    const describedBy = [errors[key] ? errorId : null, key === 'next' ? ids.rule : null].filter(Boolean).join(' ');
    return (
      <div className="field">
        <label htmlFor={ids[key]}>{label}</label>
        <input
          ref={refs[key]} id={ids[key]} type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} maxLength={1024}
          onChange={(e) => { set(e.target.value); }} disabled={pending} required spellCheck={false} autoCapitalize="off"
          aria-invalid={errors[key] ? true : undefined} aria-describedby={describedBy || undefined}
        />
        {key === 'next' ? <p id={ids.rule} className="hint">{`Від ${String(PASSWORD_MIN)} до ${String(PASSWORD_MAX)} символів; не збігається з поточним.`}</p> : null}
        {errors[key] ? <p id={errorId} className="field__error">{errors[key]}</p> : null}
      </div>
    );
  };

  return (
    <section className="page" aria-labelledby="account-title">
      <h1 id="account-title" className="page__title">Обліковий запис</h1>
      <dl className="facts">
        <dt>Email</dt><dd>{user.email}</dd>
        <dt>Роль</dt><dd>{ROLE_LABELS[user.role]}</dd>
      </dl>
      <form className="card account-form" onSubmit={(e) => { void onSubmit(e); }} noValidate aria-labelledby="password-title">
        <h2 id="password-title" className="card__title">Зміна пароля</h2>
        <p className="notice notice--warning">Після зміни пароля всі ваші сесії буде завершено, зокрема на інших пристроях. Увійдіть знову з новим паролем.</p>
        {formError ? <p className="form-error" role="alert">{formError}</p> : null}
        {field('current', 'Поточний пароль', current, setCurrent, 'current-password')}
        {field('next', 'Новий пароль', next, setNext, 'new-password')}
        {field('confirm', 'Повторіть новий пароль', confirm, setConfirm, 'new-password')}
        <div className="button-row">
          <button type="button" className="button button--secondary" aria-pressed={visible} onClick={() => { setVisible((v) => !v); }}>
            {visible ? 'Приховати паролі' : 'Показати паролі'}
          </button>
          <button type="submit" className="button button--primary" disabled={pending}>{pending ? 'Зміна…' : 'Змінити пароль'}</button>
        </div>
      </form>
    </section>
  );
}
