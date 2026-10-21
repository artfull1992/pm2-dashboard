import { type ReactNode, useCallback, useState } from 'react';
import { controlApi, logsApi } from '../api/client';
import { type ApplicationItem, FINAL_COMMAND_STATUSES } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../pages/ServersPage';
import { ActionMenu } from './ActionMenu';
import { LogViewer } from './LogViewer';
import { ACTION_LABELS, COMMAND_HINTS, CommandStatusList, commandStatusText, rowMenu, useProcessCommands } from './processActions';
import { ErrorState, formatRetry, LoadingState } from './StatusMessage';
import { usePolledResource } from './usePolledResource';

// Allowlisted PM2 control of one server page (ADR-017). Mounted per server and session (key) — nothing of another
// server/session is ever shown or acted upon. The row menu, confirmation and command lifecycle are shared with the
// all-applications list (processActions); this component adds the server's polled control/log views and history.

export { ACTION_LABELS, commandStatusText } from './processActions';
export type { MenuItem } from './ActionMenu';

export type RowActions = (app: ApplicationItem) => ReactNode;

/** Targets one broker report carries at most (ADR-028); a larger total is said, never cut silently. */
export const CONTROL_TARGETS_MAX = 500;

export function ProcessControl({ serverId, serverName, onFinished, children }: {
  serverId: string; serverName: string; onFinished: () => void;
  children: (actions: RowActions | undefined) => ReactNode;
}) {
  const { can } = useAuth();
  const loadView = useCallback((signal: AbortSignal) => controlApi.view(serverId, signal), [serverId]);
  const loadCommands = useCallback((signal: AbortSignal) => controlApi.commands(serverId, signal), [serverId]);
  const view = usePolledResource(loadView, serverId);
  const commands = usePolledResource(loadCommands, serverId);
  const reloadView = view.reload;
  const reloadCommands = commands.reload;
  const [logView, setLogView] = useState<{ targetKey: string; name: string } | null>(null);
  const closeLogs = useCallback(() => { setLogView(null); }, []);
  const canLogs = can('logs:read');
  const canControl = can('processes:control');
  // Log targets are fetched only for users who may read logs (ADR-018); others never ask.
  const loadLogTargets = useCallback((signal: AbortSignal) => (canLogs ? logsApi.targets(serverId, signal) : Promise.resolve(null)), [serverId, canLogs]);
  const logTargets = usePolledResource(loadLogTargets, `${serverId}:${String(canLogs)}`);

  const onChanged = useCallback(() => { reloadCommands(); reloadView(); onFinished(); }, [reloadCommands, reloadView, onFinished]);
  const { ask, dialog, tracked, isBusy, limitReached } = useProcessCommands({ onChanged });

  const v = view.state.status === 'ready' ? view.state.data : view.state.status === 'error' ? view.state.data : null;
  const current = v && v.serverId === serverId ? v : null;
  // A control view kept from before a failed refresh is not a basis for actions.
  const control = view.state.status === 'ready' ? current : null;
  const list = commands.state.status === 'ready' ? commands.state.data : commands.state.status === 'error' ? commands.state.data : null;
  const lt = logTargets.state.status === 'ready' ? logTargets.state.data : null;
  const logs = lt && lt.serverId === serverId ? lt : null;

  const renderActions: RowActions = (app) => {
    const target = control?.targets.find((t) => t.name === app.name && t.pmId === app.pmId);
    const { items, reasons } = rowMenu({
      app, canControl, canLogs, control, logs, busy: target ? isBusy(serverId, target.targetKey) : false, limitReached,
      onAction: (t, action) => { ask({ serverId, serverName, target: t, action }); },
      onLogs: (t) => { setLogView({ targetKey: t.targetKey, name: app.name }); },
    });
    const last = target ? tracked.find((t) => t.command.serverId === serverId && t.command.targetKey === target.targetKey) : undefined;
    return <div className="service-actions">
      {items.length > 0 ? <ActionMenu name={app.name} items={items} note={reasons.join('. ') || null} /> : null}
      {reasons.map((r) => <span key={r} className="hint">{r}</span>)}
      {last && FINAL_COMMAND_STATUSES.includes(last.command.status) ? <span className="hint">{COMMAND_HINTS[last.command.status]}</span> : null}
    </div>;
  };

  return (
    <section className="section" aria-labelledby="apps-title">
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
          {current.broker?.allowlist === 'invalid' ? <p className="notice notice--warning" role="status">
            {current.broker.mode === 'auto' ? 'Broker у режимі auto відхиляє застарілий протокол — оновіть Agent.' : 'Локальний allowlist некоректний — усі дії відхиляються.'}
          </p> : null}
          {current.broker?.total !== null && current.broker?.total !== undefined && current.broker.total > CONTROL_TARGETS_MAX ? (
            <p className="notice notice--warning" role="status">{`На сервері ${String(current.broker.total)} процесів PM2 — керування доступне лише для перших ${String(CONTROL_TARGETS_MAX)} за іменем.`}</p>
          ) : null}
          {current.broker ? <p className="hint">{current.broker.mode === 'auto'
            ? 'Broker: режим auto — доступні всі процеси власника PM2; що саме вам дозволено, визначають роль і надані доступи.'
            : 'Broker: режим allowlist — доступні лише процеси з локального allowlist сервера.'}</p> : null}
          {current.enabled && current.serverStatus !== 'online' ? <p className="notice notice--warning" role="status">Сервер не онлайн — дії недоступні.</p> : null}
        </>
      ) : null}

      <CommandStatusList tracked={tracked} showServer={false} />

      {list && list.length > 0 ? (
        <details className="disclosure disclosure--plain">
          <summary>Останні команди</summary>
          <ul className="control-history">
            {list.map((c) => (
              <li key={c.id}><span className="hint num">{formatDate(c.requestedAt)}</span> {ACTION_LABELS[c.action]} <span className="mono">{c.serviceName ?? c.targetKey}</span> — {commandStatusText(c)}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {logView ? (
        <LogViewer key={`${serverId}:${logView.targetKey}`} serverId={serverId} serverName={serverName}
          targetKey={logView.targetKey} name={logView.name} onClose={closeLogs} />
      ) : null}

      {dialog}
    </section>
  );
}
