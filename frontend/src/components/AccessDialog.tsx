import { type KeyboardEvent, type SyntheticEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { accessApi, ApiError } from '../api/client';
import type { AccessMode, ServerOption, ServiceOption, UserAccess, UserView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Dialog, FormDialog } from './Dialog';
import { formatRetry } from './StatusMessage';

// Resource grants of one operator/viewer (ADR-028). The editor loads the user's grants with their revision, edits a
// local draft and saves the WHOLE set at once (PUT with expectedRevision): a change made meanwhile by another admin
// is answered 409 and never overwritten. Nothing is shown as saved before the API answers. An admin has global access
// (no grants); that is said instead of an editor. All requests are bound to the session that started them.

export const SEARCH_DEBOUNCE_MS = 250;

interface DraftServer {
  serverId: string;
  serverName: string;
  serverActive: boolean;
  mode: AccessMode;
  services: string[];
  /** Granted earlier but no longer on the server (from the loaded grants). */
  unavailable: string[];
}

const toDraft = (a: UserAccess): DraftServer[] => a.servers.map((g) => ({
  serverId: g.serverId, serverName: g.serverName, serverActive: g.serverActive, mode: g.mode,
  services: g.services.map((s) => s.name).sort(), unavailable: g.services.filter((s) => !s.available).map((s) => s.name),
}));
const signature = (d: readonly DraftServer[]) => JSON.stringify(d.map((s) => [s.serverId, s.mode, s.mode === 'selected' ? [...s.services].sort() : []]).sort());

function accessError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Перезавантажте доступи й перевірте стан.';
  switch (error.kind) {
    case 'conflict': return 'Доступи цього користувача щойно змінив інший адміністратор (або змінилася його роль). Ваші зміни не збережено: перезавантажте й внесіть їх знову.';
    case 'not_found': return 'Користувача не знайдено. Оновіть список користувачів.';
    case 'invalid_request': return 'Сервер відхилив зміни: перевірте, що для «Вибраних сервісів» вибрано хоча б один сервіс і що сервер ще існує.';
    case 'forbidden': return 'Недостатньо прав для керування доступами.';
    case 'rate_limited': return `Забагато змін поспіль.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': return `Сервіс тимчасово недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'network': case 'timeout':
      return 'Відповідь не отримано — зміни могли зберегтися. Не повторюйте наосліп: перезавантажте доступи й перевірте.';
    default: return 'Неочікувана помилка. Перезавантажте доступи й перевірте стан.';
  }
}

const noEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.preventDefault(); };

/** Services of one server for a "selected" grant: searchable checkbox list (≤ 500 from the API), gone ones marked. */
function ServicePicker({ server, disabled, onChange }: { server: DraftServer; disabled: boolean; onChange: (services: string[]) => void }) {
  const { sessionExpired, bindSession } = useAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  type ListState = { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; items: ServiceOption[]; truncated: boolean };
  // Bound to the request it answers: another server/search shows "loading", never the previous answer.
  const [answer, setAnswer] = useState<{ key: string; state: ListState } | null>(null);
  const key = `${server.serverId}\n${query}`;
  const list: ListState = answer?.key === key ? answer.state : { status: 'loading' };
  const searchId = useId();
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); };
  }, [q]);
  useEffect(() => {
    const controller = new AbortController();
    const binding = bindSession();
    const k = `${server.serverId}\n${query}`;
    accessApi.services(server.serverId, query, controller.signal).then(
      (r) => { if (!controller.signal.aborted && binding.current()) setAnswer({ key: k, state: { status: 'ready', items: r.items, truncated: r.truncated } }); },
      (error: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        setAnswer({ key: k, state: { status: 'error', text: error instanceof ApiError && error.kind === 'not_found' ? 'Сервер більше не існує — приберіть його з доступів.' : 'Не вдалося завантажити сервіси. Спробуйте ще раз.' } });
      },
    );
    return () => { controller.abort(); };
  }, [server.serverId, query, bindSession, sessionExpired]);

  const chosen = new Set(server.services);
  const toggle = (name: string) => { onChange(chosen.has(name) ? server.services.filter((n) => n !== name) : [...server.services, name].sort()); };
  const listed = list.status === 'ready' ? new Set(list.items.map((i) => i.name)) : new Set<string>();
  // Granted names the current list does not show: gone from the server (unavailable) or outside the search.
  const others = server.services.filter((n) => !listed.has(n));

  return (
    <div className="access-picker">
      <div className="field">
        <label htmlFor={searchId}>Пошук сервісу</label>
        <input id={searchId} type="search" value={q} maxLength={128} disabled={disabled} autoComplete="off" spellCheck={false}
          onKeyDown={noEnter} onChange={(e) => { setQ(e.target.value); }} aria-controls={listId} />
      </div>
      <p className="hint" aria-live="polite">{`Вибрано: ${String(server.services.length)}`}</p>
      {list.status === 'loading' ? <p className="hint">Завантаження сервісів…</p> : null}
      {list.status === 'error' ? <p className="form-error" role="alert">{list.text}</p> : null}
      <ul id={listId} className="access-picker__list" aria-label={`Сервіси ${server.serverName}`}>
        {others.map((name) => (
          <li key={`g:${name}`}>
            <label className="check">
              <input type="checkbox" checked disabled={disabled} onChange={() => { toggle(name); }} />
              <span>{name}</span>
              {server.unavailable.includes(name) ? <span className="tag tag--warning">недоступний: зник із сервера</span> : null}
            </label>
          </li>
        ))}
        {list.status === 'ready' ? list.items.map((item) => (
          <li key={item.name}>
            <label className="check">
              <input type="checkbox" checked={chosen.has(item.name)} disabled={disabled} onChange={() => { toggle(item.name); }} />
              <span>{item.name}</span>
              {item.processes !== 1 ? <span className="hint">{item.processes === 0 ? 'не в inventory' : `${String(item.processes)} процеси з цим іменем`}</span> : null}
            </label>
          </li>
        )) : null}
      </ul>
      {list.status === 'ready' && list.items.length === 0 ? <p className="hint">{query ? 'Нічого не знайдено.' : 'На сервері ще немає відомих сервісів.'}</p> : null}
      {list.status === 'ready' && list.truncated ? <p className="hint">Показано перші 500 — уточніть пошук.</p> : null}
    </div>
  );
}

/** Server search for "Додати сервер": literal name search, servers already in the draft are not offered again. */
function ServerSearch({ taken, disabled, onAdd }: { taken: ReadonlySet<string>; disabled: boolean; onAdd: (s: ServerOption) => void }) {
  const { sessionExpired, bindSession } = useAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  type SearchState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: ServerOption[]; more: boolean };
  const [answer, setAnswer] = useState<{ key: string; state: SearchState } | null>(null);
  const result: SearchState = answer?.key === query ? answer.state : { status: 'loading' };
  const id = useId();
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); };
  }, [q]);
  useEffect(() => {
    const controller = new AbortController();
    const binding = bindSession();
    accessApi.servers(query, null, controller.signal).then(
      (r) => { if (!controller.signal.aborted && binding.current()) setAnswer({ key: query, state: { status: 'ready', items: r.items, more: r.nextAfterName !== null } }); },
      (error: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        setAnswer({ key: query, state: { status: 'error' } });
      },
    );
    return () => { controller.abort(); };
  }, [query, bindSession, sessionExpired]);
  const offered = result.status === 'ready' ? result.items.filter((s) => !taken.has(s.id)) : [];
  return (
    <div className="access-add">
      <div className="field">
        <label htmlFor={id}>Додати сервер</label>
        <input id={id} type="search" value={q} maxLength={100} disabled={disabled} placeholder="Назва сервера" autoComplete="off" spellCheck={false}
          onKeyDown={noEnter} onChange={(e) => { setQ(e.target.value); }} />
      </div>
      {result.status === 'loading' ? <p className="hint">Пошук…</p> : null}
      {result.status === 'error' ? <p className="form-error" role="alert">Не вдалося знайти сервери. Спробуйте ще раз.</p> : null}
      {result.status === 'ready' ? (
        offered.length === 0 ? <p className="hint">{query ? 'Нічого не знайдено.' : 'Усі знайдені сервери вже додано.'}</p> : (
          <ul className="access-add__list" aria-label="Знайдені сервери">
            {offered.map((s) => (
              <li key={s.id}>
                <span>{s.name}{s.isActive ? null : <span className="tag">неактивний</span>}</span>
                <button type="button" className="button button--small" disabled={disabled} aria-label={`Додати ${s.name}`} onClick={() => { onAdd(s); }}>Додати</button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {result.status === 'ready' && result.more ? <p className="hint">Показано перші 50 — уточніть пошук.</p> : null}
    </div>
  );
}

export function AccessDialog({ user, onClose, onSaved }: { user: UserView; onClose: () => void; onSaved: (access: UserAccess) => void }) {
  const { state: auth, sessionExpired, bindSession } = useAuth();
  type LoadState = { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; access: UserAccess };
  const [loaded, setLoaded] = useState<{ generation: number; state: LoadState } | null>(null);
  const [draft, setDraft] = useState<DraftServer[]>([]);
  const [base, setBase] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; reload: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const [generation, setGeneration] = useState(0);
  const inflight = useRef<AbortController | null>(null);
  // A reload ("Перезавантажити") shows loading at once; the draft is replaced only by the new answer.
  const load: LoadState = loaded?.generation === generation ? loaded.state : { status: 'loading' };

  useEffect(() => {
    const controller = new AbortController();
    const binding = bindSession();
    accessApi.get(user.id, controller.signal).then(
      (access) => {
        if (controller.signal.aborted || !binding.current()) return;
        const d = toDraft(access);
        setDraft(d); setBase(signature(d)); setError(null); setTouched(false);
        setLoaded({ generation, state: { status: 'ready', access } });
      },
      (e: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
        setLoaded({ generation, state: { status: 'error', text: accessError(e) } });
      },
    );
    return () => { controller.abort(); };
  }, [user.id, generation, bindSession, sessionExpired]);
  useEffect(() => () => { inflight.current?.abort(); }, []);

  const taken = useMemo(() => new Set(draft.map((s) => s.serverId)), [draft]);
  const update = useCallback((serverId: string, change: Partial<DraftServer>) => {
    setDraft((d) => d.map((s) => (s.serverId === serverId ? { ...s, ...change } : s)));
  }, []);

  const title = `Доступи: ${user.email}`;
  if (load.status !== 'ready') {
    return (
      <Dialog title={title} onClose={onClose} actions={(
        <>
          {load.status === 'error' ? <button type="button" className="button" onClick={() => { setGeneration((g) => g + 1); }}>Повторити</button> : null}
          <button type="button" className="button" onClick={onClose}>Закрити</button>
        </>
      )}>
        {load.status === 'loading' ? <p className="hint" role="status">Завантаження доступів…</p> : <p className="form-error" role="alert">{load.text}</p>}
      </Dialog>
    );
  }
  if (load.access.global) {
    return (
      <Dialog title={title} onClose={onClose} actions={<button type="button" className="button" onClick={onClose}>Закрити</button>}>
        <p><strong>Повний доступ</strong> до всіх серверів і сервісів, включно з майбутніми.</p>
        <p className="hint">Адміністратор не потребує окремих доступів. Щоб обмежити користувача, змініть його роль на «Оператор» або «Спостерігач» — після цього він не бачитиме нічого, доки ви не нададите доступи.</p>
      </Dialog>
    );
  }

  const empty = draft.filter((s) => s.mode === 'selected' && s.services.length === 0);
  const dirty = signature(draft) !== base;
  const csrfToken = auth.status === 'authenticated' ? auth.session.csrfToken : '';

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (pending || empty.length > 0 || !dirty) return;
    setPending(true);
    setError(null);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    try {
      const saved = await accessApi.save(user.id, {
        expectedRevision: load.access.revision,
        servers: draft.map((s) => ({ serverId: s.serverId, mode: s.mode, services: s.mode === 'selected' ? s.services : [] })),
      }, csrfToken, controller.signal);
      if (stale()) return;
      onSaved(saved);
    } catch (e) {
      if (stale()) return;
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      setError({ text: accessError(e), reload: e instanceof ApiError && ['conflict', 'network', 'timeout', 'unexpected', 'not_found'].includes(e.kind) });
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <FormDialog title={title} className="dialog--wide" submitLabel="Зберегти доступи" pendingLabel="Збереження…" pending={pending} dirty={dirty}
      onSubmit={(e) => { void onSubmit(e); }} onClose={onClose}>
      <p className="hint">
        {`Роль: ${user.role === 'operator' ? 'оператор — перегляд, керування процесами й логи' : 'спостерігач — лише перегляд'} у межах наданих серверів і сервісів. Без доступів користувач нічого не бачить.`}
        {user.isActive ? '' : ' Користувач зараз деактивований.'}
      </p>
      {error ? (
        <div className="form-error" role="alert">
          <p>{error.text}</p>
          {error.reload ? <button type="button" className="button button--small" disabled={pending} onClick={() => { setGeneration((g) => g + 1); }}>Перезавантажити доступи</button> : null}
        </div>
      ) : null}
      {draft.length === 0 ? <p className="notice">Доступів немає — користувач не бачить жодного сервера.</p> : null}
      <ul className="access-servers" aria-label="Надані сервери">
        {draft.map((s) => {
          const invalid = s.mode === 'selected' && s.services.length === 0;
          return (
            <li key={s.serverId} className="access-server">
              <div className="access-server__head">
                <strong>{s.serverName}</strong>
                {s.serverActive ? null : <span className="tag">неактивний</span>}
                <button type="button" className="button button--small button--danger" disabled={pending} aria-label={`Прибрати ${s.serverName}`}
                  onClick={() => { setDraft((d) => d.filter((x) => x.serverId !== s.serverId)); }}>Прибрати</button>
              </div>
              <fieldset className="access-server__mode" disabled={pending}>
                <legend className="visually-hidden">{`Обсяг доступу до ${s.serverName}`}</legend>
                <label className="check">
                  <input type="radio" name={`mode-${s.serverId}`} checked={s.mode === 'all'} onChange={() => { update(s.serverId, { mode: 'all' }); }} />
                  <span>Усі сервіси (поточні й майбутні)</span>
                </label>
                <label className="check">
                  <input type="radio" name={`mode-${s.serverId}`} checked={s.mode === 'selected'} onChange={() => { update(s.serverId, { mode: 'selected' }); }} />
                  <span>Вибрані сервіси</span>
                </label>
              </fieldset>
              {s.mode === 'selected' ? <ServicePicker server={s} disabled={pending} onChange={(services) => { update(s.serverId, { services }); }} /> : null}
              {invalid && touched ? <p className="field__error" role="alert">Виберіть хоча б один сервіс або приберіть сервер.</p> : null}
            </li>
          );
        })}
      </ul>
      <ServerSearch taken={taken} disabled={pending}
        onAdd={(o) => { setDraft((d) => [...d, { serverId: o.id, serverName: o.name, serverActive: o.isActive, mode: 'selected', services: [], unavailable: [] }]); }} />
      {touched && !dirty && !error ? <p className="hint" role="status">Змін немає.</p> : null}
    </FormDialog>
  );
}
