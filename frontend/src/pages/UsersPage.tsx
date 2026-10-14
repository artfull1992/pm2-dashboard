import { type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, USERS_PAGE_SIZE, usersApi } from '../api/client';
import { KNOWN_ROLES, type Role, type UserView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { ActionMenu } from '../components/ActionMenu';
import { Dialog } from '../components/Dialog';
import { ROLE_LABELS } from '../components/Layout';
import { EmptyState, ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { usePolledResource } from '../components/usePolledResource';
import { PASSWORD_MAX, PASSWORD_MIN, passwordLength } from './AccountPage';
import { formatDate } from './ServersPage';

// User administration (ADR-019), users:manage only (the API enforces it independently). One table with a row "Дії"
// menu; every mutation is confirmed, sent once (never retried automatically) and followed by a reload. Mounted per
// session (Layout key), so nothing of another session survives; late answers after unmount are ignored.

function userError(error: unknown, kind: 'create' | 'update'): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Оновіть список і перевірте стан.';
  switch (error.kind) {
    case 'conflict': return kind === 'create' ? 'Користувач із таким email уже існує.' : 'Не можна залишити систему без активного адміністратора.';
    case 'forbidden': return kind === 'update' ? 'Власну роль чи активність змінює лише інший адміністратор.' : 'Недостатньо прав для керування користувачами.';
    case 'not_found': return 'Користувача не знайдено. Оновіть список.';
    case 'invalid_request': return `Перевірте дані: коректний email і пароль від ${String(PASSWORD_MIN)} до ${String(PASSWORD_MAX)} символів.`;
    case 'rate_limited': return `Забагато змін поспіль.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': return `Сервіс тимчасово недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'network': case 'timeout':
      return 'Відповідь не отримано — дія могла виконатися. Не повторюйте наосліп: оновіть список і перевірте стан користувача.';
    default: return 'Неочікувана помилка. Оновіть список і перевірте стан.';
  }
}

function CreateUserForm({ onCreated }: { onCreated: (user: UserView) => void }) {
  const { state, sessionExpired, bindSession } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  // Paging stays usable while a create is pending. The answer must reach the CURRENT page's callback (its data and its
  // keyed reload), not the one captured when the request started — that would reload an abandoned cursor (Task 011.2).
  const latestOnCreated = useRef(onCreated);
  useEffect(() => { latestOnCreated.current = onCreated; });
  const ids = { email: useId(), password: useId(), role: useId(), emailError: useId(), passwordError: useId() };
  useEffect(() => () => { inflight.current?.abort(); }, []);
  if (state.status !== 'authenticated') return null;
  const { csrfToken } = state.session;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const found: { email?: string; password?: string } = {};
    if (!/^[^@\s]+@[^@\s]+$/.test(email.trim())) found.email = 'Введіть коректний email.';
    const len = passwordLength(password);
    if (len < PASSWORD_MIN || len > PASSWORD_MAX) found.password = `Від ${String(PASSWORD_MIN)} до ${String(PASSWORD_MAX)} символів.`;
    setErrors(found);
    setFormError(null);
    if (found.email || found.password) return;
    setPending(true);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    try {
      const user = await usersApi.create({ email: email.trim(), password, role }, csrfToken, controller.signal);
      if (stale()) return; // left the page or the session: no callback, no reload
      setEmail(''); setPassword(''); setRole('viewer'); setVisible(false);
      latestOnCreated.current(user);
    } catch (error) {
      if (stale()) return;
      setPassword('');
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
      setFormError(userError(error, 'create'));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <form className="card user-create" onSubmit={(e) => { void onSubmit(e); }} noValidate aria-labelledby="user-create-title">
      <h2 id="user-create-title" className="card__title">Новий користувач</h2>
      <p className="hint">Початковий пароль передайте користувачеві захищеним каналом; після входу він змінює його на сторінці «Обліковий запис».</p>
      {formError ? <p className="form-error" role="alert">{formError}</p> : null}
      <div className="user-create__fields">
        <div className="field">
          <label htmlFor={ids.email}>Email</label>
          <input id={ids.email} type="email" autoComplete="off" value={email} maxLength={254} disabled={pending} spellCheck={false}
            onChange={(e) => { setEmail(e.target.value); }} aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? ids.emailError : undefined} />
          {errors.email ? <p id={ids.emailError} className="field__error">{errors.email}</p> : null}
        </div>
        <div className="field">
          <label htmlFor={ids.password}>Початковий пароль</label>
          <input id={ids.password} type={visible ? 'text' : 'password'} autoComplete="new-password" value={password} maxLength={1024} disabled={pending}
            spellCheck={false} autoCapitalize="off" onChange={(e) => { setPassword(e.target.value); }}
            aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? ids.passwordError : undefined} />
          {errors.password ? <p id={ids.passwordError} className="field__error">{errors.password}</p> : null}
        </div>
        <div className="field">
          <label htmlFor={ids.role}>Роль</label>
          <select id={ids.role} value={role} disabled={pending} onChange={(e) => { setRole(e.target.value as Role); }}>
            {KNOWN_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
      </div>
      <div className="button-row">
        <button type="button" className="button button--secondary" aria-pressed={visible} onClick={() => { setVisible((v) => !v); }}>
          {visible ? 'Приховати пароль' : 'Показати пароль'}
        </button>
        <button type="submit" className="button button--primary" disabled={pending}>{pending ? 'Створення…' : 'Створити користувача'}</button>
      </div>
    </form>
  );
}

type Pending = { kind: 'role'; user: UserView; role: Role } | { kind: 'active'; user: UserView; isActive: boolean };
interface Status { text: string; find?: UserView }

/** Bound for "Показати": at most this many pages are walked to reach a newly created user (5 000 users). */
export const MAX_SEEK_PAGES = 50;

export function UsersPage() {
  const { state: auth, sessionExpired, bindSession } = useAuth();
  // Keyset pages: the cursor of each visited page (null = first). "Назад" pops, "Далі" pushes nextAfter. The resource
  // is keyed by the cursor, so another page's data is never shown and a late answer for a page we left is dropped.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback((signal: AbortSignal) => usersApi.list(cursor, signal), [cursor]);
  const { state, reload } = usePolledResource(load, `users:${cursor ?? 'first'}`);
  const [dialog, setDialog] = useState<Pending | null>(null);
  const [pending, setPending] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const roleId = useId();
  useEffect(() => () => { inflight.current?.abort(); }, []);
  const close = useCallback(() => { if (!pending) { setDialog(null); setDialogError(null); } }, [pending]);

  if (state.status === 'forbidden') return <Forbidden />;
  if (auth.status !== 'authenticated') return null;
  const me = auth.session.user.id;
  const { csrfToken } = auth.session;
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;

  const busy = pending || seeking;
  const go = (next: (string | null)[]) => { setStatus(null); setCursors(next); };

  const submit = async () => {
    if (!dialog || pending) return;
    const target = dialog;
    setPending(true);
    setDialogError(null);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    try {
      const change = target.kind === 'role' ? { role: target.role } : { isActive: target.isActive };
      const updated = await usersApi.update(target.user.id, change, csrfToken, controller.signal);
      if (stale()) return; // left the page or the session: nothing to update, no reload
      setDialog(null);
      setStatus({ text: target.kind === 'role'
        ? `Роль ${updated.email} змінено на «${ROLE_LABELS[updated.role]}». Усі його сесії завершено.`
        : updated.isActive ? `${updated.email} знову активний. Попередні сесії не відновлюються.` : `${updated.email} деактивовано. Усі його сесії завершено.` });
      reload(); // the same page (same cursor)
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
      setDialogError(userError(error, 'update'));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  /** Created users sort last: walk the pages from here (bounded) until the page that holds `user`, then show it. */
  const seek = async (user: UserView) => {
    if (busy) return;
    setSeeking(true);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    const path: string[] = [];
    let at = cursor;
    try {
      for (let i = 0; i < MAX_SEEK_PAGES; i++) {
        const found = await usersApi.list(at, controller.signal);
        if (stale()) return;
        if (found.items.some((u) => u.id === user.id)) { setStatus(null); setCursors((prev) => [...prev, ...path]); return; }
        if (found.nextAfter === null) break;
        path.push(found.nextAfter);
        at = found.nextAfter;
      }
      setStatus({ text: `Не вдалося знайти ${user.email} у списку. Оновіть сторінку й перегляньте останні сторінки.` });
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
      setStatus({ text: userError(error, 'update'), find: user });
    } finally {
      if (!stale()) setSeeking(false);
    }
  };

  const onCreated = (user: UserView) => {
    // Visible here only if this is the last page and it has room; otherwise say where it is and offer to open it.
    const here = data !== null && data.nextAfter === null && data.items.length < USERS_PAGE_SIZE;
    const text = `Користувача ${user.email} створено (${ROLE_LABELS[user.role]}).`;
    setStatus(here ? { text } : { text: `${text} Нові користувачі — наприкінці списку.`, find: user });
    reload();
  };

  const dialogTitle = dialog?.kind === 'role' ? `Змінити роль: ${dialog.user.email}` : dialog?.kind === 'active' && dialog.isActive ? `Активувати: ${dialog.user.email}` : `Деактивувати: ${dialog?.user.email ?? ''}`;

  return (
    <section className="page" aria-labelledby="users-title">
      <h1 id="users-title" className="page__title">Користувачі</h1>
      <CreateUserForm onCreated={onCreated} />
      {status ? (
        <div className="notice user-status" role="status">
          <span>{status.text}</span>
          {status.find ? (
            <button type="button" className="button button--secondary" disabled={busy} aria-label={`Показати ${status.find.email}`}
              onClick={() => { if (status.find) void seek(status.find); }}>{seeking ? 'Пошук…' : 'Показати'}</button>
          ) : null}
        </div>
      ) : null}
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? (
        <ErrorState title="Не вдалося оновити список" onRetry={reload}>{`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}`}</ErrorState>
      ) : null}
      {data && data.items.length === 0 ? <EmptyState title="Користувачів ще немає" /> : null}
      {data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table service-table">
            <caption className="visually-hidden">Користувачі системи</caption>
            <thead><tr><th scope="col">Email</th><th scope="col">Роль</th><th scope="col">Активність</th><th scope="col">Створено</th><th scope="col">Дії</th></tr></thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <th scope="row"><span className="mono">{u.email}</span>{u.id === me ? <span className="badge badge--self">Ви</span> : null}</th>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td><span className={`badge ${u.isActive ? 'badge--online' : 'badge--offline'}`}>{u.isActive ? 'Активний' : 'Деактивований'}</span></td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    {u.id === me ? <span className="hint">Власний обліковий запис: роль і активність змінює інший адміністратор.</span> : (
                      <ActionMenu name={u.email} items={[
                        { key: 'role', label: 'Змінити роль', disabled: busy, onSelect: () => { setStatus(null); setDialogError(null); setDialog({ kind: 'role', user: u, role: u.role }); } },
                        u.isActive
                          ? { key: 'active', label: 'Деактивувати', danger: true, disabled: busy, onSelect: () => { setStatus(null); setDialogError(null); setDialog({ kind: 'active', user: u, isActive: false }); } }
                          : { key: 'active', label: 'Активувати', disabled: busy, onSelect: () => { setStatus(null); setDialogError(null); setDialog({ kind: 'active', user: u, isActive: true }); } },
                      ]} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <nav className="pager" aria-label="Сторінки користувачів">
        <button type="button" className="button button--secondary" disabled={busy || cursors.length === 1} onClick={() => { go(cursors.slice(0, -1)); }}>Назад</button>
        <span className="pager__page" aria-live="polite">{`Сторінка ${String(cursors.length)}`}</span>
        <button type="button" className="button button--secondary" disabled={busy || state.status !== 'ready' || !data?.nextAfter}
          onClick={() => { if (data?.nextAfter) go([...cursors, data.nextAfter]); }}>Далі</button>
      </nav>
      {dialog ? (
        <Dialog title={dialogTitle} onClose={close} actions={(
          <>
            <button type="button" className="button button--secondary" onClick={close} disabled={pending}>Скасувати</button>
            <button type="button" className={`button ${dialog.kind === 'active' && !dialog.isActive ? 'button--danger' : 'button--primary'}`}
              onClick={() => { void submit(); }} disabled={pending || (dialog.kind === 'role' && dialog.role === dialog.user.role)}>
              {pending ? 'Збереження…' : dialog.kind === 'role' ? 'Змінити роль' : dialog.isActive ? 'Активувати' : 'Деактивувати'}
            </button>
          </>
        )}>
          {dialog.kind === 'role' ? (
            <div className="field">
              <label htmlFor={roleId}>Нова роль</label>
              <select id={roleId} value={dialog.role} disabled={pending} onChange={(e) => { setDialog({ ...dialog, role: e.target.value as Role }); }}>
                {KNOWN_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
          ) : null}
          <p>{dialog.kind === 'active' && dialog.isActive
            ? 'Користувач зможе знову увійти. Попередні сесії не відновлюються.'
            : 'Усі сесії користувача буде завершено одразу; йому потрібно буде увійти знову.'}</p>
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
        </Dialog>
      ) : null}
    </section>
  );
}
