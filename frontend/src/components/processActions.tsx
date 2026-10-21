import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, controlApi } from '../api/client';
import { type ApplicationItem, CONTROL_ACTIONS, type CommandView, type ControlAction, type ControlTarget, type ControlView, FINAL_COMMAND_STATUSES, type LogTarget, type LogTargetsView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import type { MenuItem } from './ActionMenu';
import { Dialog } from './Dialog';
import { formatRetry } from './StatusMessage';

// Shared process actions (ADR-017/018) of the server page and the all-applications list: what a row may do, the
// confirmation and the command lifecycle. Every operation is addressed by serverId + a broker-confirmed targetKey,
// never by the visible name or PM2 id alone. A control POST is never retried automatically; "accepted" is not "done".

/** Target keys of an auto broker (ADR-028) are derived from the name — technical, not shown to people. */
const AUTO_KEY_RE = /^n-[0-9a-f]{24}$/;

export const ACTION_LABELS: Record<ControlAction, string> = { start: 'Запустити', stop: 'Зупинити', restart: 'Перезапустити' };
const ACTION_VERBS: Record<ControlAction, string> = { start: 'запуск', stop: 'зупинку', restart: 'перезапуск' };

export const MATCH_LABELS: Record<ControlTarget['matchStatus'], string> = {
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

export const COMMAND_HINTS: Record<CommandView['status'], string> = {
  queued: 'Команда очікує агента', dispatched: 'Команда виконується', succeeded: 'Команду завершено', failed: 'Помилка команди',
  rejected: 'Команду відхилено', expired: 'Дедлайн минув', unknown: 'Потрібна перевірка результату',
};

function controlError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'conflict') return 'Дію зараз неможливо виконати: керування вимкнене, ціль недоступна, сервер офлайн або вже виконується інша команда.';
    if (error.kind === 'forbidden') return 'Недостатньо прав для керування процесами.';
    if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'unavailable') {
      return `Відповідь не отримано — команда могла бути створена. Перевірте стан команди; повторна спроба в цьому ж вікні не створить дубліката.${formatRetry(error.retryAfterSeconds)}`;
    }
  }
  return 'Неочікувана помилка. Перевірте стан команди.';
}

/** Control is possible on this server right now (API switch, online, fresh broker report with a valid allowlist). */
export function controlReady(view: ControlView | null): boolean {
  return view !== null && view.enabled && view.serverStatus === 'online' && view.broker?.state === 'ok' && view.broker.daemon === 'ok' && view.broker.allowlist === 'ok' && view.broker.fresh;
}

/** The single broker-confirmed control target of an inventory row: name AND PM2 id must agree, exactly one match. */
export function controlTargetFor(app: ApplicationItem, view: ControlView | null): ControlTarget | undefined {
  const candidates = view?.targets.filter((t) => t.name === app.name && t.pmId === app.pmId) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The single confirmed log target of a row (never inferred from the inventory). */
export function logTargetFor(app: ApplicationItem, logs: LogTargetsView | null): LogTarget | undefined {
  const candidates = logs?.targets.filter((t) => t.name === app.name && t.pmId === app.pmId) ?? [];
  return logs?.state === 'supported' && candidates.length === 1 && candidates[0]?.matchStatus === 'ok' ? candidates[0] : undefined;
}

export interface RowMenuInput {
  app: ApplicationItem;
  canControl: boolean;
  canLogs: boolean;
  /** Control view of the row's server (null: unknown or failed to load). */
  control: ControlView | null;
  /** Log targets of the row's server (null: unknown or failed to load). */
  logs: LogTargetsView | null;
  /** A command for this very target is being sent or has not finished yet. */
  busy: boolean;
  /** As many commands as can be followed are still running: no new command until one of them is final. */
  limitReached?: boolean;
  onAction: (target: ControlTarget, action: ControlAction) => void;
  onLogs: (target: LogTarget) => void;
}

export interface RowMenu { items: MenuItem[]; reasons: string[] }

/**
 * Items of a row's "Дії" menu in a fixed order (start, stop, restart, logs) with the reasons why something is not
 * offered or not usable. Only actions the broker allows for the confirmed target are listed. The server stays the
 * final authority — this only decides what the UI offers.
 */
export function rowMenu({ app, canControl, canLogs, control, logs, busy, limitReached = false, onAction, onLogs }: RowMenuInput): RowMenu {
  const items: MenuItem[] = [];
  const reasons: string[] = [];
  if (canControl) {
    const view = control && control.serverId === app.serverId ? control : null;
    const ready = controlReady(view);
    const target = controlTargetFor(app, view);
    const named = view?.targets.find((t) => t.name === app.name);
    const live = app.inventoryState === 'current' && app.serverStatus === 'online';
    if (target) {
      const blocked = !live || !ready || target.matchStatus !== 'ok' || busy || limitReached;
      for (const action of CONTROL_ACTIONS) {
        if (!target.actions.includes(action)) continue;
        items.push({ key: action, label: ACTION_LABELS[action], danger: action === 'stop', disabled: blocked, onSelect: () => { onAction(target, action); } });
      }
      if (!ready) reasons.push('Керування зараз недоступне');
      else if (target.matchStatus !== 'ok') reasons.push(MATCH_LABELS[target.matchStatus]);
      else if (!live) reasons.push('Потрібні актуальні дані');
      if (busy) reasons.push('Команда для цього процесу ще виконується');
      else if (limitReached) reasons.push(LIMIT_TEXT);
    } else {
      // Without a ready broker report the targets are unknown: say so instead of claiming the process is not allowed.
      reasons.push(!ready ? 'Керування зараз недоступне'
        : named && named.matchStatus !== 'ok' ? MATCH_LABELS[named.matchStatus] : named ? 'Ідентичність процесу не підтверджена' : 'Не дозволено керування');
    }
  }
  if (canLogs) {
    const lv = logs && logs.serverId === app.serverId ? logs : null;
    const logTarget = logTargetFor(app, lv);
    if (logTarget) items.push({ key: 'logs', label: 'Переглянути логи', disabled: false, onSelect: () => { onLogs(logTarget); } });
    else if (lv) {
      reasons.push(lv.state === 'unsupported' ? 'Перегляд логів не підтримується: потрібні оновлені Agent і broker'
        : lv.state === 'not_connected' ? 'Логи: агент не на зв’язку'
          : lv.state === 'broker_unavailable' ? 'Логи тимчасово недоступні' : 'Логи не дозволені');
    }
  }
  return { items, reasons };
}

export interface CommandRequest { serverId: string; serverName: string; target: ControlTarget; action: ControlAction }
export interface TrackedCommand { serverName: string; name: string; command: CommandView }

const newKey = () => crypto.randomUUID();
/** Commands followed at the same time (one GET each per interval). An accepted command is never dropped for a new one. */
export const MAX_ACTIVE_COMMANDS = 5;
/** Finished commands kept on screen (newest first); only this history is trimmed. */
export const MAX_FINISHED_COMMANDS = 5;
const TRACK_INTERVAL_MS = 2000;
export const LIMIT_TEXT = `Уже виконується ${String(MAX_ACTIVE_COMMANDS)} команд — нова стане доступною, коли одна з них завершиться`;

const isActive = (t: TrackedCommand) => !FINAL_COMMAND_STATUSES.includes(t.command.status);

/** Keeps every active command and only the newest finished ones; order (newest first) is preserved. */
function bounded(list: TrackedCommand[]): TrackedCommand[] {
  let finished = 0;
  return list.filter((t) => isActive(t) || ++finished <= MAX_FINISHED_COMMANDS);
}

/**
 * Confirmation + command lifecycle, bound to the session that started it (callers also remount per session).
 * - the POST goes out only from the confirmation, once; a user retry in the same dialog reuses the idempotency key;
 * - `verify` (optional) re-checks the capabilities right before the POST and can stop it with a reason;
 * - a late answer of an aborted/old request or of an ended session changes nothing;
 * - each accepted command is followed until its final, server-confirmed status (several targets in parallel); it is
 *   never dropped from tracking for a newer one. With MAX_ACTIVE_COMMANDS still running, no new POST is sent (the
 *   dialog stays open with its key, so a later explicit retry is still idempotent); a final status frees the slot.
 */
export function useProcessCommands({ onChanged, verify }: {
  /** The server's processes may have changed: a command was accepted or reached its final status. */
  onChanged: (serverId: string) => void;
  verify?: ((request: CommandRequest, signal: AbortSignal) => Promise<string | null>) | undefined;
}) {
  const { state: auth, sessionExpired, bindSession } = useAuth();
  const [confirm, setConfirm] = useState<(CommandRequest & { key: string }) | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<TrackedCommand[]>([]);
  const inflight = useRef<AbortController | null>(null);
  // Synchronous guard against a second click before `pending` re-renders the button as disabled.
  const sending = useRef(false);
  const latest = useRef({ onChanged, sessionExpired });
  useEffect(() => { latest.current = { onChanged, sessionExpired }; });
  useEffect(() => () => { inflight.current?.abort(); }, []);

  const ask = useCallback((request: CommandRequest) => { setError(null); setConfirm({ ...request, key: newKey() }); }, []);
  const cancel = useCallback(() => { if (!pending) setConfirm(null); }, [pending]);

  const activeCount = tracked.filter(isActive).length;
  const limitReached = activeCount >= MAX_ACTIVE_COMMANDS;

  const run = async () => {
    if (!confirm || auth.status !== 'authenticated' || sending.current) return;
    if (limitReached) { setError(`${LIMIT_TEXT}. Команду не надіслано.`); return; }
    sending.current = true;
    const binding = bindSession();
    const controller = new AbortController();
    inflight.current = controller;
    const stale = () => controller.signal.aborted || !binding.current();
    setPending(true);
    setError(null);
    try {
      const problem = verify ? await verify(confirm, controller.signal) : null;
      if (stale()) return;
      if (problem) { setError(problem); return; }
      const created = await controlApi.create(confirm.serverId, { targetKey: confirm.target.targetKey, action: confirm.action, idempotencyKey: confirm.key }, auth.session.csrfToken, controller.signal);
      if (stale()) return;
      setTracked((list) => bounded([{ serverName: confirm.serverName, name: confirm.target.name, command: created }, ...list.filter((t) => t.command.id !== created.id)]));
      setConfirm(null);
      latest.current.onChanged(confirm.serverId);
    } catch (e) {
      if (stale()) return;
      if (e instanceof ApiError && e.kind === 'unauthorized') { sessionExpired(); return; }
      setError(controlError(e));
    } finally {
      sending.current = false;
      if (!stale()) setPending(false);
    }
  };

  // Follow every non-final command (at most MAX_ACTIVE_COMMANDS, one GET each per interval). A failed read keeps the
  // command active — no final status is ever invented to free a slot.
  const open = tracked.filter(isActive).map((t) => t.command.id).join(',');
  useEffect(() => {
    if (!open) return undefined;
    const binding = bindSession();
    const controller = new AbortController();
    const timer = setInterval(() => {
      for (const id of open.split(',')) {
        controlApi.command(id, controller.signal).then(
          (c) => {
            if (controller.signal.aborted || !binding.current()) return;
            setTracked((list) => bounded(list.map((t) => (t.command.id === c.id ? { ...t, command: c } : t))));
            if (FINAL_COMMAND_STATUSES.includes(c.status)) latest.current.onChanged(c.serverId);
          },
          (e: unknown) => { if (e instanceof ApiError && e.kind === 'unauthorized' && binding.current()) latest.current.sessionExpired(); },
        );
      }
    }, TRACK_INTERVAL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [open, bindSession]);

  /** A command for this target is being sent or is not final yet (the API allows one active command per target). */
  const isBusy = useCallback((serverId: string, targetKey: string) => (pending && confirm?.serverId === serverId && confirm.target.targetKey === targetKey)
    || tracked.some((t) => t.command.serverId === serverId && t.command.targetKey === targetKey && isActive(t)), [pending, confirm, tracked]);

  const dialog = confirm ? (
    <Dialog
      title={`${ACTION_LABELS[confirm.action]} процес?`}
      onClose={cancel}
      dismissible={!pending}
      actions={(
        <>
          <button type="button" className="button" disabled={pending} onClick={cancel}>Скасувати</button>
          <button type="button" className={`button ${confirm.action === 'stop' ? 'button--danger' : 'button--primary'}`} disabled={pending} onClick={() => { void run(); }}>
            {pending ? 'Надсилання…' : ACTION_LABELS[confirm.action]}
          </button>
        </>
      )}
    >
      <p>{`Підтвердьте ${ACTION_VERBS[confirm.action]} процесу «${confirm.target.name}»${AUTO_KEY_RE.test(confirm.target.targetKey) ? '' : ` (${confirm.target.targetKey})`} на сервері «${confirm.serverName}».`}</p>
      {confirm.action !== 'start' ? <p className="hint">Застосунок буде недоступний, доки процес не запуститься знову.</p> : null}
      {error ? <p className="field__error" role="alert">{error}</p> : null}
    </Dialog>
  ) : null;

  return { ask, dialog, tracked, isBusy, limitReached };
}

/** Status lines of the followed commands; the newest one takes focus once (its row menu may be disabled now). */
export function CommandStatusList({ tracked, showServer }: { tracked: TrackedCommand[]; showServer: boolean }) {
  const first = useRef<HTMLParagraphElement>(null);
  const newest = tracked[0]?.command.id ?? null;
  useEffect(() => { if (newest) first.current?.focus(); }, [newest]);
  if (tracked.length === 0) return null;
  return (
    <div className="command-status">
      {tracked.map((t, i) => (
        <p key={t.command.id} ref={i === 0 ? first : undefined} tabIndex={-1} className={`notice ${t.command.status === 'succeeded' ? '' : 'notice--warning'}`} role="status" aria-live="polite">
          {`${ACTION_LABELS[t.command.action]} «${t.command.serviceName ?? t.command.targetKey}»${showServer ? ` на сервері «${t.serverName}»` : ''}: ${commandStatusText(t.command)}`}
        </p>
      ))}
    </div>
  );
}
