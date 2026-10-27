import type { ReactNode } from 'react';
import type { ApplicationItem, InventoryInfo, ProcessStatus, ServerStatus } from '../api/types';
import { formatDate } from '../pages/ServersPage';
import { currentState, lastKnown, listMetrics } from './appState';
import { formatUptimeShort } from './ApplicationList';
import { StatusIndicator, type Tone } from './ui';

// Read-only PM2 inventory views (ADR-016). All values are rendered as React text (never as HTML). Freshness is
// always explicit: data that is not `current`, or that belongs to an offline server, is labelled as such.

export const PROCESS_STATUS_LABELS: Record<ProcessStatus, string> = {
  online: 'Працює', stopping: 'Зупиняється', stopped: 'Зупинено', launching: 'Запускається', errored: 'Помилка',
  'one-launch-status': 'Одноразовий запуск', 'waiting restart': 'Очікує перезапуску', unknown: 'Невідомо',
};

// Reason codes arrive from the API as strings: a Map of its own entries, so `constructor` or `__proto__` never hits an
// Object.prototype property; an unknown code reads as «невідома причина».
const REASON_LABELS: ReadonlyMap<string, string> = new Map(Object.entries({
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
}));

export const reasonLabel = (reason: string | null) => (reason ? REASON_LABELS.get(reason) ?? 'невідома причина' : '');

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

/**
 * PM2 processes of one server (server page, stage 3.1). Compact rows: name, PM2 id · mode, the CURRENT state through
 * the shared UI projection (appState: offline → «Невідомо», stale → «Застаріло»; never the last PM2 status as if it
 * were live), CPU / RAM / uptime only when they describe a running process with current data («—» otherwise, never
 * 0), restarts (cumulative) and the row's action menu. Freshness and collection time are said once above the table
 * (InventorySummary), not repeated on every row.
 */
export function ApplicationsTable({ items, caption, renderActions }: {
  items: ApplicationItem[]; caption: string;
  renderActions?: ((app: ApplicationItem) => ReactNode) | undefined;
}) {
  return (
    <div className="table-wrap">
      <table className="table table--dense">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Назва</th>
            <th scope="col">PM2 id · режим</th>
            <th scope="col">Стан</th>
            <th scope="col" className="num">CPU</th>
            <th scope="col" className="num">RAM</th>
            <th scope="col" className="num">Час роботи</th>
            <th scope="col" className="num">Рестарти, усього</th>
            {renderActions ? <th scope="col">Дії</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((app) => {
            const state = currentState(app);
            const known = lastKnown(app);
            const metrics = listMetrics(app);
            return (
              <tr key={app.key}>
                <th scope="row" className="table__name">{app.name}</th>
                <td className="secondary nowrap num">{app.pmId}{app.execMode ? ` · ${app.execMode}` : ''}</td>
                <td className="nowrap">
                  <StatusIndicator tone={state.tone}>{state.label}</StatusIndicator>
                  {known ? <span className="cell-meta">{`останній відомий: ${known}`}</span> : null}
                </td>
                <td className="num">{metrics ? formatCpu(app.cpuPercent) : '—'}</td>
                <td className="num">{metrics ? formatMemory(app.memoryBytes) : '—'}</td>
                <td className="num">{metrics ? formatUptimeShort(app.uptimeSeconds) : '—'}</td>
                <td className="num">{formatCount(app.restarts)}</td>
                {renderActions ? <td>{renderActions(app)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="table-note">CPU, RAM і час роботи — лише для процесу, що працює, з актуальними даними; «—» — значення невідоме (не нуль). CPU за PM2 на кількох ядрах може перевищувати 100 %.</p>
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
