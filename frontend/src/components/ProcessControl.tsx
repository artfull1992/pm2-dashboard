import { type ReactNode, useCallback, useState } from 'react';
import { controlApi, logsApi } from '../api/client';
import { type ApplicationItem, FINAL_COMMAND_STATUSES } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../pages/ServersPage';
import { ActionMenu } from './ActionMenu';
import { LogViewer } from './LogViewer';
import { ACTION_LABELS, COMMAND_HINTS, CommandStatusList, commandStatusText, controlBlocker, logsBlocker, rowMenu, useProcessCommands } from './processActions';
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
    const { items, reasons, rowReasons } = rowMenu({
      app, canControl, canLogs, control, logs, busy: target ? isBusy(serverId, target.targetKey) : false, limitReached,
      onAction: (t, action) => { ask({ serverId, serverName, target: t, action }); },
      onLogs: (t) => { setLogView({ targetKey: t.targetKey, name: app.name }); },
    });
    const last = target ? tracked.find((t) => t.command.serverId === serverId && t.command.targetKey === target.targetKey) : undefined;
    // One compact control per row: the "Дії" menu (with the reasons inside), or — with nothing to offer for a reason of
    // THIS process — one keyboard-reachable "Недоступно" that explains it. Server-wide causes are shown once above.
    return <div className="service-actions">
      {/* With a reason the trigger stays usable even if every item is disabled: the explanation must be reachable. */}
      {items.length > 0 ? <ActionMenu name={app.name} items={items} note={reasons.join('. ') || null} {...(reasons.length > 0 ? { disabled: false } : {})} />
        : rowReasons.length > 0 ? <ActionMenu name={app.name} items={[]} note={reasons.join('. ')} disabled={false} label="Недоступно" ariaLabel={`Чому недоступно: ${app.name}`} subtle /> : null}
      {last && FINAL_COMMAND_STATUSES.includes(last.command.status) ? <span className="hint">{COMMAND_HINTS[last.command.status]}</span> : null}
    </div>;
  };

  return (
    <section className="section" aria-labelledby="apps-title">
      {children(canControl || canLogs ? renderActions : undefined)}
      {view.state.status === 'loading' ? <LoadingState /> : null}
      {view.state.status === 'error' ? <ErrorState title="Не вдалося оновити стан керування" onRetry={view.reload}>{`Сервіс тимчасово недоступний.${formatRetry(view.state.retryAfterSeconds)}`}</ErrorState> : null}
      {/* Server-wide causes, once, and only for roles that have these actions (a viewer's read-only view is normal). */}
      {current && canControl ? (() => {
        const blocker = controlBlocker(current);
        const when = current.broker && (current.broker.state !== 'ok' || !current.broker.fresh) ? ` (останній звіт ${formatDate(current.broker.reportedAt)})` : '';
        return <>
          {blocker ? <p className={`notice${current.enabled ? ' notice--warning' : ''}`} role="status">{`${blocker}${when}.`}</p> : null}
          {current.broker?.total !== null && current.broker?.total !== undefined && current.broker.total > CONTROL_TARGETS_MAX ? (
            <p className="notice notice--warning" role="status">{`На сервері ${String(current.broker.total)} процесів PM2 — керування доступне лише для перших ${String(CONTROL_TARGETS_MAX)} за іменем.`}</p>
          ) : null}
          {current.broker && !blocker ? <p className="hint">{current.broker.mode === 'auto'
            ? 'Broker у режимі auto: доступні всі процеси власника PM2; що саме вам дозволено, визначають роль і надані доступи.'
            : 'Broker у режимі allowlist: керувати можна лише процесами з локального allowlist сервера.'}</p> : null}
        </>;
      })() : null}
      {canLogs && logsBlocker(logs) ? <p className="notice" role="status">{`${logsBlocker(logs) ?? ''}.`}</p> : null}

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
