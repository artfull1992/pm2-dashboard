import type { ApplicationItem } from '../api/types';
import { formatDate } from '../pages/ServersPage';
import { formatCpu, formatMemory, PROCESS_STATUS_LABELS, ProcessStatusBadge } from './Inventory';

// Compact applications list of the master-detail workspace (redesign B, stage 2). One row = one button with a fixed
// height (two text lines): name + server, status, CPU, memory, short uptime. The row has no other interactive content
// (no links or menus inside), so selecting it is one unambiguous action; the selected row is marked by a tinted
// background, an inset bar AND a visible marker, and by aria-current. A truncated name stays complete in the
// accessible name and the tooltip. The row's columns adapt to the list's own width (container queries), not the
// window: in a narrow list the metrics move to the second line instead of widening the page.

/** Identity of a selected process: the API key alone is not enough (a PM2 id can be reused by another process). */
export const appIdentity = (app: Pick<ApplicationItem, 'key' | 'serverId' | 'source' | 'name'>) => `${app.serverId}|${app.source}|${app.key}|${app.name}`;

/** Short uptime for list rows: the two largest units only (exact values are in the details). */
export function formatUptimeShort(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${String(days)} д ${String(hours)} год`;
  if (hours > 0) return `${String(hours)} год ${String(minutes)} хв`;
  return `${String(minutes)} хв`;
}

/** The row describes the live state only when the inventory is current and its server is online. */
export const isLive = (app: ApplicationItem) => app.inventoryState === 'current' && app.serverStatus === 'online';

/** Why a row's values are not live (null: they are). */
export function staleLabel(app: ApplicationItem): string | null {
  if (app.serverStatus !== 'online') return 'сервер офлайн';
  if (app.inventoryState === 'stale') return 'дані застарілі';
  if (app.inventoryState === 'unavailable') return 'exporter недоступний';
  return null;
}

function rowLabel(app: ApplicationItem): string {
  const stale = staleLabel(app);
  return `${app.name} на ${app.serverName}: ${PROCESS_STATUS_LABELS[app.status]}${stale ? ` (останні відомі дані, ${stale})` : ''}, `
    + `CPU ${formatCpu(app.cpuPercent)}, пам'ять ${formatMemory(app.memoryBytes)}, аптайм ${formatUptimeShort(app.uptimeSeconds)}`;
}

export function ApplicationList({ items, selected, onSelect, label, note }: {
  items: ApplicationItem[];
  /** appIdentity of the selected process (it may be on another page or outside the filter). */
  selected: string | null;
  onSelect: (app: ApplicationItem) => void;
  label: string;
  /** Footnote under the rows (inside the list card, outside its scroll area). */
  note?: string;
}) {
  return (
    <div className="app-list">
      <div className="app-list__head" aria-hidden="true">
        <span />
        <span>Назва · сервер</span>
        <span>Статус</span>
        <span className="num">CPU*</span>
        <span className="num">Пам'ять*</span>
        <span className="num app-list__uptime">Аптайм*</span>
      </div>
      <ul className="app-list__rows" aria-label={label}>
        {items.map((app) => {
          const id = appIdentity(app);
          const current = id === selected;
          const stale = staleLabel(app);
          return (
            <li key={id}>
              <button type="button" className={`app-row${current ? ' app-row--selected' : ''}`} data-app-row={id}
                aria-current={current ? 'true' : undefined} aria-label={rowLabel(app)} title={app.name}
                onClick={() => { onSelect(app); }}>
                <span className="app-row__marker" aria-hidden="true">{current ? '▸' : ''}</span>
                <span className="app-row__main">
                  <span className="app-row__name mono">{app.name}</span>
                  <span className="app-row__sub">
                    <span className="app-row__server">{app.serverName}</span>
                    {stale ? <span className="app-row__stale">{`⚠ ${stale} · ${formatDate(app.collectedAt)}`}</span> : null}
                    <span className="app-row__compact num">{`${formatCpu(app.cpuPercent)} · ${formatMemory(app.memoryBytes)} · ${formatUptimeShort(app.uptimeSeconds)}`}</span>
                  </span>
                </span>
                <span className="app-row__status"><ProcessStatusBadge status={app.status} /></span>
                <span className="app-row__metric num">{formatCpu(app.cpuPercent)}</span>
                <span className="app-row__metric num">{formatMemory(app.memoryBytes)}</span>
                <span className="app-row__metric num app-list__uptime">{formatUptimeShort(app.uptimeSeconds)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {note ? <p className="app-list__note">{note}</p> : null}
    </div>
  );
}
