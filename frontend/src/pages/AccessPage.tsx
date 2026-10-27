import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type BlockerFunction, Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { accessApi, ApiError, isUuid } from '../api/client';
import type { Role, ServerOption, UserAccess } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { AddServerDialog, ServiceCatalog } from '../components/AccessPickers';
import { accessError, type DraftServer, emptySelections, payload, rebase, recoveryOutcome, scopeText, signature, toDraft, unknownResult } from '../components/accessDraft';
import { Dialog } from '../components/Dialog';
import { ROLE_LABELS } from '../components/Layout';
import { LoadingState } from '../components/StatusMessage';
import { usersViewFrom } from './usersView';

// Access of one operator/viewer on its own page (ACL-01…15, ADR-028, ADR-035): /users/:id/access, users:manage only
// (the API enforces it independently). The page loads the user's grants with their revision (a direct URL needs
// nothing else), edits a local draft — servers with independent «all»/«selected» scopes — and saves the WHOLE set with
// one PUT carrying the revision it was based on: a change made meanwhile is answered 409 and never overwritten, and
// the revision is never refreshed behind the user's back. Nothing is shown as saved before the answer; a lost answer
// is «unknown» and is checked by an explicit GET. Leaving with unsaved changes (links, «Скасувати», Back/Forward) asks
// first; reloading or closing the tab triggers the browser's own warning. Requests are bound to the session and the
// user id (the page is keyed by it); late answers are dropped. While a save or a recovery read is in flight the draft
// is locked: every handler that changes it refuses, and a read answer is never applied over a draft that changed.

const ROLE_SCOPE: Record<Role, string> = {
  admin: 'Повний доступ до всіх серверів і сервісів',
  operator: 'Керування та логи в межах доступів',
  viewer: 'Перегляд без логів і керування',
};
const ROLE_NOTE: Record<Role, string> = {
  admin: '',
  operator: 'Оператор керує процесами й читає логи лише в межах наданих сервісів. Обсяг доступу не змінює роль.',
  viewer: 'Спостерігач лише переглядає надані сервіси — навіть за «Усі сервіси» без логів і команд. Обсяг доступу не змінює роль.',
};

type Load = { status: 'loading' } | { status: 'error'; text: string } | { status: 'forbidden' } | { status: 'not_found'; invalid: boolean } | { status: 'ready' };
/** The outcome of the last save that did not succeed. «conflict» and «unknown» block saving until checked. */
type Issue = { kind: 'refused'; text: string } | { kind: 'conflict' } | { kind: 'unknown' };
/**
 * The stored state read on request (after a conflict or a lost answer), shown beside the draft. `drifted`: the draft
 * changed during the read, so nothing was applied automatically.
 */
type Remote = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; text: string } | { kind: 'ready'; access: UserAccess; drifted: boolean };
type Confirm = { kind: 'remove'; server: DraftServer } | { kind: 'discard'; remote: UserAccess } | null;

/** One page instance per user id: another id never shows the previous user's draft or answers. */
export function AccessRoute() {
  const { id = '' } = useParams();
  return <AccessPage key={id} userId={id} />;
}

function AccessPage({ userId }: { userId: string }) {
  const { state: auth, sessionExpired, bindSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const from = useMemo(() => usersViewFrom(location.state), [location.state]);
  const backState = from ? { restore: from } : null;
  const valid = isUuid(userId);
  const [load, setLoad] = useState<Load>(valid ? { status: 'loading' } : { status: 'not_found', invalid: true });
  const [generation, setGeneration] = useState(0);
  const [access, setAccess] = useState<UserAccess | null>(null);
  const [draft, setDraft] = useState<DraftServer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [remote, setRemote] = useState<Remote>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const inflight = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  // The draft as last rendered: a read answer is checked against it, not against the draft its request started with.
  const draftNow = useRef<DraftServer[]>([]);
  const editorTitle = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // After adding or removing a server: focus the editor of the selected one (or «Додати сервер») once it is rendered.
  const focusNext = useRef(false);
  const ids = { title: useId(), servers: useId(), editor: useId() };

  /** Take a stored state as the baseline and the draft (keeps the selected server when it is still there). */
  const adopt = useCallback((a: UserAccess) => {
    const d = toDraft(a);
    setAccess(a);
    setDraft(d);
    setSelected((cur) => (cur !== null && d.some((s) => s.serverId === cur) ? cur : d[0]?.serverId ?? null));
  }, []);

  useEffect(() => {
    if (!valid) return undefined;
    const controller = new AbortController();
    const binding = bindSession();
    accessApi.get(userId, controller.signal).then(
      (a) => {
        if (controller.signal.aborted || !binding.current()) return;
        adopt(a);
        setLoad({ status: 'ready' });
      },
      (error: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error instanceof ApiError && error.kind === 'forbidden') { setLoad({ status: 'forbidden' }); return; }
        if (error instanceof ApiError && (error.kind === 'not_found' || error.kind === 'invalid_request')) { setLoad({ status: 'not_found', invalid: false }); return; }
        setLoad({ status: 'error', text: accessError(error) });
      },
    );
    return () => { controller.abort(); };
  }, [valid, userId, generation, adopt, bindSession, sessionExpired]);
  useEffect(() => () => { inflight.current?.abort(); reading.current?.abort(); }, []);
  useEffect(() => { draftNow.current = draft; }, [draft]);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    (editorTitle.current ?? addButton.current)?.focus();
  });

  const ready = load.status === 'ready' && access !== null;
  const baseSig = useMemo(() => (access ? signature(toDraft(access)) : ''), [access]);
  const dirty = ready && signature(draft) !== baseSig;
  const empty = emptySelections(draft);
  const blocked = issue?.kind === 'conflict' || issue?.kind === 'unknown';
  const checking = remote.kind === 'checking';
  // A save or a recovery read in flight: the draft cannot change (ADR-035). Rendering disables the controls; the
  // handlers check the requests themselves (`busy`), so no other path can change the draft meanwhile.
  const locked = pending || checking;
  const busy = () => inflight.current !== null || reading.current !== null;
  const canSave = ready && !access.global && dirty && empty.length === 0 && !locked && !blocked;
  // Leaving loses the draft (dirty) or stops waiting for a save in flight (pending): ask first.
  const guard = dirty || pending;
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => guard && currentLocation.pathname !== nextLocation.pathname, [guard]);
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (!guard) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [guard]);

  const edit = (serverId: string, change: Partial<DraftServer>) => {
    if (busy()) return;
    setNotice(null);
    setDraft((d) => d.map((s) => (s.serverId === serverId ? { ...s, ...change } : s)));
  };
  const openAdd = () => { if (!busy()) setAdding(true); };
  const addServer = (o: ServerOption) => {
    setAdding(false);
    if (busy()) return;
    setNotice(null);
    // Into the draft only: «selected» with nothing chosen — never «all» by default.
    setDraft((d) => (d.some((s) => s.serverId === o.id) ? d : [...d, { serverId: o.id, serverName: o.name, serverActive: o.isActive, mode: 'selected', services: [], unavailable: [] }]));
    setSelected(o.id);
    focusNext.current = true;
  };
  const askRemove = (s: DraftServer) => { if (!busy()) setConfirm({ kind: 'remove', server: s }); };
  const removeServer = (s: DraftServer) => {
    setConfirm(null);
    if (busy()) return;
    const i = draft.findIndex((x) => x.serverId === s.serverId);
    const rest = draft.filter((x) => x.serverId !== s.serverId);
    setNotice(null);
    setDraft(rest);
    setSelected(rest[i]?.serverId ?? rest[i - 1]?.serverId ?? null);
    focusNext.current = true;
  };
  const leave = () => { void navigate('/users', { state: backState }); };

  const save = async () => {
    if (!canSave || busy() || auth.status !== 'authenticated') return;
    const { csrfToken } = auth.session;
    setPending(true);
    setIssue(null);
    setRemote({ kind: 'idle' });
    setNotice(null);
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    try {
      const saved = await accessApi.save(userId, { expectedRevision: access.revision, servers: payload(draft) }, csrfToken, controller.signal);
      if (stale()) return;
      adopt(saved); // the answer is the new baseline and revision
      setNotice(saved.servers.length === 0
        ? `Доступи прибрано (ревізія ${String(saved.revision)}): користувач не бачить жодного сервера.`
        : `Доступи збережено (ревізія ${String(saved.revision)}). Зміни діють з наступного запиту користувача.`);
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError) {
        if (error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error.kind === 'forbidden') { setLoad({ status: 'forbidden' }); return; }
        if (error.kind === 'not_found') { setLoad({ status: 'not_found', invalid: false }); return; }
        if (error.kind === 'conflict') { setIssue({ kind: 'conflict' }); return; }
      }
      setIssue(unknownResult(error) ? { kind: 'unknown' } : { kind: 'refused', text: accessError(error) });
    } finally {
      if (inflight.current === controller) inflight.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  /**
   * GET only, on request: what is stored now. Never a hidden save; the draft stays until the user decides. The draft
   * is locked while the read runs (one read at a time, never during a save), and the answer is judged against the
   * draft it checked: if the draft changed anyway, it is only shown for an explicit choice.
   */
  const readRemote = async () => {
    if (busy() || !access) return;
    const base = access;
    const controller = new AbortController();
    reading.current = controller;
    const binding = bindSession();
    const stale = () => controller.signal.aborted || !binding.current();
    const lost = issue?.kind === 'unknown';
    const checked = signature(draft);
    setAdding(false);
    setConfirm(null);
    setRemote({ kind: 'checking' });
    try {
      const a = await accessApi.get(userId, controller.signal);
      if (stale()) return;
      const outcome = recoveryOutcome({ checked, current: signature(draftNow.current), remote: a, base, lost });
      if (outcome === 'admin') {
        adopt(a); setIssue(null); setRemote({ kind: 'idle' });
        setNotice('Користувач тепер адміністратор: окремі доступи не застосовуються, чернетку не збережено.');
        return;
      }
      if (outcome === 'matches') {
        adopt(a); setIssue(null); setRemote({ kind: 'idle' });
        setNotice(`Перевірено: збережені доступи (ревізія ${String(a.revision)}) збігаються з вашою чернеткою. Чи зберегла їх саме ця спроба, перевірка не показує.`);
        return;
      }
      if (outcome === 'unchanged') {
        setAccess(a); setIssue(null); setRemote({ kind: 'idle' });
        setNotice(`Перевірено: збережені доступи не змінилися (ревізія ${String(a.revision)}) — на момент перевірки зміни не застосовано. Чернетка лишилася; її можна зберегти знову.`);
        return;
      }
      setRemote({ kind: 'ready', access: a, drifted: outcome === 'drifted' });
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
      if (error instanceof ApiError && error.kind === 'forbidden') { setLoad({ status: 'forbidden' }); return; }
      if (error instanceof ApiError && error.kind === 'not_found') { setLoad({ status: 'not_found', invalid: false }); return; }
      setRemote({ kind: 'error', text: accessError(error) });
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  };
  const discardFor = (a: UserAccess) => {
    setConfirm(null);
    if (busy()) return;
    adopt(a); setIssue(null); setRemote({ kind: 'idle' });
    setNotice(`Показано актуальний збережений стан (ревізія ${String(a.revision)}); чернетку відкинуто.`);
  };
  const keepDraftOn = (a: UserAccess) => {
    if (busy()) return;
    setAccess(a); setDraft((d) => rebase(d, a)); setIssue(null); setRemote({ kind: 'idle' });
    setNotice(`Чернетку перенесено на актуальну ревізію ${String(a.revision)}. Після «Зберегти» вона повністю замінить збережений стан — перегляньте її перед збереженням.`);
  };

  if (load.status === 'forbidden') return <Forbidden />;
  if (load.status === 'not_found') {
    return (
      <section className="page acl" aria-labelledby={ids.title}>
        <header className="acl__header">
          <h1 id={ids.title} className="page__title">Користувача не знайдено</h1>
          <nav className="page-header__crumbs" aria-label="Навігаційний ланцюжок"><Link to="/users" state={backState}>← Користувачі</Link></nav>
        </header>
        <p className="page__lead">{load.invalid ? 'Посилання на доступи некоректне.' : 'Можливо, його видалено. Зберігати тут нічого.'}</p>
      </section>
    );
  }

  const current = draft.find((s) => s.serverId === selected) ?? null;
  const statusText = !ready ? 'Дані не завантажено'
    : pending ? 'Збереження…'
      : checking ? 'Перевірка збереженого стану… Чернетку не можна змінювати до відповіді'
      : issue?.kind === 'unknown' ? 'Результат невідомий — спершу перевірте збережений стан'
        : issue?.kind === 'conflict' ? 'Чернетка базується на застарілій версії — перегляньте актуальний стан'
          : !dirty ? 'Змін немає'
            : empty.length > 0 ? `Є незбережені зміни · ${empty.map((s) => s.serverName).join(', ')}: виберіть сервіси або приберіть сервер`
              : 'Є незбережені зміни';
  const footer = (
    <div className="acl__footer" role="group" aria-label="Збереження доступів">
      <p className={`acl__state${dirty || locked ? ' acl__state--active' : ''}`} role="status">{statusText}</p>
      <div className="acl__actions">
        <button type="button" className="button" onClick={leave}>Скасувати</button>
        <button type="button" className="button button--primary" disabled={!canSave} onClick={() => { void save(); }}>{pending ? 'Збереження…' : 'Зберегти'}</button>
      </div>
    </div>
  );

  return (
    <section className="page page--workspace acl" aria-labelledby={ids.title}>
      <header className="acl__header">
        <h1 id={ids.title} className="page__title">Доступи користувача</h1>
        <nav className="page-header__crumbs" aria-label="Навігаційний ланцюжок"><Link to="/users" state={backState}>← Користувачі</Link></nav>
        {access ? (
          <p className="acl__who">
            <strong className="acl__email">{access.email}</strong>
            <span className="acl__role">{ROLE_LABELS[access.role]}</span>
            <span className="acl__scope">{ROLE_SCOPE[access.role]}</span>
            {access.isActive ? null : <span className="tag tag--warning">неактивний</span>}
          </p>
        ) : null}
      </header>

      {load.status === 'loading' ? <div className="acl__placeholder"><LoadingState label="Завантаження доступів…" /></div> : null}
      {load.status === 'error' ? (
        <div className="acl__placeholder">
          <div className="state state--error acl__state-card" role="alert">
            <h2 className="state__title">Не вдалося отримати доступи</h2>
            <p className="state__text">{`${load.text} Це помилка завантаження, а не відсутність доступів. Збереження недоступне.`}</p>
            <button type="button" className="button" onClick={() => { setLoad({ status: 'loading' }); setGeneration((g) => g + 1); }}>Повторити запит</button>
          </div>
        </div>
      ) : null}

      {ready && access.global ? (
        <div className="panel acl__global">
          {notice ? <p className="notice notice--info" role="status">{notice}</p> : null}
          <h2 className="section__title">Повний доступ</h2>
          <p>Адміністратор має доступ до всіх серверів і сервісів, включно з майбутніми. Окремі доступи його не обмежують, тож тут нічого зберігати.</p>
          <p className="hint">Щоб обмежити користувача, змініть роль на «Оператор» або «Спостерігач» («Роль і активність» у списку користувачів) — після цього він не бачитиме нічого, доки ви не нададите доступи.</p>
          <div><Link className="button" to="/users" state={backState}>До користувачів</Link></div>
        </div>
      ) : null}

      {ready && !access.global ? (
        <>
          {access.isActive ? null : (
            <div className="notice notice--warning">
              <p className="notice__title">Користувач деактивований</p>
              <p className="notice__text">Доступи нижче збережено, але скористатися ними він не зможе, доки його не активують («Роль і активність»).</p>
            </div>
          )}
          {notice ? <div className="notice notice--info" role="status"><p className="notice__text">{notice}</p></div> : null}
          {issue?.kind === 'refused' ? (
            <div className="notice notice--error" role="alert">
              <p className="notice__title">Не вдалося зберегти доступи</p>
              <p className="notice__text">{`${issue.text} Ваші зміни залишилися в редакторі.`}</p>
            </div>
          ) : null}
          {issue?.kind === 'conflict' ? (
            <div className="notice notice--error" role="alert">
              <p className="notice__title">Доступи змінилися після відкриття сторінки</p>
              <p className="notice__text">Інший адміністратор змінив доступи або роль цього користувача. Ваші зміни не збережено й нічого не перезаписано; чернетка лишилася в редакторі.</p>
              <div><button type="button" className="button button--small" disabled={checking} onClick={() => { void readRemote(); }}>
                {checking ? 'Читання…' : 'Переглянути актуальний стан'}
              </button></div>
            </div>
          ) : null}
          {issue?.kind === 'unknown' ? (
            <div className="notice notice--warning" role="alert">
              <p className="notice__title">Результат невідомий</p>
              <p className="notice__text">Відповідь сервера не отримано — доступи могли зберегтися. Не зберігайте повторно наосліп: спершу перевірте збережений стан. Чернетка лишилася в редакторі.</p>
              <div><button type="button" className="button button--small" disabled={checking} onClick={() => { void readRemote(); }}>
                {checking ? 'Перевірка…' : 'Перевірити збережений стан'}
              </button></div>
            </div>
          ) : null}
          {blocked && remote.kind === 'error' ? (
            <div className="notice notice--error" role="alert">
              <p className="notice__text">{`Не вдалося прочитати збережений стан. ${remote.text} ${issue.kind === 'unknown' ? 'Результат збереження лишається невідомим.' : 'Конфлікт не розв’язано.'} Спробуйте ще раз.`}</p>
            </div>
          ) : null}
          {blocked && remote.kind === 'ready' ? (
            <RemoteState remote={remote.access} before={access} drifted={remote.drifted} onDiscard={() => { setConfirm({ kind: 'discard', remote: remote.access }); }} onKeep={() => { keepDraftOn(remote.access); }} />
          ) : null}

          {draft.length === 0 ? (
            <div className="acl__placeholder">
              <div className="state state--empty acl__state-card">
                <h2 className="state__title">Доступів немає</h2>
                <p className="state__text">{baseSig === signature([])
                  ? 'Користувач не бачить жодного сервера. Додайте сервер, потім оберіть усі або конкретні сервіси.'
                  : 'У чернетці не лишилося серверів. Після «Зберегти» всі доступи користувача буде відкликано; доти вони діють.'}</p>
                <button ref={addButton} type="button" className="button" disabled={locked} onClick={openAdd}>Додати сервер</button>
              </div>
            </div>
          ) : (
            <div className="acl__workspace">
              <section className="acl-servers" aria-labelledby={ids.servers}>
                <div className="acl-servers__head">
                  <h2 id={ids.servers} className="acl-servers__title">Сервери користувача</h2>
                  <button ref={addButton} type="button" className="button" disabled={locked} onClick={openAdd}>+ Додати сервер</button>
                </div>
                <ul className="acl-servers__list">
                  {draft.map((s) => {
                    const invalid = s.mode === 'selected' && s.services.length === 0;
                    return (
                      <li key={s.serverId}>
                        <button type="button" className="acl-server" aria-current={s.serverId === selected ? 'true' : undefined}
                          aria-label={`${s.serverName}: ${scopeText(s)}${s.serverActive ? '' : ', неактивний'}`} onClick={() => { setSelected(s.serverId); }}>
                          <span className="acl-server__name" title={s.serverName}>{s.serverName}</span>
                          <span className={`acl-server__scope${invalid ? ' acl-server__scope--warn' : ''}`}>{`${scopeText(s)}${s.serverActive ? '' : ' · неактивний'}`}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
              {current ? (
                <section key={current.serverId} className="acl-editor" aria-labelledby={ids.editor}>
                  <div className="acl-editor__head">
                    <h2 id={ids.editor} ref={editorTitle} tabIndex={-1} className="acl-editor__title">
                      {current.serverName}{current.serverActive ? null : <span className="tag">неактивний</span>}
                    </h2>
                    <button type="button" className="button" disabled={locked} aria-label={`Прибрати доступ до ${current.serverName}`}
                      onClick={() => { askRemove(current); }}>Прибрати доступ</button>
                  </div>
                  <div className="acl-editor__body">
                    <fieldset className="acl-modes" disabled={locked}>
                      <legend className="acl-modes__legend">Які сервіси доступні</legend>
                      <label className="acl-mode">
                        <input type="radio" name={`mode-${current.serverId}`} checked={current.mode === 'all'} onChange={() => { edit(current.serverId, { mode: 'all' }); }} />
                        <span className="acl-mode__text">
                          <span className="acl-mode__title">Усі сервіси — поточні й майбутні</span>
                          <span className="acl-mode__desc">Нові сервіси цього сервера також будуть доступні.</span>
                        </span>
                      </label>
                      <label className="acl-mode">
                        <input type="radio" name={`mode-${current.serverId}`} checked={current.mode === 'selected'} onChange={() => { edit(current.serverId, { mode: 'selected' }); }} />
                        <span className="acl-mode__text">
                          <span className="acl-mode__title">Вибрані сервіси</span>
                          <span className="acl-mode__desc">Доступ лише до явно вибраних сервісів; нові сервіси доступу не отримують.</span>
                        </span>
                      </label>
                    </fieldset>
                    {current.mode === 'all' ? (
                      <div className="notice notice--info">
                        <p className="notice__title">Доступ до всіх сервісів сервера</p>
                        <p className="notice__text">{`Пошук і вибір окремих сервісів не потрібні.${current.services.length > 0 ? ` Попередній вибір (${String(current.services.length)}) лишається в чернетці й повернеться, якщо знову вибрати «Вибрані сервіси».` : ''} Зміни набудуть чинності після збереження.`}</p>
                      </div>
                    ) : (
                      <>
                        {current.services.length === 0 ? (
                          <p className="field__error">Виберіть хоча б один сервіс або приберіть сервер. Порожній вибір не зберігається й не означає «усі».</p>
                        ) : null}
                        <ServiceCatalog server={current} disabled={locked} onChange={(services) => { edit(current.serverId, { services }); }} />
                      </>
                    )}
                    <p className="hint">{ROLE_NOTE[access.role]}</p>
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </>
      ) : null}

      {ready && access.global ? null : footer}

      {adding ? <AddServerDialog taken={new Set(draft.map((s) => s.serverId))} onAdd={addServer} onClose={() => { setAdding(false); }} /> : null}
      {confirm?.kind === 'remove' ? (
        <Dialog title="Прибрати доступ до сервера?" onClose={() => { setConfirm(null); }} fallbackFocus={() => editorTitle.current ?? addButton.current}
          actions={(
            <>
              <button type="button" className="button" onClick={() => { setConfirm(null); }}>Продовжити редагування</button>
              <button type="button" className="button button--danger" onClick={() => { removeServer(confirm.server); }}>Прибрати з чернетки</button>
            </>
          )}>
          <p>{`Доступ до ${confirm.server.serverName} буде прибрано з чернетки. Реальний доступ зміниться лише після «Зберегти».`}</p>
        </Dialog>
      ) : null}
      {confirm?.kind === 'discard' ? (
        <Dialog title="Відкинути чернетку?" onClose={() => { setConfirm(null); }} fallbackFocus={() => editorTitle.current ?? addButton.current}
          actions={(
            <>
              <button type="button" className="button" onClick={() => { setConfirm(null); }}>Продовжити редагування</button>
              <button type="button" className="button button--danger" onClick={() => { discardFor(confirm.remote); }}>Відкинути чернетку</button>
            </>
          )}>
          <p>{`Незбережені зміни буде втрачено; на сторінці буде актуальний збережений стан (ревізія ${String(confirm.remote.revision)}). Збережені доступи не зміняться.`}</p>
        </Dialog>
      ) : null}
      {blocker.state === 'blocked' ? (
        <Dialog title={pending ? 'Збереження ще триває' : 'Скасувати зміни?'} onClose={() => { blocker.reset(); }}
          actions={(
            <>
              <button type="button" className="button" onClick={() => { blocker.reset(); }}>{pending ? 'Залишитися' : 'Продовжити редагування'}</button>
              <button type="button" className="button button--danger" onClick={() => { blocker.proceed(); }}>{pending ? 'Вийти без очікування' : 'Відкинути зміни'}</button>
            </>
          )}>
          <p>{pending
            ? 'Запит уже надіслано, і вихід його не скасує: доступи можуть змінитися. Результат видно лише на цій сторінці — після виходу відкрийте доступи знову й перевірте.'
            : 'Незбережені зміни буде втрачено. Поточні збережені доступи не зміняться.'}</p>
        </Dialog>
      ) : null}
    </section>
  );
}

const NAMES_SHOWN = 10;
const namesText = (names: string[]) =>
  (names.length <= NAMES_SHOWN ? names.join(', ') : `${names.slice(0, NAMES_SHOWN).join(', ')} та ще ${String(names.length - NAMES_SHOWN)}`);

/** The stored state next to the draft after a conflict or an unknown result: the user decides what happens next. */
function RemoteState({ remote, before, drifted, onDiscard, onKeep }: { remote: UserAccess; before: UserAccess; drifted: boolean; onDiscard: () => void; onKeep: () => void }) {
  const servers = toDraft(remote);
  return (
    <div className="notice notice--warning acl-remote" role="status">
      <p className="notice__title">{drifted
        ? `Чернетка змінилася під час перевірки — актуальний збережений стан (ревізія ${String(remote.revision)}) не застосовано`
        : `Актуальний збережений стан (ревізія ${String(remote.revision)}) відрізняється від вашої чернетки`}</p>
      {drifted ? <p className="notice__text">Ваші зміни залишилися. Оберіть, що робити далі, або перевірте стан ще раз.</p> : null}
      {remote.role === before.role ? null : <p className="notice__text">{`Роль змінилася: ${ROLE_LABELS[before.role]} → ${ROLE_LABELS[remote.role]}.`}</p>}
      {servers.length === 0 ? <p className="notice__text">Збережених доступів немає.</p> : (
        <ul className="acl-remote__list">
          {servers.map((s) => <li key={s.serverId}>{`${s.serverName} — ${scopeText(s)}${s.mode === 'selected' && s.services.length > 0 ? ` (${namesText(s.services)})` : ''}`}</li>)}
        </ul>
      )}
      <div className="button-row">
        <button type="button" className="button button--small" onClick={onKeep}>Залишити чернетку на актуальній версії</button>
        <button type="button" className="button button--small" onClick={onDiscard}>Відкинути чернетку й показати актуальний стан</button>
      </div>
      <p className="notice__text">«Залишити чернетку» нічого не зберігає: після «Зберегти» чернетка повністю замінить актуальний стан.</p>
    </div>
  );
}
