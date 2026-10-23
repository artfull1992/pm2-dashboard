import type { ReactNode } from 'react';
import type { ApplicationItem } from '../api/types';
import { currentState, freshness, lastKnown, listMetrics } from './appState';
import { formatCpu, formatMemory } from './Inventory';
import { StatusIndicator } from './ui';

// Compact applications list of the workspace (redesign B, design reference 1.0: APP-01, APP-13, APP-16). One row = one
// button: name with the server under it, the current state, CPU, RAM and a short uptime. The row height is 56 px on a
// wide desktop and 48 px on a compact one (1280–1400 px), divider included; on a narrow list (phone) only name/server,
// state and RAM remain — CPU and uptime are in the details. The row has no other interactive content, so selecting it
// is one unambiguous action. The selected row: tinted background, a 3 px accent bar (a shape, not colour alone) and
// aria-current. A truncated name stays complete in the accessible name and the tooltip.

/** Identity of a selected process: the API key alone is not enough (a PM2 id can be reused by another process). */
export const appIdentity = (app: Pick<ApplicationItem, 'key' | 'serverId' | 'source' | 'name'>) => `${app.serverId}|${app.source}|${app.key}|${app.name}`;

/** Short uptime: the two largest units, a zero second unit left out («12 год», «3 д 14 год»). */
export function formatUptimeShort(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${String(days)} д ${String(hours)} год` : `${String(days)} д`;
  if (hours > 0) return minutes > 0 ? `${String(hours)} год ${String(minutes)} хв` : `${String(hours)} год`;
  return `${String(minutes)} хв`;
}

/** The row describes the live state only when the inventory is current and its server is online. */
export const isLive = (app: ApplicationItem) => freshness(app) === 'live';

const DASH = '—';

function rowLabel(app: ApplicationItem): string {
  const state = currentState(app);
  const known = lastKnown(app);
  const metrics = listMetrics(app);
  return `${app.name} на ${app.serverName}: ${state.label}${known ? ` (останній відомий стан: ${known})` : ''}, `
    + `CPU ${metrics ? formatCpu(app.cpuPercent) : DASH}, RAM ${metrics ? formatMemory(app.memoryBytes) : DASH}, `
    + `час роботи ${metrics ? formatUptimeShort(app.uptimeSeconds) : DASH}`;
}

/** Column headings of the list (decorative: every row button carries its own full description). */
export function ListHead() {
  return (
    <div className="app-list__head" aria-hidden="true">
      <span>Застосунок</span>
      <span>Стан</span>
      <span className="num app-col--cpu">CPU</span>
      <span className="num">RAM</span>
      <span className="num app-col--uptime">Час роботи</span>
    </div>
  );
}

/** Placeholder rows while the first page loads (no process is invented). */
export function ListSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <ul className="app-list__rows app-list__rows--loading" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <span className="app-row app-row--skeleton">
            <span className="app-row__main"><span className="app-row__name">Завантаження…</span><span className="app-row__sub">—</span></span>
            <span className="skeleton" /><span className="skeleton app-col--cpu" /><span className="skeleton" /><span className="skeleton app-col--uptime" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A centred message inside a panel (empty list, nothing selected, loading). */
export function PanelMessage({ symbol, title, children }: { symbol: string; title: string; children?: ReactNode }) {
  return (
    <div className="panel-message">
      <div>
        <span className="panel-message__symbol" aria-hidden="true">{symbol}</span>
        <h2 className="panel-message__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ApplicationList({ items, selected, onSelect, label }: {
  items: ApplicationItem[];
  /** appIdentity of the selected process (it may be on another page or outside the filter). */
  selected: string | null;
  onSelect: (app: ApplicationItem) => void;
  label: string;
}) {
  return (
    <>
      <ListHead />
      <ul className="app-list__rows" aria-label={label}>
        {items.map((app) => {
          const id = appIdentity(app);
          const current = id === selected;
          const state = currentState(app);
          const metrics = listMetrics(app);
          return (
            <li key={id}>
              <button type="button" className={`app-row${current ? ' app-row--selected' : ''}`} data-app-row={id}
                aria-current={current ? 'true' : undefined} aria-label={rowLabel(app)} title={`${app.name} · ${app.serverName}`}
                onClick={() => { onSelect(app); }}>
                <span className="app-row__main">
                  <span className="app-row__name">{app.name}</span>
                  <span className="app-row__sub">{app.serverName}</span>
                </span>
                <span className="app-row__status"><StatusIndicator tone={state.tone}>{state.label}</StatusIndicator></span>
                <span className="app-row__metric num app-col--cpu">{metrics ? formatCpu(app.cpuPercent) : DASH}</span>
                <span className="app-row__metric num">{metrics ? formatMemory(app.memoryBytes) : DASH}</span>
                <span className="app-row__metric num app-col--uptime">{metrics ? formatUptimeShort(app.uptimeSeconds) : DASH}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
