import { type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, projectInfoApi } from '../api/client';
import type { ProjectInfo } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatRetry } from './StatusMessage';
import { codePoints, descriptionProblem, type FieldName, type FieldProblem, githubProblem, PROJECT_INFO_LIMITS, projectUrlProblem } from './projectInfoRules';

// «Про проєкт» in the overview of an application (ADR-036): GitHub, project address and a short description that an
// administrator keeps for a service (server + PM2 name). Reference data only: saving changes nothing in PM2, the Agent
// or a deployment; the links are never fetched or opened automatically.
//
// The state lives in useProjectInfo on the applications page (not in the panel): the details panel is mounted in a
// different place below and above 1280 px, and a window resized across that width must not lose a draft or a request.
// The page owns the guard too (one data-router blocker): switching service/tab, closing the details or leaving with
// a dirty draft or a save in flight asks first.
//
//   - Loaded once per service when its overview is shown; inventory polling never touches it (the panel does not
//     derive anything from the polled row), so a draft survives every refresh.
//   - One PUT per click, never retried; while it runs, editing and a second submit are blocked (handlers too).
//   - 409: the draft stays, saving waits for an explicit re-read. No answer (network/timeout): «Результат невідомий»,
//     the same. The re-read is a GET; while it runs the draft cannot be edited, so its answer never overwrites newer
//     input. A re-read equal to the draft does not prove that the earlier attempt was the one that saved it.
//   - Every answer is bound to the service it was asked for and to the session: a late one for another service (or
//     after logout) changes nothing. 401 ends the session; 403/404 clear the data and the draft.

export interface ProjectGuard { dirty: boolean; pending: boolean }
type Draft = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;
/** idle: not loaded yet (shown as loading while the overview is open). */
type Load = { status: 'idle' } | { status: 'ready'; info: ProjectInfo } | { status: 'error'; text: string } | { status: 'gone' };
export interface ProjectMessage { tone: 'ok' | 'warning' | 'error' | 'info'; title: string; text?: string }
interface State {
  key: string | null;
  load: Load;
  editing: boolean;
  draft: Draft;
  errors: Errors;
  phase: 'idle' | 'saving' | 'reading';
  /** After a conflict or an unknown result: saving waits for an explicit re-read. */
  blocked: 'conflict' | 'unknown' | null;
  message: ProjectMessage | null;
  /** After a re-read that differs from the draft: the values saved now (shown next to the form). */
  saved: ProjectInfo | null;
}

const EMPTY_DRAFT: Draft = { githubUrl: '', projectUrl: '', description: '' };
const initial = (key: string | null): State => ({ key, load: { status: 'idle' }, editing: false, draft: EMPTY_DRAFT, errors: {}, phase: 'idle', blocked: null, message: null, saved: null });
const draftOf = (info: ProjectInfo): Draft => ({ githubUrl: info.githubUrl ?? '', projectUrl: info.projectUrl ?? '', description: info.description ?? '' });
const FIELDS: FieldName[] = ['githubUrl', 'projectUrl', 'description'];
const sameDraft = (a: Draft, b: Draft) => FIELDS.every((f) => a[f] === b[f]);

const PROBLEM_TEXT: Record<FieldName, Partial<Record<FieldProblem, string>>> = {
  githubUrl: { invalid_github: 'Вкажіть адресу репозиторію: https://github.com/<власник>/<репозиторій>.', too_long: `Не довше ${String(PROJECT_INFO_LIMITS.url)} символів.` },
  projectUrl: { invalid_url: 'Лише явна адреса http:// або https:// без логіна й пароля.', too_long: `Не довше ${String(PROJECT_INFO_LIMITS.url)} символів.` },
  description: { invalid_text: 'Опис містить недопустимі керівні символи.', too_long: `Не довше ${String(PROJECT_INFO_LIMITS.description)} символів.` },
};

/** The draft in the form the API stores (trimmed, LF line breaks, empty → null) or the problem of each field. */
export function checkDraft(draft: Draft): { ok: true; value: Record<FieldName, string | null> } | { ok: false; errors: Errors } {
  const github = draft.githubUrl.trim();
  const url = draft.projectUrl.trim();
  const description = draft.description.replace(/\r\n?/g, '\n').trim();
  const errors: Errors = {};
  const g = github === '' ? null : githubProblem(github);
  const u = url === '' ? null : projectUrlProblem(url);
  const d = description === '' ? null : descriptionProblem(description);
  if (g) errors.githubUrl = PROBLEM_TEXT.githubUrl[g] ?? 'Недопустиме значення.';
  if (u) errors.projectUrl = PROBLEM_TEXT.projectUrl[u] ?? 'Недопустиме значення.';
  if (d) errors.description = PROBLEM_TEXT.description[d] ?? 'Недопустиме значення.';
  if (g || u || d) return { ok: false, errors };
  return { ok: true, value: { githubUrl: github || null, projectUrl: url || null, description: description || null } };
}

const MESSAGES = {
  saved: { tone: 'ok', title: 'Інформацію про проєкт збережено.' },
  unchanged: { tone: 'info', title: 'Змін немає — нічого не надіслано.' },
  conflict: { tone: 'warning', title: 'Інформацію вже змінено в іншому місці', text: 'Вашу чернетку не втрачено, але її не збережено. Перечитайте збережений стан, порівняйте й вирішіть, що зберегти.' },
  unknown: { tone: 'warning', title: 'Результат невідомий', text: 'Відповідь не отримано — зміни могли зберегтися. Перечитайте збережений стан перед повтором; автоматичного повтору немає.' },
  gone: { tone: 'warning', title: 'Застосунок або доступ до нього більше недоступні', text: 'Дані й чернетку приховано.' },
} as const satisfies Record<string, ProjectMessage>;

function failure(error: unknown): ProjectMessage {
  if (error instanceof ApiError) {
    if (error.kind === 'invalid_request') return { tone: 'error', title: 'Сервер не прийняв значення', text: 'Перевірте поля: зміни не збережено.' };
    if (error.kind === 'rate_limited') return { tone: 'error', title: 'Забагато змін поспіль', text: `Зміни не збережено.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}` };
    if (error.kind === 'unavailable') return { tone: 'error', title: 'Сервіс тимчасово недоступний', text: `Зміни не збережено.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}` };
  }
  return { tone: 'error', title: 'Неочікувана відповідь сервера', text: 'Результат невідомий. Перечитайте збережений стан перед повтором.' };
}

export interface ProjectInfoController {
  state: State;
  canEdit: boolean;
  guard: ProjectGuard;
  startEdit: () => void;
  change: (field: FieldName, value: string) => void;
  cancel: () => void;
  save: () => void;
  reread: () => void;
  retryLoad: () => void;
  /** The page decided to drop the draft (and stop waiting for a save): back to the saved view. */
  discard: () => void;
}

/**
 * State of «Про проєкт» for the selected service. `target` null (nothing selected, or the process is gone / no longer
 * visible) clears everything; `active` (its overview is on screen) starts the first load.
 */
export function useProjectInfo(target: { serverId: string; serviceName: string } | null, active: boolean, canEdit: boolean): ProjectInfoController {
  const { state: auth, bindSession, sessionExpired } = useAuth();
  const csrf = auth.status === 'authenticated' ? auth.session.csrfToken : null;
  const serverId = target?.serverId ?? null;
  const serviceName = target?.serviceName ?? null;
  const key = serverId !== null && serviceName !== null ? `${serverId}\n${serviceName}` : null;
  const [s, setS] = useState<State>(() => initial(key));
  // Another service (or none): start over. Answers still on their way are bound to their key and ignored.
  const current = s.key === key ? s : initial(key);
  if (s.key !== key) setS(current);
  const latest = useRef(current);
  useEffect(() => { latest.current = current; });
  /** The key a request is in flight for (handlers refuse work while it is set). */
  const busy = useRef<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => { inflight.current?.abort(); inflight.current = null; busy.current = null; }, [key]);

  /** Applies `update` only while the state still belongs to `forKey`. */
  const patch = useCallback((forKey: string, update: (p: State) => State) => { setS((p) => (p.key === forKey ? update(p) : p)); }, []);

  const lost = useCallback((forKey: string, error: unknown): boolean => {
    if (!(error instanceof ApiError)) return false;
    if (error.kind === 'unauthorized') { sessionExpired(); return true; }
    if (error.kind === 'forbidden' || error.kind === 'not_found') {
      patch(forKey, (p) => ({ ...initial(forKey), load: { status: 'gone' }, message: p.load.status === 'ready' ? MESSAGES.gone : null }));
      return true;
    }
    return false;
  }, [patch, sessionExpired]);

  /** One request for `forKey`, bound to the session; null when its answer no longer matters. */
  const run = useCallback(async <T,>(forKey: string, request: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | null> => {
    const controller = new AbortController();
    inflight.current?.abort();
    inflight.current = controller;
    busy.current = forKey;
    const binding = bindSession();
    try {
      const value = await request(controller.signal);
      return controller.signal.aborted || !binding.current() ? null : { ok: true, value };
    } catch (error) {
      return controller.signal.aborted || !binding.current() || (error instanceof ApiError && error.kind === 'aborted') ? null : { ok: false, error };
    } finally {
      if (inflight.current === controller) { inflight.current = null; busy.current = null; }
    }
  }, [bindSession]);

  // First load of the service, once its overview is shown (only then: no requests for the list or other tabs).
  const needLoad = active && key !== null && current.load.status === 'idle';
  useEffect(() => {
    if (!needLoad || serverId === null || serviceName === null) return;
    // «idle» while active is shown as loading; an abandoned answer (another service, logout) leaves it idle.
    void run(key, (signal) => projectInfoApi.get(serverId, serviceName, signal)).then((r) => {
      if (!r) return;
      if (r.ok) { patch(key, (p) => ({ ...p, load: { status: 'ready', info: r.value } })); return; }
      if (lost(key, r.error)) return;
      patch(key, (p) => ({ ...p, load: { status: 'error', text: r.error instanceof ApiError && r.error.kind === 'unavailable' ? `Сервіс тимчасово недоступний.${formatRetry(r.error.retryAfterSeconds)}` : 'Відповідь не отримано.' } }));
    });
  }, [needLoad, key, serverId, serviceName, patch, run, lost]);

  const startEdit = useCallback(() => {
    const p = latest.current;
    if (!canEdit || busy.current || p.key === null || p.load.status !== 'ready' || p.editing) return;
    const info = p.load.info;
    patch(p.key, (q) => ({ ...q, editing: true, draft: draftOf(info), errors: {}, blocked: null, message: null, saved: null }));
  }, [canEdit, patch]);

  const change = useCallback((field: FieldName, value: string) => {
    const p = latest.current;
    if (busy.current || p.key === null || !p.editing) return;
    patch(p.key, (q) => ({ ...q, draft: { ...q.draft, [field]: value }, errors: Object.fromEntries(Object.entries(q.errors).filter(([k]) => k !== field)) }));
  }, [patch]);

  const cancel = useCallback(() => {
    const p = latest.current;
    if (busy.current || p.key === null) return;
    patch(p.key, (q) => ({ ...q, editing: false, draft: EMPTY_DRAFT, errors: {}, blocked: null, message: null, saved: null }));
  }, [patch]);

  const discard = useCallback(() => {
    const p = latest.current;
    if (p.key === null) return;
    inflight.current?.abort(); // the page stops waiting; the request itself may still be applied by the API
    inflight.current = null;
    busy.current = null;
    patch(p.key, (q) => ({ ...q, editing: false, draft: EMPTY_DRAFT, errors: {}, phase: 'idle', blocked: null, message: null, saved: null }));
  }, [patch]);

  const save = useCallback(() => {
    const p = latest.current;
    if (busy.current || p.key === null || serverId === null || serviceName === null || csrf === null) return;
    if (!canEdit || !p.editing || p.blocked || p.load.status !== 'ready') return;
    const forKey = p.key;
    const info = p.load.info;
    const checked = checkDraft(p.draft);
    if (!checked.ok) { patch(forKey, (q) => ({ ...q, errors: checked.errors, message: null })); return; }
    if (FIELDS.every((f) => checked.value[f] === info[f])) {
      patch(forKey, (q) => ({ ...q, editing: false, draft: EMPTY_DRAFT, errors: {}, message: MESSAGES.unchanged, saved: null }));
      return;
    }
    patch(forKey, (q) => ({ ...q, phase: 'saving', message: null, errors: {} }));
    void run(forKey, (signal) => projectInfoApi.save(serverId, { serviceName, expectedRevision: info.revision, ...checked.value }, csrf, signal)).then((r) => {
      if (!r) { patch(forKey, (q) => (q.phase === 'saving' ? { ...q, phase: 'idle' } : q)); return; }
      if (r.ok) {
        patch(forKey, (q) => ({ ...q, load: { status: 'ready', info: r.value }, editing: false, draft: EMPTY_DRAFT, errors: {}, phase: 'idle', blocked: null, message: MESSAGES.saved, saved: null }));
        return;
      }
      if (lost(forKey, r.error)) return;
      const kind = r.error instanceof ApiError ? r.error.kind : 'unexpected';
      if (kind === 'conflict') { patch(forKey, (q) => ({ ...q, phase: 'idle', blocked: 'conflict', message: MESSAGES.conflict })); return; }
      if (kind === 'network' || kind === 'timeout' || kind === 'unexpected') { patch(forKey, (q) => ({ ...q, phase: 'idle', blocked: 'unknown', message: kind === 'unexpected' ? failure(r.error) : MESSAGES.unknown })); return; }
      patch(forKey, (q) => ({ ...q, phase: 'idle', message: failure(r.error) }));
    });
  }, [canEdit, csrf, serverId, serviceName, patch, run, lost]);

  // Explicit recovery read (GET only). Editing is locked meanwhile, so the answer is compared with the draft it found.
  const reread = useCallback(() => {
    const p = latest.current;
    if (busy.current || p.key === null || serverId === null || serviceName === null || !p.editing || !p.blocked) return;
    const forKey = p.key;
    patch(forKey, (q) => ({ ...q, phase: 'reading' }));
    void run(forKey, (signal) => projectInfoApi.get(serverId, serviceName, signal)).then((r) => {
      if (!r) { patch(forKey, (q) => (q.phase === 'reading' ? { ...q, phase: 'idle' } : q)); return; }
      if (r.ok) {
        const info = r.value;
        patch(forKey, (q) => {
          const checked = checkDraft(q.draft);
          const same = checked.ok && FIELDS.every((f) => checked.value[f] === info[f]);
          if (same) {
            return { ...q, load: { status: 'ready', info }, editing: false, draft: EMPTY_DRAFT, phase: 'idle', blocked: null, saved: null,
              message: { tone: 'info', title: `Збережений стан збігається з вашою чернеткою (ревізія ${String(info.revision)})`, text: 'Це не доводить, що зберегла саме ваша спроба. Редагування завершено.' } };
          }
          return { ...q, load: { status: 'ready', info }, phase: 'idle', blocked: null, saved: info,
            message: { tone: 'warning', title: `Перечитано збережений стан (ревізія ${String(info.revision)}) — він відрізняється від вашої чернетки`, text: 'Збережені зараз значення показано нижче. «Зберегти» замінить їх вашою чернеткою, «Скасувати» відкине чернетку.' } };
        });
        return;
      }
      if (lost(forKey, r.error)) return;
      patch(forKey, (q) => ({ ...q, phase: 'idle', message: { tone: 'error', title: 'Не вдалося перечитати збережений стан', text: 'Чернетку збережено тут. Спробуйте ще раз.' } }));
    });
  }, [serverId, serviceName, patch, run, lost]);

  const retryLoad = useCallback(() => {
    const p = latest.current;
    if (busy.current || p.key === null || p.load.status !== 'error') return;
    patch(p.key, (q) => ({ ...q, load: { status: 'idle' } }));
  }, [patch]);

  const dirty = current.editing && current.load.status === 'ready' && !sameDraft(current.draft, draftOf(current.load.info));
  return { state: current, canEdit, guard: { dirty, pending: current.phase === 'saving' }, startEdit, change, cancel, save, reread, retryLoad, discard };
}

function ExternalLink({ href }: { href: string }) {
  return (
    <a className="external-link" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      <span className="external-link__text">{href}</span>
      <span className="external-link__icon" aria-hidden="true">↗</span>
      <span className="visually-hidden"> (відкривається в новій вкладці)</span>
    </a>
  );
}

const NOT_SET = <span className="project-info__unset">Не вказано</span>;

function Values({ info }: { info: ProjectInfo }) {
  return (
    <dl className="project-info__rows">
      <div><dt>GitHub</dt><dd>{info.githubUrl ? <ExternalLink href={info.githubUrl} /> : NOT_SET}</dd></div>
      <div><dt>Адреса проєкту</dt><dd>{info.projectUrl ? <ExternalLink href={info.projectUrl} /> : NOT_SET}</dd></div>
      <div><dt>Короткий опис</dt><dd className="project-info__text">{info.description ?? NOT_SET}</dd></div>
    </dl>
  );
}

const isEmpty = (info: ProjectInfo) => info.githubUrl === null && info.projectUrl === null && info.description === null;

export function ProjectInfoPanel({ project }: { project: ProjectInfoController }) {
  const { state, canEdit } = project;
  const ids = { title: useId(), github: useId(), url: useId(), description: useId() };
  const editButton = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  // Focus follows the mode: into the form when editing starts, back to «Редагувати» when it ends (never on mount).
  const wasEditing = useRef(state.editing);
  useEffect(() => {
    if (wasEditing.current === state.editing) return;
    wasEditing.current = state.editing;
    if (state.editing) firstField.current?.focus();
    else editButton.current?.focus();
  }, [state.editing]);

  const locked = state.phase !== 'idle';
  const info = state.load.status === 'ready' ? state.load.info : null;
  const empty = info !== null && isEmpty(info);
  const onSubmit = (e: SyntheticEvent) => { e.preventDefault(); project.save(); };
  const field = (name: FieldName) => ({
    value: state.draft[name], disabled: locked,
    'aria-invalid': state.errors[name] ? true : undefined,
    onChange: (e: { target: { value: string } }) => { project.change(name, e.target.value); },
  });
  const describedBy = (name: FieldName, id: string) => (state.errors[name] ? `${id}-error` : `${id}-hint`);
  const message = state.message;
  const count = codePoints(state.draft.description.replace(/\r\n?/g, '\n').trim());

  return (
    <section className="project-info" aria-labelledby={ids.title} aria-busy={state.load.status === 'idle' || locked || undefined}>
      <div className="project-info__head">
        <h3 id={ids.title} className="app-section-title">Про проєкт</h3>
        {canEdit && info && !state.editing && !empty ? (
          <button ref={editButton} type="button" className="button button--small" aria-label="Редагувати інформацію про проєкт" onClick={project.startEdit}>Редагувати</button>
        ) : null}
      </div>

      {message ? (
        <div className={`notice notice--${message.tone}`} role={message.tone === 'error' || message.tone === 'warning' ? 'alert' : 'status'}>
          <p className="notice__title">{message.title}</p>
          {message.text ? <p className="notice__text">{message.text}</p> : null}
          {state.editing && state.blocked ? (
            <button type="button" className="button button--small notice__action" disabled={locked} onClick={project.reread}>
              {state.phase === 'reading' ? 'Перечитування…' : 'Перечитати збережений стан'}
            </button>
          ) : null}
        </div>
      ) : null}

      {state.load.status === 'idle' ? <p role="status" className="hint">Завантаження інформації про проєкт…</p> : null}
      {state.load.status === 'error' ? (
        <div className="notice notice--warning" role="alert">
          <p className="notice__title">Не вдалося завантажити інформацію про проєкт</p>
          <p className="notice__text">{state.load.text} Метрики, логи й керування від цього не залежать.</p>
          <button type="button" className="button button--small notice__action" onClick={project.retryLoad}>Спробувати ще раз</button>
        </div>
      ) : null}
      {state.load.status === 'gone' && !message ? <p className="hint">Інформація про проєкт недоступна.</p> : null}

      {info && !state.editing ? (
        empty ? (
          <div className="project-info__empty">
            <p className="hint">Інформацію про проєкт ще не додано.</p>
            {canEdit ? <button ref={editButton} type="button" className="button button--small" onClick={project.startEdit}>Додати інформацію</button> : null}
          </div>
        ) : <Values info={info} />
      ) : null}

      {info && state.editing ? (
        <form className="project-info__form" onSubmit={onSubmit} noValidate aria-label="Редагування інформації про проєкт">
          <p className="hint">Усі поля необов’язкові. Порожнє поле очищує збережене значення.</p>
          <div className="field">
            <label htmlFor={ids.github}>GitHub</label>
            <input ref={firstField} id={ids.github} type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={PROJECT_INFO_LIMITS.url}
              placeholder="https://github.com/owner/repository" aria-describedby={describedBy('githubUrl', ids.github)} {...field('githubUrl')} />
            {state.errors.githubUrl ? <p id={`${ids.github}-error`} className="field__error">{state.errors.githubUrl}</p>
              : <p id={`${ids.github}-hint`} className="hint">Адреса репозиторію на github.com.</p>}
          </div>
          <div className="field">
            <label htmlFor={ids.url}>Адреса проєкту</label>
            <input id={ids.url} type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={PROJECT_INFO_LIMITS.url}
              placeholder="https://example.com" aria-describedby={describedBy('projectUrl', ids.url)} {...field('projectUrl')} />
            {state.errors.projectUrl ? <p id={`${ids.url}-error`} className="field__error">{state.errors.projectUrl}</p>
              : <p id={`${ids.url}-hint`} className="hint">Працюючий сайт або API: http:// чи https://.</p>}
          </div>
          <div className="field">
            <label htmlFor={ids.description}>Короткий опис</label>
            <textarea id={ids.description} rows={4} aria-describedby={describedBy('description', ids.description)} {...field('description')} />
            {state.errors.description ? <p id={`${ids.description}-error`} className="field__error">{state.errors.description}</p>
              : <p id={`${ids.description}-hint`} className={`hint num${count > PROJECT_INFO_LIMITS.description ? ' field__error' : ''}`}>{`Звичайний текст, переноси рядків зберігаються · ${String(count)} / ${String(PROJECT_INFO_LIMITS.description)}`}</p>}
          </div>
          {state.saved ? (
            <div className="project-info__saved">
              <p className="hint">{`Збережено зараз (ревізія ${String(state.saved.revision)}):`}</p>
              <Values info={state.saved} />
            </div>
          ) : null}
          <div className="form-actions">
            <button type="button" className="button" disabled={locked} onClick={project.cancel}>Скасувати</button>
            <button type="submit" className="button button--primary" disabled={locked || state.blocked !== null}>{state.phase === 'saving' ? 'Збереження…' : 'Зберегти'}</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
