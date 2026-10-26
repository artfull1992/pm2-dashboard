import { type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, USERS_PAGE_SIZE, usersApi } from '../api/client';
import { KNOWN_ROLES, type Role, type UserView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { AccessDialog } from '../components/AccessDialog';
import { ActionMenu } from '../components/ActionMenu';
import { Dialog, FormDialog } from '../components/Dialog';
import { ROLE_LABELS } from '../components/Layout';
import { EmptyState, ErrorState, formatRetry } from '../components/StatusMessage';
import { StatusIndicator } from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { usePolledResource } from '../components/usePolledResource';
import { PASSWORD_MAX, PASSWORD_MIN, passwordLength } from './AccountPage';
import { formatDate } from './ServersPage';

// User administration (ADR-019; design USR-01…09, docs/design/part-02), users:manage only (the API enforces it
// independently). Keyset pages of 100 (cursor stack); search and role filter work only on the page in hand and say
// so. A row menu opens «Роль і активність» (one drawer, ONE PATCH with only the changed fields) or «Сервери та
// сервіси» (the existing access editor). Creating uses the existing contract {email, password, role}: new users are
// active. Every mutation is sent once (never retried), nothing is shown as done before the answer, an unknown result
// (network/timeout) is said as unknown and can be checked by re-reading the list. Own account: read-only details, no
// request. Mounted per session (Layout key), late answers after unmount or a session change are ignored.

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
      return 'Відповідь не отримано — дія могла виконатися. Не повторюйте наосліп: перечитайте стан користувача.';
    default: return 'Неочікувана помилка. Оновіть список і перевірте стан.';
  }
}
const unknownResult = (error: unknown) => error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout');

const ROLE_HINT: Record<Role, string> = {
  admin: 'Адміністратор: повний доступ до всіх серверів і сервісів без окремих призначень.',
  operator: 'Оператор: керування й логи лише дозволених сервісів.',
  viewer: 'Спостерігач: перегляд дозволених серверів і сервісів, без логів і команд.',
};
const accessText = (u: UserView) => (u.role === 'admin' ? 'Повний доступ' : 'За наданими доступами');
const activeText = (active: boolean) => (active ? 'Активний' : 'Неактивний');

function CreateUserForm({ onCreated, onClose }: { onCreated: (user: UserView) => void; onClose: () => void }) {
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
  const ids = { email: useId(), password: useId(), role: useId(), emailError: useId(), passwordError: useId(), roleHint: useId() };
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
      // The existing contract: {email, password, role} — no `isActive` (new users are active), no second request.
      const user = await usersApi.create({ email: email.trim(), password, role }, csrfToken, controller.signal);
      if (stale()) return; // left the page or the session: no callback, no reload
      setEmail(''); setPassword(''); setRole('viewer'); setVisible(false);
      latestOnCreated.current(user);
    } catch (error) {
      if (stale()) return;
      // The password is never kept after a failed attempt (it is re-entered on purpose); email and role stay.
      setPassword('');
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
      setFormError(userError(error, 'create'));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <FormDialog title="Створення користувача" eyebrow="Користувач" className="dialog--drawer" closeButton submitLabel="Створити" pendingLabel="Створення…" pending={pending}
      dirty={email !== '' || password !== '' || role !== 'viewer'} onSubmit={(e) => { void onSubmit(e); }} onClose={onClose}>
      {formError ? (
        <div className="notice notice--error" role="alert">
          <p className="notice__title">Не вдалося створити користувача</p>
          <p className="notice__text">{`${formError} Email і роль збережено у формі; пароль введіть знову.`}</p>
        </div>
      ) : null}
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
        {errors.password ? <p id={ids.passwordError} className="field__error">{errors.password}</p> : <p className="hint">{`Від ${String(PASSWORD_MIN)} до ${String(PASSWORD_MAX)} символів.`}</p>}
        <div><button type="button" className="button button--small" aria-pressed={visible} disabled={pending} onClick={() => { setVisible((v) => !v); }}>
          {visible ? 'Приховати пароль' : 'Показати пароль'}
        </button></div>
      </div>
      <div className="field">
        <label htmlFor={ids.role}>Роль</label>
        <select id={ids.role} value={role} disabled={pending} aria-describedby={ids.roleHint} onChange={(e) => { setRole(e.target.value as Role); }}>
          {KNOWN_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <p id={ids.roleHint} className="hint">{ROLE_HINT[role]}</p>
      </div>
      <div className="notice notice--info">
        <p className="notice__title">Новий користувач створюється активним</p>
        <p className="notice__text">Активність змінюється окремо — «Дії» → «Роль і активність». Доступи оператора чи спостерігача налаштуйте після створення («Сервери та сервіси»); адміністратор має повний доступ без призначень.</p>
      </div>
      <p className="hint">Початковий пароль передайте користувачеві захищеним каналом; після входу він змінює його на сторінці «Обліковий запис».</p>
    </FormDialog>
  );
}

/** «Роль і активність»: one form, one PATCH with only what changed; deactivation and role changes end sessions. */
function EditUserForm({ user, live, onSaved, onClose, onReread }: {
  user: UserView;
  /** The same user in the latest list answer (to check an unknown result); null when not on this page. */
  live: UserView | null;
  onSaved: (updated: UserView, change: { role?: Role; isActive?: boolean }) => void;
  onClose: () => void;
  onReread: () => void;
}) {
  const { state, sessionExpired, bindSession } = useAuth();
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.isActive);
  const [formError, setFormError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [pending, setPending] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const ids = { role: useId(), roleHint: useId(), active: useId(), activeHint: useId() };
  useEffect(() => () => { inflight.current?.abort(); }, []);
  if (state.status !== 'authenticated') return null;
  const { csrfToken } = state.session;
  const change: { role?: Role; isActive?: boolean } = { ...(role === user.role ? {} : { role }), ...(active === user.isActive ? {} : { isActive: active }) };
  const changed = change.role !== undefined || change.isActive !== undefined;

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !changed) return;
    setPending(true);
    setFormError(null);
    setUnknown(false);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    try {
      const updated = await usersApi.update(user.id, change, csrfToken, controller.signal);
      if (stale()) return;
      onSaved(updated, change);
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
      setUnknown(unknownResult(error));
      setFormError(userError(error, 'update'));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  const ends = (change.role !== undefined || change.isActive === false);
  return (
    <FormDialog title="Роль і активність" eyebrow="Користувач" className="dialog--drawer" closeButton submitLabel="Зберегти" pendingLabel="Збереження…" pending={pending}
      dirty={changed} submitDisabled={!changed} onSubmit={(e) => { void onSubmit(e); }} onClose={onClose}>
      {formError ? (
        <div className="notice notice--error" role="alert">
          <p className="notice__title">{unknown ? 'Результат невідомий' : 'Не вдалося зберегти'}</p>
          <p className="notice__text">{`${formError} Значення у формі збережено.`}</p>
          {unknown ? <div><button type="button" className="button button--small" onClick={onReread}>Перечитати стан</button></div> : null}
          {unknown && live ? <p className="notice__text">{`За останнім списком: ${ROLE_LABELS[live.role]}, ${activeText(live.isActive).toLowerCase()}.`}</p> : null}
        </div>
      ) : null}
      <div className="field">
        <span className="field__label">Email</span>
        <p className="users__readonly">{user.email}</p>
        <p className="hint">{`Створено ${formatDate(user.createdAt)}. Email тут не змінюється.`}</p>
      </div>
      <div className="field">
        <label htmlFor={ids.role}>Роль</label>
        <select id={ids.role} value={role} disabled={pending} aria-describedby={ids.roleHint} onChange={(e) => { setRole(e.target.value as Role); }}>
          {KNOWN_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <p id={ids.roleHint} className="hint">{ROLE_HINT[role]}</p>
      </div>
      <div className="field field--check">
        <label className="check" htmlFor={ids.active}>
          <input id={ids.active} type="checkbox" checked={active} disabled={pending} aria-describedby={ids.activeHint} onChange={(e) => { setActive(e.target.checked); }} />
          <span>Активний користувач</span>
        </label>
        <p id={ids.activeHint} className="hint">Неактивний обліковий запис не може увійти; доступи зберігаються, але не діють.</p>
      </div>
      {changed ? (
        <div className={`notice ${change.isActive === false ? 'notice--warning' : 'notice--info'}`} role="status">
          <p className="notice__title">{`Буде змінено для ${user.email}`}</p>
          <ul className="users__changes">
            {change.role !== undefined ? <li>{`Роль: ${ROLE_LABELS[user.role]} → ${ROLE_LABELS[change.role]}`}</li> : null}
            {change.isActive !== undefined ? <li>{change.isActive ? 'Активність: активувати — користувач зможе знову увійти; попередні сесії не відновлюються' : 'Активність: деактивувати — користувач не зможе увійти'}</li> : null}
          </ul>
          {ends ? <p className="notice__text">Усі сесії користувача буде завершено одразу після збереження.</p> : null}
        </div>
      ) : <p className="hint">Змін немає.</p>}
    </FormDialog>
  );
}

/** Own account: what applies, why it is read-only here; no form, no request. */
function OwnAccountDetails({ user, onClose }: { user: UserView; onClose: () => void }) {
  return (
    <Dialog title="Ваш обліковий запис" eyebrow="Користувач" className="dialog--drawer" onClose={onClose}
      headerAction={<button type="button" className="button button--ghost icon-button" aria-label="Закрити" onClick={onClose}>✕</button>}
      actions={<button type="button" className="button" onClick={onClose}>Закрити</button>}>
      <div className="notice notice--info">
        <p className="notice__title">Власну роль та активність змінює інший адміністратор</p>
        <p className="notice__text">{user.role === 'admin' ? 'Повний доступ адміністратора не редагується як список серверів.' : 'Доступи налаштовує адміністратор.'}</p>
      </div>
      <dl className="facts">
        <dt>Email</dt><dd>{user.email}</dd>
        <dt>Роль</dt><dd>{ROLE_LABELS[user.role]}<span className="cell-meta">{ROLE_HINT[user.role]}</span></dd>
        <dt>Активність</dt><dd>{activeText(user.isActive)}</dd>
        <dt>Створено</dt><dd>{formatDate(user.createdAt)}</dd>
      </dl>
    </Dialog>
  );
}

interface Status { text: string; find?: UserView }
interface Filters { q: string; role: Role | null }
const NO_FILTERS: Filters = { q: '', role: null };

/** Bound for "Показати": at most this many pages are walked to reach a newly created user (5 000 users). */
export const MAX_SEEK_PAGES = 50;
const RECORDS_QUERY = '(max-width: 760px)';

export function UsersPage() {
  const { state: auth, sessionExpired, bindSession } = useAuth();
  // Keyset pages: the cursor of each visited page (null = first). "Назад" pops, "Далі" pushes nextAfter. The resource
  // is keyed by the cursor, so another page's data is never shown and a late answer for a page we left is dropped.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback((signal: AbortSignal) => usersApi.list(cursor, signal), [cursor]);
  const { state, reload } = usePolledResource(load, `users:${cursor ?? 'first'}`);
  const [editing, setEditing] = useState<UserView | null>(null);
  const [own, setOwn] = useState<UserView | null>(null);
  const [seeking, setSeeking] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [creating, setCreating] = useState(false);
  const [accessFor, setAccessFor] = useState<UserView | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const records = useMediaQuery(RECORDS_QUERY);
  const closeAccess = useCallback(() => { setAccessFor(null); }, []);
  const closeCreate = useCallback(() => { setCreating(false); }, []);
  const closeEdit = useCallback(() => { setEditing(null); }, []);
  const closeOwn = useCallback(() => { setOwn(null); }, []);
  const inflight = useRef<AbortController | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const ids = { q: useId(), role: useId(), hint: useId() };
  useEffect(() => () => { inflight.current?.abort(); }, []);

  if (state.status === 'forbidden') return <Forbidden />;
  if (auth.status !== 'authenticated') return null;
  const me = auth.session.user.id;
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : null;
  const items = data?.items ?? [];
  const q = filters.q.trim().toLocaleLowerCase('uk-UA');
  const shown = items.filter((u) => (!filters.role || u.role === filters.role) && (q === '' || `${u.email} ${u.id}`.toLocaleLowerCase('uk-UA').includes(q)));
  const filtering = q !== '' || filters.role !== null;

  const busy = seeking;
  const go = (next: (string | null)[]) => { setStatus(null); setCursors(next); };

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
    const text = `Користувача ${user.email} створено (${ROLE_LABELS[user.role]}, активний).`;
    setStatus(here ? { text } : { text: `${text} Нові користувачі — наприкінці списку.`, find: user });
    setCreating(false);
    reload();
  };

  const onSaved = (updated: UserView, change: { role?: Role; isActive?: boolean }) => {
    setEditing(null);
    const parts = [
      change.role !== undefined ? `роль — «${ROLE_LABELS[updated.role]}»` : null,
      change.isActive !== undefined ? (updated.isActive ? 'знову активний (попередні сесії не відновлюються)' : 'деактивовано') : null,
    ].filter((x): x is string => x !== null);
    const sessionsEnded = change.role !== undefined || change.isActive === false;
    setStatus({ text: `${updated.email}: ${parts.join(', ')}.${sessionsEnded ? ' Усі його сесії завершено.' : ''}` });
    reload(); // the same page (same cursor)
  };

  const menu = (u: UserView) => (
    <ActionMenu name={u.email} items={u.id === me
      ? [{ key: 'role', label: 'Роль і активність', disabled: busy, onSelect: () => { setStatus(null); setOwn(u); } }]
      : [
        { key: 'role', label: 'Роль і активність', disabled: busy, onSelect: () => { setStatus(null); setEditing(u); } },
        { key: 'access', label: 'Сервери та сервіси', disabled: busy, onSelect: () => { setStatus(null); setAccessFor(u); } },
      ]} />
  );
  const email = (u: UserView) => (
    // One line with truncation; the full address shows on hover and on keyboard focus (and is the menu's name).
    <span className="users__email" tabIndex={0} title={u.email}>{u.email}</span>
  );

  return (
    <section className="page page--workspace users" aria-labelledby="users-title">
      <header className="page-header">
        <div className="page-header__main"><h1 id="users-title" className="page__title" ref={titleRef} tabIndex={-1}>Користувачі</h1></div>
        <div className="page-header__actions">
          <button type="button" className="button button--primary" onClick={() => { setStatus(null); setCreating(true); }}>Створити користувача</button>
        </div>
      </header>

      <div className="toolbar workspace-filters users__filters" role="group" aria-label="Пошук і фільтр на цій сторінці" aria-describedby={ids.hint}>
        <div className="field field--search">
          <label htmlFor={ids.q}>Пошук на цій сторінці</label>
          <input id={ids.q} type="search" value={filters.q} maxLength={254} autoComplete="off" spellCheck={false} placeholder="Email або ID"
            onChange={(e) => { setFilters({ ...filters, q: e.target.value }); }} />
        </div>
        <div className="field field--select">
          <label htmlFor={ids.role}>Роль</label>
          <select id={ids.role} value={filters.role ?? ''} onChange={(e) => { setFilters({ ...filters, role: (e.target.value || null) as Role | null }); }}>
            <option value="">Усі ролі</option>
            {KNOWN_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        {filtering ? <button type="button" className="button toolbar__reset" onClick={() => { setFilters(NO_FILTERS); }}>Скинути</button> : null}
      </div>
      <p id={ids.hint} className="hint workpanel__hint">{`Пошук і фільтр діють лише серед користувачів поточної сторінки (до ${String(USERS_PAGE_SIZE)}).`}</p>

      {status ? (
        <div className="notice status-bar" role="status">
          <span>{status.text}</span>
          {status.find ? (
            <button type="button" className="button button--small" disabled={busy} aria-label={`Показати ${status.find.email}`}
              onClick={() => { if (status.find) void seek(status.find); }}>{seeking ? 'Пошук…' : 'Показати'}</button>
          ) : null}
        </div>
      ) : null}

      <div className="incidents-card users-card">
        <div className="app-list__caption">
          <span className="num">{data ? `На цій сторінці: ${String(items.length)}${filtering ? ` · знайдено: ${String(shown.length)}` : ''}` : state.status === 'loading' ? 'Завантаження…' : 'Список недоступний'}</span>
        </div>
        {state.status === 'loading' ? <UsersSkeleton /> : null}
        {state.status === 'error' ? (
          <ErrorState title={data ? 'Не вдалося оновити список' : 'Не вдалося завантажити користувачів'} onRetry={reload}>
            {`Сервіс тимчасово недоступний.${formatRetry(state.retryAfterSeconds)}${data ? ' Показано попередні дані.' : ''}`}
          </ErrorState>
        ) : null}
        {data && items.length === 0 ? <EmptyState title="Користувачів ще немає" /> : null}
        {data && items.length > 0 && shown.length === 0 ? (
          <div className="state state--empty">
            <h2 className="state__title">На цій сторінці збігів немає</h2>
            <p className="state__text">{`Пошук і фільтр діють лише на поточну сторінку.${data.nextAfter ? ' На наступних сторінках можуть бути збіги — «Далі».' : ''}`}</p>
            <button type="button" className="button" onClick={() => { setFilters(NO_FILTERS); }}>Скинути фільтри</button>
          </div>
        ) : null}
        {shown.length > 0 ? (records ? (
          <ul className="users-records workpanel__rows" aria-label="Користувачі системи">
            {shown.map((u) => (
              <li key={u.id}>
                <article className="users-record" aria-label={u.email}>
                  <p className="users-record__email">{email(u)}</p>
                  <p className="users-record__line"><span>{`${ROLE_LABELS[u.role]}${u.id === me ? ' · Ви' : ''}`}</span><StatusIndicator tone={u.isActive ? 'ok' : 'muted'}>{activeText(u.isActive)}</StatusIndicator></p>
                  <p className="users-record__line"><span className="secondary">{accessText(u)}</span>{menu(u)}</p>
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <div className="workpanel__rows users__scroll">
            <table className="table table--dense users-table">
              <caption className="visually-hidden">Користувачі системи</caption>
              <thead><tr><th scope="col">Email</th><th scope="col">Роль</th><th scope="col">Доступ</th><th scope="col">Активність</th><th scope="col"><span className="visually-hidden">Дії</span></th></tr></thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id}>
                    <th scope="row">{email(u)}{u.id === me ? <span className="cell-meta">Ви</span> : null}</th>
                    <td>{ROLE_LABELS[u.role]}</td>
                    <td>{accessText(u)}</td>
                    <td><StatusIndicator tone={u.isActive ? 'ok' : 'muted'}>{activeText(u.isActive)}</StatusIndicator></td>
                    <td className="users-table__actions">{menu(u)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )) : null}
        <nav className="pager incidents__pager" aria-label="Сторінки користувачів">
          <span className="pager__page" aria-live="polite">{`Сторінка ${String(cursors.length)}`}</span>
          <button type="button" className="button button--small" disabled={busy || cursors.length === 1} onClick={() => { go(cursors.slice(0, -1)); }}>Назад</button>
          <button type="button" className="button button--small" disabled={busy || state.status !== 'ready' || !data?.nextAfter}
            onClick={() => { if (data?.nextAfter) go([...cursors, data.nextAfter]); }}>Далі</button>
        </nav>
      </div>
      <p className="hint">Власну роль і активність змінює інший адміністратор. Дата створення — у вікні «Роль і активність».</p>

      {creating ? <CreateUserForm onCreated={onCreated} onClose={closeCreate} /> : null}
      {editing ? (
        <EditUserForm key={editing.id} user={editing} live={items.find((u) => u.id === editing.id) ?? null} onSaved={onSaved} onClose={closeEdit} onReread={reload} />
      ) : null}
      {own ? <OwnAccountDetails user={own} onClose={closeOwn} /> : null}
      {accessFor ? (
        <AccessDialog key={accessFor.id} user={accessFor} onClose={closeAccess} onSaved={(a) => {
          setAccessFor(null);
          setStatus({ text: a.servers.length === 0
            ? `Доступи ${a.email} прибрано: користувач не бачить жодного сервера.`
            : `Доступи ${a.email} збережено: серверів — ${String(a.servers.length)}. Зміни діють з наступного запиту користувача.` });
        }} />
      ) : null}
    </section>
  );
}

/** USR-09: compact placeholder rows with an announced loading state (no user is invented). */
function UsersSkeleton() {
  return (
    <div className="workpanel__rows users__scroll">
      <p role="status" className="visually-hidden">Завантаження користувачів…</p>
      <table className="table table--dense users-table" aria-hidden="true">
        <tbody>
          {Array.from({ length: 6 }, (_, i) => (
            <tr key={i}>{Array.from({ length: 5 }, (__, j) => <td key={j}><span className="skeleton users__skeleton" /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
