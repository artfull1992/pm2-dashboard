import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApplicationItem, InventoryInfo, ProcessStatus, ServerStatus } from '../api/types';
import { formatDate, StatusBadge } from '../pages/ServersPage';
import { StatusIndicator, type Tone } from './ui';

// Read-only PM2 inventory views (ADR-016). All values are rendered as React text (never as HTML). Freshness is
// always explicit: data that is not `current`, or that belongs to an offline server, is labelled as such.

export const PROCESS_STATUS_LABELS: Record<ProcessStatus, string> = {
  online: 'Працює', stopping: 'Зупиняється', stopped: 'Зупинено', launching: 'Запускається', errored: 'Помилка',
  'one-launch-status': 'Одноразовий запуск', 'waiting restart': 'Очікує перезапуску', unknown: 'Невідомо',
};

export const REASON_LABELS: Record<string, string> = {
  daemon_not_running: 'PM2 daemon не запущено',
  permission_denied: 'немає доступу',
  timeout: 'PM2 не відповів вчасно',
  protocol_error: 'неочікувана відповідь PM2',
  invalid_data: 'некоректні дані PM2',
  too_many_processes: 'забагато процесів',
  pm2_home_invalid: 'некоректний PM2_HOME',
  snapshot_missing: 'файл inventory відсутній',
  snapshot_invalid: 'файл inventory некоректний',
  snapshot_insecure: 'файл inventory має небезпечні права',
};

export const reasonLabel = (reason: string | null) => (reason ? REASON_LABELS[reason] ?? 'невідома причина' : '');

// Normal is quiet; a process that should be running but is not stands out; transitions/unknown stay neutral.
const PROCESS_TONES: Record<ProcessStatus, Tone> = {
  online: 'ok', errored: 'bad', stopped: 'warn', 'waiting restart': 'warn', stopping: 'muted', launching: 'muted', 'one-launch-status': 'muted', unknown: 'muted',
};

export function ProcessStatusBadge({ status }: { status: ProcessStatus }) {
  return <StatusIndicator tone={PROCESS_TONES[status]}>{PROCESS_STATUS_LABELS[status]}</StatusIndicator>;
}

const FRESHNESS_LABELS = { current: 'Актуально', stale: 'Застарілі дані', unavailable: 'Exporter недоступний' } as const;

/** Freshness of one row: the inventory state, downgraded when the server itself is not online. */
export function FreshnessBadge({ state, serverStatus }: { state: ApplicationItem['inventoryState']; serverStatus: ServerStatus }) {
  if (state === 'current' && serverStatus !== 'online') return <StatusIndicator tone="warn">Сервер офлайн</StatusIndicator>;
  return <StatusIndicator tone={state === 'current' ? 'muted' : 'warn'}>{FRESHNESS_LABELS[state]}</StatusIndicator>;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days > 0 ? `${String(days)} д ` : ''}${String(hours)} год ${String(minutes)} хв`;
}

export function formatMemory(bytes: number | null): string {
  if (bytes === null) return '—';
  const mib = bytes / 1024 ** 2;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} ГіБ` : `${mib.toFixed(0)} МіБ`;
}

export const formatCpu = (cpu: number | null) => (cpu === null ? '—' : `${cpu.toFixed(1)} %`);
export const formatCount = (n: number | null) => (n === null ? '—' : String(n));

export function ApplicationsTable({ items, showServer, caption, renderActions }: { items: ApplicationItem[]; showServer: boolean; caption: string; renderActions?: ((app: ApplicationItem) => ReactNode) | undefined }) {
  // Every row live and collected at the same moment: that moment is shown once above the table, rows show only the
  // state. Any difference (another time, stale data, offline server) keeps the time in each row.
  const uniform = items.every((a) => a.inventoryState === 'current' && a.serverStatus === 'online')
    && new Set(items.map((a) => a.collectedAt)).size === 1;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Назва</th>
            {showServer ? <th scope="col">Сервер</th> : null}
            <th scope="col">PM2 id</th>
            <th scope="col">Статус</th>
            <th scope="col" className="num">Аптайм*</th>
            <th scope="col" className="num">Рестарти</th>
            <th scope="col" className="num">CPU*</th>
            <th scope="col" className="num">Пам'ять*</th>
            <th scope="col">Дані</th>
            {renderActions ? <th scope="col">Дії</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((app) => {
            const live = app.inventoryState === 'current' && app.serverStatus === 'online';
            return (
              <tr key={app.key}>
                <th scope="row" className="mono">{app.name}</th>
                {showServer ? (
                  <td>
                    <Link to={`/servers/${app.serverId}`}>{app.serverName}</Link>
                    {app.serverStatus === 'online' ? null : <span className="cell-meta"><StatusBadge status={app.serverStatus} /></span>}
                  </td>
                ) : null}
                <td className="secondary nowrap">{app.pmId}{app.execMode ? ` · ${app.execMode}` : ''}</td>
                <td><ProcessStatusBadge status={app.status} /></td>
                <td className="num">{formatUptime(app.uptimeSeconds)}</td>
                <td className="num">{formatCount(app.restarts)}</td>
                <td className="num">{formatCpu(app.cpuPercent)}</td>
                <td className="num">{formatMemory(app.memoryBytes)}</td>
                <td>
                  <FreshnessBadge state={app.inventoryState} serverStatus={app.serverStatus} />
                  {uniform ? null : <span className={`cell-meta${live ? '' : ' cell-meta--strong'}`}>зібрано {formatDate(app.collectedAt)}</span>}
                </td>
                {renderActions ? <td>{renderActions(app)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="table-note">* значення на момент збору; «—» — метрика невідома (не нуль). CPU за PM2 на кількох ядрах може перевищувати 100 %.</p>
    </div>
  );
}

/** Human summary of a server's inventory integration; never presents stale data as live. */
export function InventorySummary({ inventory, serverStatus }: { inventory: InventoryInfo; serverStatus: ServerStatus }) {
  const collected = formatDate(inventory.collectedAt);
  let text: string;
  switch (inventory.state) {
    case 'not_reported':
      text = 'Агент ще не передавав inventory PM2 (exporter не налаштований або агент без підтримки inventory).';
      break;
    case 'unavailable':
      text = `Inventory недоступний: ${reasonLabel(inventory.reason)}.${inventory.collectedAt ? ` Нижче — останні зібрані дані від ${collected}, вони можуть бути неактуальні.` : ''}`;
      break;
    case 'stale':
      text = inventory.collectedAt ? `Дані застарілі: останній збір ${collected}.` : 'Exporter давно не оновлював дані; зібраних даних ще немає.';
      break;
    case 'current':
      text = `Актуально: зібрано ${collected}${inventory.processCount === 0 ? ', PM2 не має процесів' : ''}.`;
      break;
  }
  const offline = serverStatus !== 'online' && inventory.state !== 'not_reported';
  if (inventory.state === 'current' && !offline) {
    // Normal case: one quiet line, shared by every row of this server.
    return (
      <p className="freshness" role="status">
        <StatusIndicator tone="ok">{text}</StatusIndicator>
        {inventory.reportedAt ? <span>{`Останній звіт агента: ${formatDate(inventory.reportedAt)}`}</span> : null}
      </p>
    );
  }
  return (
    <div className="notice notice--warning" role="status">
      <p>{text}</p>
      {offline ? <p>Сервер зараз не онлайн — показані дані не відображають поточний стан.</p> : null}
      {inventory.reportedAt ? <p className="hint">Останній звіт агента: {formatDate(inventory.reportedAt)}</p> : null}
    </div>
  );
}
