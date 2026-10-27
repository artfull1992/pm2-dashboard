import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { accessApi, ApiError } from '../api/client';
import type { ServerOption, ServiceOption } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { type DraftServer, nameMatches, SEARCH_DEBOUNCE_MS } from './accessDraft';
import { Dialog } from './Dialog';

// The two searches of the access page (ACL-03/05/06, ACL-14/15). Both use the existing API search, debounced; every
// answer is bound to the request it answers (server, query, page), so another server's or another query's answer is
// never shown, and a late answer after unmount or a session change is dropped. Searching only changes what is shown:
// the chosen services are the draft and stay chosen whatever the current result.

const noEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.preventDefault(); };

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(value); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); };
  }, [value]);
  return debounced;
}

const processesText = (n: number) => (n === 0 ? 'не в inventory' : n === 1 ? null : `${String(n)} процеси`);

/**
 * «Selected» services of one server: a searchable checklist (≤ 500 per answer), gone grants kept and marked.
 * `disabled` locks the choice (a save or a recovery read in flight) — the toggle itself refuses, not only the
 * checkbox; searching only changes what is shown and stays available.
 */
export function ServiceCatalog({ server, disabled, onChange }: { server: DraftServer; disabled: boolean; onChange: (services: string[]) => void }) {
  const { sessionExpired, bindSession } = useAuth();
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const [attempt, setAttempt] = useState(0);
  type ListState = { status: 'loading' } | { status: 'error'; gone: boolean } | { status: 'ready'; items: ServiceOption[]; truncated: boolean };
  const [answer, setAnswer] = useState<{ key: string; state: ListState } | null>(null);
  const key = `${server.serverId}\n${query}\n${String(attempt)}`;
  const list: ListState = answer?.key === key ? answer.state : { status: 'loading' };
  const ids = { search: useId(), list: useId(), count: useId() };

  useEffect(() => {
    const controller = new AbortController();
    const binding = bindSession();
    const k = `${server.serverId}\n${query}\n${String(attempt)}`;
    accessApi.services(server.serverId, query, controller.signal).then(
      (r) => { if (!controller.signal.aborted && binding.current()) setAnswer({ key: k, state: { status: 'ready', items: r.items, truncated: r.truncated } }); },
      (error: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        setAnswer({ key: k, state: { status: 'error', gone: error instanceof ApiError && error.kind === 'not_found' } });
      },
    );
    return () => { controller.abort(); };
  }, [server.serverId, query, attempt, bindSession, sessionExpired]);

  const chosen = new Set(server.services);
  const toggle = (name: string) => {
    if (disabled) return;
    onChange(chosen.has(name) ? server.services.filter((n) => n !== name) : [...server.services, name].sort());
  };
  const listed = list.status === 'ready' ? new Set(list.items.map((i) => i.name)) : new Set<string>();
  // Chosen or gone names this answer does not show (gone from the server, beyond the first 500, or not loaded yet) —
  // listed when they match the search, so they can be seen and removed explicitly.
  const extra = [...new Set([...server.services, ...server.unavailable])].filter((n) => !listed.has(n) && nameMatches(n, query)).sort();
  const outside = query.trim() === '' ? 0 : server.services.filter((n) => !nameMatches(n, query)).length;
  const gone = new Set(server.unavailable);

  const row = (name: string, meta: string | null, warn: boolean) => (
    <li key={name}>
      <label className="acl-service">
        <input type="checkbox" checked={chosen.has(name)} disabled={disabled} onChange={() => { toggle(name); }} />
        <span className="acl-service__name" title={name}>{name}</span>
        {meta ? <span className={warn ? 'tag tag--warning acl-service__meta' : 'acl-service__meta'}>{meta}</span> : null}
      </label>
    </li>
  );

  return (
    <div className="acl-catalog">
      <div className="acl-catalog__bar">
        <div className="field">
          <label htmlFor={ids.search}>Пошук сервісів цього сервера</label>
          <input id={ids.search} type="search" value={q} maxLength={128} autoComplete="off" spellCheck={false} placeholder="Назва сервісу"
            onKeyDown={noEnter} onChange={(e) => { setQ(e.target.value); }} aria-controls={ids.list} aria-describedby={ids.count} />
        </div>
        <p id={ids.count} className="acl-catalog__count" aria-live="polite">
          <span className="num">{`Вибрано: ${String(server.services.length)}`}</span>
          {outside > 0 ? <span className="hint">{`Ще ${String(outside)} вибраних поза пошуком — вибір збережено`}</span> : null}
        </p>
      </div>
      {list.status === 'loading' ? <p className="hint acl-catalog__state" role="status">Завантаження сервісів…</p> : null}
      {list.status === 'error' ? (
        <div className="notice notice--error acl-catalog__state" role="alert">
          <p className="notice__title">{list.gone ? 'Сервер більше не існує' : 'Не вдалося завантажити сервіси'}</p>
          <p className="notice__text">{list.gone ? 'Приберіть його з доступів.' : 'Вибрані сервіси збережено в чернетці. Спробуйте ще раз.'}</p>
          {list.gone ? null : <div><button type="button" className="button button--small" onClick={() => { setAttempt((a) => a + 1); }}>Повторити</button></div>}
        </div>
      ) : null}
      {list.status === 'ready' && list.items.length === 0 ? (
        <p className="hint acl-catalog__state" role="status">{query.trim()
          ? `Сервісів за запитом «${query.trim()}» не знайдено. Пошук не змінює вибір.`
          : 'На сервері ще немає відомих сервісів. «Усі сервіси» надасть доступ і до майбутніх.'}</p>
      ) : null}
      <ul id={ids.list} className="acl-catalog__list" aria-label={`Сервіси ${server.serverName}`}>
        {extra.map((name) => row(name, gone.has(name) ? 'зник із сервера' : list.status === 'ready' ? 'поза цим результатом' : null, gone.has(name)))}
        {list.status === 'ready' ? list.items.map((item) => row(item.name, processesText(item.processes), false)) : null}
      </ul>
      {list.status === 'ready' && list.truncated ? (
        <p className="hint acl-catalog__state" role="status">Показано перші 500 — це не повний каталог. Уточніть пошук, щоб знайти інші сервіси.</p>
      ) : null}
    </div>
  );
}

/** ACL-14/15: find a server to add (literal name search, pages of 50); servers already in the draft are not offered. */
export function AddServerDialog({ taken, onAdd, onClose }: { taken: ReadonlySet<string>; onAdd: (s: ServerOption) => void; onClose: () => void }) {
  const { sessionExpired, bindSession } = useAuth();
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const [attempt, setAttempt] = useState(0);
  type Result = { key: string; status: 'loading' | 'ready' | 'error'; items: ServerOption[]; next: string | null; more: 'idle' | 'loading' | 'error' };
  const [result, setResult] = useState<Result | null>(null);
  const key = `${query}\n${String(attempt)}`;
  const current: Result = result?.key === key ? result : { key, status: 'loading', items: [], next: null, more: 'idle' };
  const keyRef = useRef(key);
  const moreRef = useRef<AbortController | null>(null);
  const id = useId();

  useEffect(() => {
    keyRef.current = key;
    moreRef.current?.abort();
    const controller = new AbortController();
    const binding = bindSession();
    accessApi.servers(query, null, controller.signal).then(
      (r) => { if (!controller.signal.aborted && binding.current()) setResult({ key, status: 'ready', items: r.items, next: r.nextAfterName, more: 'idle' }); },
      (error: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        setResult({ key, status: 'error', items: [], next: null, more: 'idle' });
      },
    );
    return () => { controller.abort(); };
  }, [key, query, bindSession, sessionExpired]);
  useEffect(() => () => { moreRef.current?.abort(); }, []);

  /** The next page of the SAME query, appended; dropped if the query changed meanwhile. */
  const loadMore = () => {
    if (current.status !== 'ready' || current.next === null || current.more === 'loading') return;
    const base = current;
    const after = current.next;
    const controller = new AbortController();
    moreRef.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current() || keyRef.current !== base.key;
    setResult({ ...base, more: 'loading' });
    accessApi.servers(query, after, controller.signal).then(
      (r) => { if (!stale()) setResult({ ...base, items: [...base.items, ...r.items.filter((s) => !base.items.some((x) => x.id === s.id))], next: r.nextAfterName, more: 'idle' }); },
      (error: unknown) => {
        if (stale()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        setResult({ ...base, more: 'error' });
      },
    );
  };

  const offered = current.items.filter((s) => !taken.has(s.id));
  const text = query.trim();
  return (
    <Dialog title="Додати сервер" className="acl-add" onClose={onClose}
      headerAction={<button type="button" className="button button--ghost icon-button" aria-label="Закрити" onClick={onClose}>✕</button>}
      actions={<button type="button" className="button" onClick={onClose}>Скасувати</button>}>
      <div className="field">
        <label htmlFor={id}>Пошук серверів для призначення</label>
        <input id={id} type="search" value={q} maxLength={100} placeholder="Назва сервера" autoComplete="off" spellCheck={false}
          onKeyDown={noEnter} onChange={(e) => { setQ(e.target.value); }} />
      </div>
      {current.status === 'loading' ? <p className="hint" role="status">Пошук серверів…</p> : null}
      {current.status === 'error' ? (
        <div className="notice notice--error" role="alert">
          <p className="notice__text">Не вдалося знайти сервери.</p>
          <div><button type="button" className="button button--small" onClick={() => { setAttempt((a) => a + 1); }}>Повторити</button></div>
        </div>
      ) : null}
      {current.status === 'ready' && current.items.length === 0 ? (
        <p className="hint" role="status">{text ? `Серверів за запитом «${text}» не знайдено.` : 'Немає серверів, доступних для призначення.'}</p>
      ) : null}
      {current.status === 'ready' && current.items.length > 0 && offered.length === 0 ? (
        <p className="hint" role="status">{current.next ? 'Усі сервери на переглянутих сторінках уже додано — покажіть наступні.' : 'Усі знайдені сервери вже додано.'}</p>
      ) : null}
      {offered.length > 0 ? (
        <ul className="acl-add__list" aria-label="Знайдені сервери">
          {offered.map((s) => (
            <li key={s.id}>
              <button type="button" className="acl-add__option" aria-label={`Додати ${s.name}`} onClick={() => { onAdd(s); }}>
                <span className="acl-add__name" title={s.name}>{s.name}</span>
                {s.isActive ? null : <span className="tag">неактивний</span>}
                <span className="acl-add__hint">додати</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {current.status === 'ready' && current.next !== null ? (
        <div className="acl-add__more">
          {current.more === 'error' ? <p className="form-error" role="alert">Не вдалося завантажити наступні сервери.</p> : null}
          <button type="button" className="button button--small" disabled={current.more === 'loading'} onClick={loadMore}>
            {current.more === 'loading' ? 'Завантаження…' : 'Показати ще'}
          </button>
        </div>
      ) : null}
      <p className="hint">Новий сервер додається без вибраних сервісів. Повний доступ не надається автоматично; нічого не зберігається до «Зберегти».</p>
    </Dialog>
  );
}
