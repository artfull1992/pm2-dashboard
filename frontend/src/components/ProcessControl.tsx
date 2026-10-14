import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, controlApi, logsApi } from '../api/client';
import { type ApplicationItem, type CommandView, type ControlAction, type ControlTarget, FINAL_COMMAND_STATUSES } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../pages/ServersPage';
import { Dialog } from './Dialog';
import { LogViewer } from './LogViewer';
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

export type RowActions = (app: ApplicationItem) => ReactNode;

export interface MenuItem { key: string; label: string; danger?: boolean; disabled: boolean; onSelect: () => void }

function ActionMenu({ name, items }: { name: string; items: MenuItem[] }) {
  // The trigger is usable as long as at least one item is; each item carries its own availability.
  const disabled = items.every((i) => i.disabled);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return (
    <div className="action-menu" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} type="button" className="button action-menu__trigger" disabled={disabled}
        aria-label={`Дії: ${name}`} aria-expanded={open && !disabled} aria-controls={id}
        onClick={() => { setOpen(!open); }}>Дії <span aria-hidden="true">⌄</span></button>
      {open && !disabled ? <div id={id} className="action-menu__list" role="group" aria-label={`Дії для ${name}`}>
        {items.map((item) => <button key={item.key} type="button" disabled={item.disabled}
          className={`action-menu__item ${item.danger ? 'action-menu__item--danger' : ''}`}
          onClick={() => { trigger.current?.focus(); setOpen(false); item.onSelect(); }}>{item.label}</button>)}
      </div> : null}
    </div>
  );
}

export function ProcessControl({ serverId, serverName, onFinished, children }: {
  serverId: string; serverName: string; onFinished: () => void;
  children: (actions: RowActions | undefined) => ReactNode;
}) {
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
  const [logView, setLogView] = useState<{ targetKey: string; name: string } | null>(null);
  const closeLogs = useCallback(() => { setLogView(null); }, []);
  const canLogs = can('logs:read');
  // Log targets are fetched only for users who may read logs (ADR-018); others never ask.
  const loadLogTargets = useCallback((signal: AbortSignal) => (canLogs ? logsApi.targets(serverId, signal) : Promise.resolve(null)), [serverId, canLogs]);
  const logTargets = usePolledResource(loadLogTargets, `${serverId}:${String(canLogs)}`);
  const inflight = useRef<AbortController | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => { inflight.current?.abort(); }, []);

  // Follow the tracked command until it is final (bounded by its deadline + grace on the server side).
  const trackedId = tracked?.id ?? null;
  // After a confirmed request the row menu is disabled until the command is final, so focus goes to the command
  // status (instead of being lost on a disabled trigger); it runs after the dialog has restored its own focus.
  useEffect(() => { if (trackedId) statusRef.current?.focus(); }, [trackedId]);
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
  const ready = view.state.status === 'ready' && current !== null && current.enabled && current.serverStatus === 'online' && current.broker?.state === 'ok' && current.broker.daemon === 'ok' && current.broker.allowlist === 'ok' && current.broker.fresh;
  const list = commands.state.status === 'ready' ? commands.state.data : commands.state.status === 'error' ? commands.state.data : null;

  const lt = logTargets.state.status === 'ready' ? logTargets.state.data : null;
  const logs = lt && lt.serverId === serverId ? lt : null;

  const renderActions: RowActions = (app) => {
    // Logs: an explicit log target matching both name and PM2 id (never inferred from the inventory).
    const logCandidates = logs?.targets.filter((t) => t.name === app.name && t.pmId === app.pmId) ?? [];
    const logTarget = canLogs && logs?.state === 'supported' && logCandidates.length === 1 && logCandidates[0]?.matchStatus === 'ok' ? logCandidates[0] : undefined;
    const logItem: MenuItem[] = logTarget ? [{
      key: 'logs', label: 'Переглянути логи', disabled: false,
      onSelect: () => { setLogView({ targetKey: logTarget.targetKey, name: app.name }); },
    }] : [];
    const logHint = !canLogs || logTarget ? null
      : !logs ? null
        : logs.state === 'unsupported' ? 'Перегляд логів не підтримується'
          : logs.state === 'not_connected' ? 'Логи: агент не на зв’язку'
            : logs.state === 'broker_unavailable' ? 'Логи тимчасово недоступні'
              : 'Логи не дозволені';
    if (!canControl) {
      return <div className="service-actions">
        {logItem.length > 0 ? <ActionMenu name={app.name} items={logItem} /> : null}
        {logHint ? <span className="hint">{logHint}</span> : null}
      </div>;
    }
    // Both name and PM2 id must agree; never infer control identity from the inventory alone.
    const candidates = current?.targets.filter((t) => t.name === app.name && t.pmId === app.pmId) ?? [];
    const target = candidates.length === 1 ? candidates[0] : undefined;
    const named = current?.targets.find((t) => t.name === app.name);
    // Without a ready broker report the targets are unknown: say so instead of claiming the process is not allowed.
    const unavailableReason = !ready ? 'Керування зараз недоступне'
      : named && named.matchStatus !== 'ok' ? MATCH_LABELS[named.matchStatus] : named ? 'Ідентичність процесу не підтверджена' : 'Не дозволено керування';
    const blocked = app.inventoryState !== 'current' || app.serverStatus !== 'online' || !ready || !target || target.matchStatus !== 'ok' || pending || !trackedFinal;
    return <div className="service-actions">
      {(target && target.actions.length > 0) || logItem.length > 0 ? <ActionMenu name={app.name} items={[
        ...(target ? target.actions.map((action): MenuItem => ({
          key: action, label: ACTION_LABELS[action], danger: action === 'stop', disabled: blocked,
          onSelect: () => { setError(null); setConfirm({ target, action, key: newKey() }); },
        })) : []),
        ...logItem,
      ]} /> : null}
      {target && (app.inventoryState !== 'current' || app.serverStatus !== 'online') ? <span className="hint">Потрібні актуальні дані</span> : null}
      {!target ? <span className="hint">{unavailableReason}</span> : null}
      {target && target.matchStatus !== 'ok' ? <span className="hint">{MATCH_LABELS[target.matchStatus]}</span> : null}
      {logHint ? <span className="hint">{logHint}</span> : null}
      {tracked && target?.targetKey === tracked.targetKey ? <span className="hint">{({ queued: 'Команда очікує агента', dispatched: 'Команда виконується', succeeded: 'Команду завершено', failed: 'Помилка команди', rejected: 'Команду відхилено', expired: 'Дедлайн минув', unknown: 'Потрібна перевірка результату' })[tracked.status]}</span> : null}
    </div>;
  };

  return (
    <section className="card services-card" aria-labelledby="apps-title">
      {children(canControl || canLogs ? renderActions : undefined)}
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
        </>
      ) : null}

      {tracked ? (
        <p ref={statusRef} tabIndex={-1} className={`notice ${tracked.status === 'succeeded' ? '' : 'notice--warning'}`} role="status" aria-live="polite">
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

      {logView ? (
        <LogViewer key={`${serverId}:${logView.targetKey}`} serverId={serverId} serverName={serverName}
          targetKey={logView.targetKey} name={logView.name} onClose={closeLogs} />
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
