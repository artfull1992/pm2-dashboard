import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, controlApi } from '../api/client';
import { type CommandView, type ControlAction, type ControlTarget, FINAL_COMMAND_STATUSES } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../pages/ServersPage';
import { Dialog } from './Dialog';
import { ErrorState, formatRetry, LoadingState } from './StatusMessage';
import { usePolledResource } from './usePolledResource';

// Allowlisted PM2 control (ADR-017). Mounted per server and session (key) — nothing of another server/session is
// ever shown or acted upon. A request is never retried automatically; "accepted" is not "done": the UI follows the
// command until a final, server-confirmed status.

export const ACTION_LABELS: Record<ControlAction, string> = { start: 'Запустити', stop: 'Зупинити', restart: 'Перезапустити' };
const ACTION_VERBS: Record<ControlAction, string> = { start: 'запуск', stop: 'зупинку', restart: 'перезапуск' };

const MATCH_LABELS: Record<ControlTarget['matchStatus'], string> = {
  ok: 'готовий до керування', not_found: 'процес не знайдено в PM2', ambiguous: 'кілька процесів з цим ім’ям',
  cluster_unsupported: 'cluster-режим не підтримується', fingerprint_mismatch: 'визначення процесу змінилося (fingerprint)',
  daemon_unavailable: 'PM2 daemon недоступний',
};

const REASON_LABELS: Record<string, string> = {
  not_allowlisted: 'ціль не в локальному allowlist', action_not_allowed: 'дія не дозволена для цілі', allowlist_invalid: 'локальний allowlist некоректний',
  not_found: 'процес не знайдено', ambiguous: 'кілька процесів з цим ім’ям', cluster_unsupported: 'cluster-режим не підтримується',
  fingerprint_mismatch: 'визначення процесу змінилося', invalid_state: 'процес у стані, з якого ця дія не виконується',
  daemon_unavailable: 'PM2 daemon недоступний', pm2_error: 'PM2 відхилив дію', timeout: 'PM2 не відповів вчасно',
  deadline_passed: 'минув дедлайн команди', invalid_deadline: 'некоректний дедлайн', interrupted: 'broker перервався під час дії',
  identity_changed: 'процес змінився під час дії', verification_failed: 'очікуваний стан не підтвердився', command_conflict: 'конфлікт команди',
  broker_busy: 'broker зайнятий', broker_unavailable: 'broker недоступний', not_dispatched: 'команду не було передано агенту до дедлайну',
  no_result: 'результат не надійшов', actor_not_authorized: 'у користувача більше немає права керування', target_unavailable: 'ціль недоступна',
};
const reasonText = (r: string | null) => (r ? REASON_LABELS[r] ?? 'невідома причина' : '');

export function commandStatusText(c: CommandView): string {
  switch (c.status) {
    case 'queued': return 'У черзі — очікує агента.';
    case 'dispatched': return 'Передано агенту, виконується…';
    case 'succeeded': return `Виконано й підтверджено (стан після: ${c.after?.status ?? '—'}).`;
    case 'failed': return `Не вдалося: ${reasonText(c.reason)}.`;
    case 'rejected': return `Відхилено, дію не виконано: ${reasonText(c.reason)}.`;
    case 'expired': return `Протерміновано, дію не виконано: ${reasonText(c.reason)}.`;
    case 'unknown': return `Результат невідомий (${reasonText(c.reason)}): дія могла виконатися. Перевірте стан процесу; повторюйте лише свідомо.`;
  }
}

function controlError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'conflict') return 'Дію зараз неможливо виконати: керування вимкнене, ціль недоступна, сервер офлайн або вже виконується інша команда.';
    if (error.kind === 'forbidden') return 'Недостатньо прав для керування процесами.';
    if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'unavailable') {
      return `Відповідь не отримано — команда могла бути створена. Перевірте список команд нижче; повторна спроба в цьому ж вікні не створить дубліката.${formatRetry(error.retryAfterSeconds)}`;
    }
  }
  return 'Неочікувана помилка. Перевірте список команд нижче.';
}

const newKey = () => crypto.randomUUID();

export function ProcessControl({ serverId, serverName, onFinished }: { serverId: string; serverName: string; onFinished: () => void }) {
  const { state: auth, can, sessionExpired } = useAuth();
  const loadView = useCallback((signal: AbortSignal) => controlApi.view(serverId, signal), [serverId]);
  const loadCommands = useCallback((signal: AbortSignal) => controlApi.commands(serverId, signal), [serverId]);
  const view = usePolledResource(loadView, serverId);
  const commands = usePolledResource(loadCommands, serverId);
  const reloadView = view.reload;
  const reloadCommands = commands.reload;
  const [confirm, setConfirm] = useState<{ target: ControlTarget; action: ControlAction; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<CommandView | null>(null);
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => { inflight.current?.abort(); }, []);

  // Follow the tracked command until it is final (bounded by its deadline + grace on the server side).
  const trackedId = tracked?.id ?? null;
  const trackedFinal = tracked ? FINAL_COMMAND_STATUSES.includes(tracked.status) : true;
  useEffect(() => {
    if (!trackedId || trackedFinal) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      controlApi.command(trackedId, controller.signal).then(
        (c) => {
          if (controller.signal.aborted) return;
          setTracked(c);
          if (FINAL_COMMAND_STATUSES.includes(c.status)) { reloadCommands(); reloadView(); onFinished(); }
        },
        (e: unknown) => { if (e instanceof ApiError && e.kind === 'unauthorized') sessionExpired(); },
      );
    }, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [trackedId, trackedFinal, reloadCommands, reloadView, onFinished, sessionExpired]);

  const run = async () => {
    if (!confirm || auth.status !== 'authenticated') return;
    const controller = new AbortController();
    inflight.current = controller;
    setPending(true);
    setError(null);
    try {
      const created = await controlApi.create(serverId, { targetKey: confirm.target.targetKey, action: confirm.action, idempotencyKey: confirm.key }, auth.session.csrfToken, controller.signal);
      if (controller.signal.aborted) return;
      setTracked(created);
      setConfirm(null);
      reloadCommands();
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      setError(controlError(e));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  const v = view.state.status === 'ready' ? view.state.data : view.state.status === 'error' ? view.state.data : null;
  const current = v && v.serverId === serverId ? v : null;
  const canControl = can('processes:control');
  const ready = current !== null && current.enabled && current.serverStatus === 'online' && current.broker?.state === 'ok' && current.broker.fresh;
  const list = commands.state.status === 'ready' ? commands.state.data : commands.state.status === 'error' ? commands.state.data : null;

  return (
    <section className="card" aria-labelledby="control-title">
      <h2 id="control-title" className="card__title">Керування PM2</h2>
      {view.state.status === 'loading' ? <LoadingState /> : null}
      {view.state.status === 'error' ? <ErrorState title="Не вдалося оновити стан керування" onRetry={view.reload}>{`Сервіс тимчасово недоступний.${formatRetry(view.state.retryAfterSeconds)}`}</ErrorState> : null}
      {current ? (
        <>
          {!current.enabled ? <p className="notice" role="status">Керування процесами вимкнене на сервері API (дії недоступні).</p> : null}
          {current.enabled && !current.broker ? <p className="notice notice--warning" role="status">Локальний broker керування на цьому сервері не налаштований.</p> : null}
          {current.broker && (current.broker.state !== 'ok' || !current.broker.fresh) ? (
            <p className="notice notice--warning" role="status">{`Broker ${current.broker.state === 'ok' ? 'давно не звітував' : 'недоступний'} (останній звіт ${formatDate(current.broker.reportedAt)}).`}</p>
          ) : null}
          {current.broker?.allowlist === 'invalid' ? <p className="notice notice--warning" role="status">Локальний allowlist некоректний — усі дії відхиляються.</p> : null}
          {current.enabled && current.serverStatus !== 'online' ? <p className="notice notice--warning" role="status">Сервер не онлайн — дії недоступні.</p> : null}
          {current.targets.length === 0 ? (
            <p className="card__text">Немає дозволених процесів (локальний allowlist порожній або broker не звітував).</p>
          ) : (
            <ul className="control-targets">
              {current.targets.map((t) => (
                <li key={t.targetKey}>
                  <span className="mono">{t.name}</span> <span className="hint">({t.targetKey}{t.pmId !== null ? `, PM2 id ${String(t.pmId)}` : ''}) — {MATCH_LABELS[t.matchStatus]}</span>
                  {canControl ? (
                    <span className="button-row">
                      {t.actions.map((a) => (
                        <button key={a} type="button" className={`button ${a === 'stop' ? 'button--danger' : ''}`}
                          disabled={!ready || t.matchStatus !== 'ok' || pending || (tracked !== null && !trackedFinal)}
                          onClick={() => { setError(null); setConfirm({ target: t, action: a, key: newKey() }); }}>
                          {ACTION_LABELS[a]}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {tracked ? (
        <p className={`notice ${tracked.status === 'succeeded' ? '' : 'notice--warning'}`} role="status" aria-live="polite">
          {`${ACTION_LABELS[tracked.action]} «${tracked.targetKey}»: ${commandStatusText(tracked)}`}
        </p>
      ) : null}

      {list && list.length > 0 ? (
        <details>
          <summary>Останні команди</summary>
          <ul className="control-history">
            {list.map((c) => (
              <li key={c.id}><span className="hint">{formatDate(c.requestedAt)}</span> {ACTION_LABELS[c.action]} <span className="mono">{c.targetKey}</span> — {commandStatusText(c)}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {confirm ? (
        <Dialog
          title={`${ACTION_LABELS[confirm.action]} процес?`}
          onClose={() => { if (!pending) setConfirm(null); }}
          actions={(
            <>
              <button type="button" className="button" disabled={pending} onClick={() => { setConfirm(null); }}>Скасувати</button>
              <button type="button" className={`button ${confirm.action === 'stop' ? 'button--danger' : 'button--primary'}`} disabled={pending} onClick={() => { void run(); }}>
                {pending ? 'Надсилання…' : ACTION_LABELS[confirm.action]}
              </button>
            </>
          )}
        >
          <p>{`Підтвердьте ${ACTION_VERBS[confirm.action]} процесу «${confirm.target.name}» (${confirm.target.targetKey}) на сервері «${serverName}».`}</p>
          {confirm.action !== 'start' ? <p className="hint">Застосунок буде недоступний, доки процес не запуститься знову.</p> : null}
          {error ? <p className="field__error" role="alert">{error}</p> : null}
        </Dialog>
      ) : null}
    </section>
  );
}
