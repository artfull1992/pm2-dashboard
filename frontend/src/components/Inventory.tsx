import { Link } from 'react-router';
import type { ApplicationItem, InventoryInfo, ProcessStatus, ServerStatus } from '../api/types';
import { formatDate, StatusBadge } from '../pages/ServersPage';

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

export function ProcessStatusBadge({ status }: { status: ProcessStatus }) {
  const tone = status === 'online' ? 'online' : status === 'errored' ? 'errored' : 'never_connected';
  return <span className={`badge badge--${tone}`}>{PROCESS_STATUS_LABELS[status]}</span>;
}

const FRESHNESS_LABELS = { current: 'Актуально', stale: 'Застарілі дані', unavailable: 'Exporter недоступний' } as const;

/** Freshness of one row: the inventory state, downgraded when the server itself is not online. */
export function FreshnessBadge({ state, serverStatus }: { state: ApplicationItem['inventoryState']; serverStatus: ServerStatus }) {
  if (state === 'current' && serverStatus !== 'online') return <span className="badge badge--stale">Сервер офлайн</span>;
  return <span className={`badge badge--${state === 'current' ? 'online' : 'stale'}`}>{FRESHNESS_LABELS[state]}</span>;
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

export function ApplicationsTable({ items, showServer, caption }: { items: ApplicationItem[]; showServer: boolean; caption: string }) {
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
            <th scope="col">Аптайм*</th>
            <th scope="col">Рестарти</th>
            <th scope="col">CPU*</th>
            <th scope="col">Пам'ять*</th>
            <th scope="col">Дані</th>
          </tr>
        </thead>
        <tbody>
          {items.map((app) => (
            <tr key={app.key}>
              <th scope="row" className="mono">{app.name}</th>
              {showServer ? <td><Link to={`/servers/${app.serverId}`}>{app.serverName}</Link> <StatusBadge status={app.serverStatus} /></td> : null}
              <td>{app.pmId}{app.execMode ? <span className="hint"> · {app.execMode}</span> : null}</td>
              <td><ProcessStatusBadge status={app.status} /></td>
              <td>{formatUptime(app.uptimeSeconds)}</td>
              <td>{formatCount(app.restarts)}</td>
              <td>{formatCpu(app.cpuPercent)}</td>
              <td>{formatMemory(app.memoryBytes)}</td>
              <td><FreshnessBadge state={app.inventoryState} serverStatus={app.serverStatus} /><br /><span className="hint">зібрано {formatDate(app.collectedAt)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">* значення на момент збору; «—» — метрика невідома (не нуль).</p>
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
  return (
    <div className={`notice ${inventory.state === 'current' && !offline ? '' : 'notice--warning'}`} role="status">
      <p>{text}</p>
      {offline ? <p>Сервер зараз не онлайн — показані дані не відображають поточний стан.</p> : null}
      {inventory.reportedAt ? <p className="hint">Останній звіт агента: {formatDate(inventory.reportedAt)}</p> : null}
    </div>
  );
}
