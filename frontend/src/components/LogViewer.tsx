import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, logsApi } from '../api/client';
import type { LogResult, LogStream } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../pages/ServersPage';
import { Dialog } from './Dialog';

// Bounded log tail (ADR-018). `LogTail` holds the one read cycle and the content; `LogViewer` wraps it in a dialog
// (server page), the applications panel shows `LogTail` inline. Mounted per server + target + session (key): closing,
// switching target/server/tab, logout or a new session unmount it — polling stops, in-flight requests are aborted,
// the text is dropped. The text is rendered as React text (never HTML, ANSI already stripped on the managed server)
// and never stored (no URL, storage, audit or cache).
//
// A failed refresh never silently keeps old text: after a transient failure (network, 5xx, rate limit, a busy or slow
// broker, an expired request) the last text of THIS process stays, explicitly labelled as not refreshed; when access
// or the target is gone (403, 409, not authorized, another process behind the target) the text is hidden. A refresh
// keeps the chosen stream and the reading position: it follows the end only when the reader was already at the end,
// and while text is selected in the log the new text waits (shown once the selection is cleared or on request).

export const LOG_REFRESH_MS = 5_000;

const REASONS: Record<string, string> = {
  not_allowlisted: 'сервіс не в локальному allowlist', logs_not_allowed: 'читання логів цього сервісу не дозволено',
  allowlist_invalid: 'локальний allowlist некоректний', not_found: 'процес не знайдено', ambiguous: 'кілька процесів з цим ім’ям',
  cluster_unsupported: 'cluster-режим не підтримується', fingerprint_mismatch: 'визначення процесу змінилося',
  daemon_unavailable: 'PM2 daemon недоступний', deadline_passed: 'запит протерміновано', invalid_deadline: 'некоректний дедлайн',
  broker_busy: 'broker зайнятий', timeout: 'читання не вклалося в час', broker_unavailable: 'broker недоступний',
  broker_unsupported: 'broker не підтримує перегляд логів',
  target_changed: 'ціль тепер відповідає іншому сервісу — запит не виконано', identity_changed: 'визначення процесу змінилося після запиту — запит не виконано',
  not_authorized: 'доступ до цього сервісу більше не надано',
};
const STATE_TEXT: Record<LogStream['state'], string> = {
  ok: '', empty: 'Лог порожній.', missing: 'Файл логу відсутній.', unavailable: 'Лог недоступний для читання (поза дозволеними каталогами, недоступний або вимкнений).',
  merged: 'stderr записується в той самий файл, що й stdout.',
};

type Phase = 'loading' | 'ready' | 'error';

/** Outcomes after which the previous text of the same process may still be shown (labelled as not refreshed). */
const TRANSIENT_REASONS = new Set(['broker_busy', 'timeout', 'broker_unavailable', 'daemon_unavailable', 'deadline_passed']);
/** Errors after which the previous text is hidden: access, permission or the target itself is no longer confirmed. */
const hidesText = (error: unknown) => error instanceof ApiError && (error.kind === 'forbidden' || error.kind === 'conflict');
/** Distance from the bottom (px) within which the reader counts as "following the end". */
const STICK_PX = 24;

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'forbidden') return 'Недостатньо прав для перегляду логів.';
    if (error.kind === 'conflict') return 'Перегляд логів недоступний: агент не підтримує його, не на зв’язку або сервіс не дозволено.';
    if (error.kind === 'not_found') return 'Запит протерміновано або сервер API перезапускався. Оновіть вручну.';
    if (error.kind === 'rate_limited') return 'Забагато запитів. Зачекайте й оновіть вручну.';
  }
  return 'Не вдалося отримати логи. Оновіть вручну.';
}

export function LogViewer({ serverId, serverName, targetKey, name, onClose }: {
  serverId: string; serverName: string; targetKey: string; name: string; onClose: () => void;
}) {
  return (
    <Dialog title={`Логи: ${name}`} onClose={onClose} className="dialog--wide"
      actions={<button type="button" className="button" onClick={onClose}>Закрити</button>}>
      <LogTail serverId={serverId} serverName={serverName} targetKey={targetKey} name={name} />
    </Dialog>
  );
}

export function LogTail({ serverId, serverName, targetKey, name, collectedAt }: {
  serverId: string; serverName: string; targetKey: string; name: string;
  /** When PM2 inventory of this process was collected (shown next to the read time; omitted when unknown). */
  collectedAt?: string | null;
}) {
  const { state: auth, sessionExpired } = useAuth();
  const [tab, setTab] = useState<'stdout' | 'stderr'>('stdout');
  const [auto, setAuto] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LogResult | null>(null);
  // The shown result is older than the last attempt (which failed transiently).
  const [stale, setStale] = useState(false);
  // A newer result that waits while text in the log is selected.
  const [incoming, setIncoming] = useState<LogResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabsId = useId();
  const csrf = auth.status === 'authenticated' ? auth.session.csrfToken : null;
  const autoRef = useRef(auto);
  useEffect(() => { autoRef.current = auto; }, [auto]);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const selecting = useCallback(() => {
    const sel = document.getSelection();
    return Boolean(sel && !sel.isCollapsed && pre.current && sel.anchorNode && pre.current.contains(sel.anchorNode));
  }, []);
  const show = useCallback((next: LogResult) => {
    if (selecting()) { setIncoming(next); return; }
    setIncoming(null);
    setResult(next);
  }, [selecting]);

  useEffect(() => {
    if (!csrf) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onVisible: (() => void) | undefined;
    const schedule = () => {
      if (controller.signal.aborted || !autoRef.current) return;
      timer = setTimeout(() => {
        if (controller.signal.aborted || !autoRef.current) return; // switched off meanwhile
        if (document.visibilityState === 'visible') { void tick(); return; }
        // Hidden tab: no requests; resume once visible again.
        onVisible = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisible ?? (() => undefined)); void tick(); } };
        document.addEventListener('visibilitychange', onVisible);
      }, LOG_REFRESH_MS);
    };
    // One read at a time: the next one is scheduled only after this one finished.
    const tick = async () => {
      setBusy(true);
      try {
        const created = await logsApi.create(serverId, targetKey, csrf, controller.signal);
        let view = await logsApi.get(created.requestId, controller.signal);
        while (view.status === 'pending' && !controller.signal.aborted) view = await logsApi.get(created.requestId, controller.signal);
        if (controller.signal.aborted) return;
        if (view.status === 'expired' || !view.result) {
          setError('Сервер не відповів вчасно (агент офлайн або зайнятий). Оновіть вручну.');
          setStale(true);
          setPhase('error');
          setAuto(false);
          return;
        }
        const outcome = view.result;
        if (outcome.outcome === 'ok') {
          show(outcome);
          setStale(false);
          setError(null);
          setPhase('ready');
          schedule();
          return;
        }
        setError(`Логи недоступні: ${REASONS[outcome.reason ?? ''] ?? 'невідома причина'}.`);
        if (TRANSIENT_REASONS.has(outcome.reason ?? '')) setStale(true);
        else { setResult(null); setIncoming(null); }
        setPhase('error');
        setAuto(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
        // No automatic retries after an error: the user refreshes explicitly.
        setError(errorText(e));
        if (hidesText(e)) { setResult(null); setIncoming(null); } else setStale(true);
        setPhase('error');
        setAuto(false);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    };
  }, [serverId, targetKey, csrf, nonce, sessionExpired, show]);

  // A waiting result is shown as soon as the selection in the log is cleared.
  useEffect(() => {
    if (!incoming) return undefined;
    const onChange = () => { if (!selecting()) { setResult(incoming); setIncoming(null); } };
    document.addEventListener('selectionchange', onChange);
    return () => { document.removeEventListener('selectionchange', onChange); };
  }, [incoming, selecting]);

  // Turning auto-refresh on again starts a fresh cycle; turning it off just stops scheduling.
  const toggleAuto = (on: boolean) => {
    setAuto(on);
    if (on) setNonce((n) => n + 1);
  };

  const stream = result ? result[tab] : null;
  const text = stream?.state === 'ok' ? stream.text : null;
  // New text: follow the end only when the reader was at the end (first load and a stream switch start there).
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const switchTab = (next: 'stdout' | 'stderr') => { stick.current = true; setTab(next); };
  const onScroll = () => {
    const el = pre.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };
  return (
    <div className="log-tail">
      <p className="hint">{`Сервер «${serverName}», сервіс «${name}» (${targetKey}). Показано лише останній фрагмент (до 100 рядків на джерело, до 8 КіБ разом), не повний архів; відомі формати секретів замасковано, але це не гарантія.`}</p>
      <div className="log-toolbar">
        <div role="tablist" aria-label="Джерело логу" id={tabsId} className="log-tabs">
          {(['stdout', 'stderr'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`log-tab ${tab === t ? 'log-tab--active' : ''}`}
              onClick={() => { switchTab(t); }}>{t}</button>
          ))}
        </div>
        <label className="log-auto"><input type="checkbox" checked={auto} onChange={(e) => { toggleAuto(e.target.checked); }} /> Оновлювати кожні 5 с</label>
        <button type="button" className="button" disabled={busy} onClick={() => { setError(null); setNonce((n) => n + 1); }}>{busy ? 'Оновлення…' : 'Оновити'}</button>
      </div>
      {phase === 'loading' && !result ? <p role="status">Завантаження логів…</p> : null}
      {error ? <p className="notice notice--warning" role="alert">{error}</p> : null}
      {result && stale ? <p className="notice notice--warning log-stale">{`Показано попередній результат (отримано ${formatDate(result.readAt)}) — його не оновлено.`}</p> : null}
      {incoming ? (
        <p className="hint log-pending">
          Отримано новіший фрагмент — його буде показано, щойно ви знімете виділення.{' '}
          <button type="button" className="button button--small" onClick={() => { setResult(incoming); setIncoming(null); }}>Показати зараз</button>
        </p>
      ) : null}
      {result && stream ? (
        <div role="tabpanel" aria-label={tab} className="log-panel">
          <p className="hint">
            {`Отримано ${formatDate(result.readAt)}`}
            {stream.modifiedAt ? ` · файл змінено ${formatDate(stream.modifiedAt)}` : ''}
            {collectedAt ? ` · PM2 зібрано ${formatDate(collectedAt)}` : ''}
            {stream.state === 'ok' ? ` · рядків: ${String(stream.lines)}` : ''}
            {stream.truncated ? ' · старіші рядки не показано' : ''}
          </p>
          {stream.state === 'ok' ? <pre ref={pre} className="log-text" tabIndex={0} aria-label={`${tab} ${name}`} onScroll={onScroll}>{stream.text}</pre> : <p>{STATE_TEXT[stream.state]}</p>}
        </div>
      ) : null}
    </div>
  );
}
