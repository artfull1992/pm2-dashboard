// In-memory InventoryStore with the PostgreSQL store's ordering contract. Real SQL semantics (locks, upsert,
// concurrency, constraints, freshness) are covered in backend/test/db/inventory.test.ts.
import type { ApplicationCursor, InventoryProcess, InventoryReport, ProcessStatus } from '../../src/servers/inventory.js';
import { encodeCursor } from '../../src/servers/inventory.js';
import type { ApplicationItem, InventoryInfo, InventoryStore } from '../../src/servers/inventory-store.js';
import type { FakeServerStore } from './fake-server-store.js';

interface Row {
  source: string | null; state: 'ok' | 'stale' | 'unavailable'; reason: string | null; reportedAt: Date; reportCapturedAt: Date | null;
  capturedAt: Date | null; collectedAt: Date | null; processes: InventoryProcess[];
}

export class FakeInventoryStore implements InventoryStore {
  readonly rows = new Map<string, Row>();
  failing = false;
  calls = 0;
  /** Resolves before the write; lets tests hold a request in flight. */
  gate: Promise<void> | null = null;

  constructor(private readonly servers: FakeServerStore) {}

  async recordInventory({ tokenHash, report }: { tokenHash: Buffer; report: InventoryReport }) {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.failing) throw Object.assign(new Error('connect ECONNREFUSED synthetic'), { code: 'ECONNREFUSED' });
    const agent = await this.servers.resolveAgent(tokenHash);
    if (!agent) return 'unauthorized' as const;
    const receivedAt = new Date();
    const row = this.rows.get(agent.serverId);
    const captured = report.capturedAt ? new Date(report.capturedAt) : null;
    if (row && captured && row.reportCapturedAt && captured < row.reportCapturedAt) return { serverId: agent.serverId, receivedAt, status: 'ignored' as const };
    const base: Row = row ?? { source: null, state: 'unavailable', reason: null, reportedAt: receivedAt, reportCapturedAt: null, capturedAt: null, collectedAt: null, processes: [] };
    const next: Row = { ...base, state: report.state, reason: report.reason, reportedAt: receivedAt, source: report.source ?? base.source, reportCapturedAt: captured ?? base.reportCapturedAt };
    if (report.state === 'ok' && !(base.capturedAt && captured && base.capturedAt.getTime() === captured.getTime())) {
      Object.assign(next, { capturedAt: captured, collectedAt: receivedAt, processes: report.processes });
    }
    this.rows.set(agent.serverId, next);
    return { serverId: agent.serverId, receivedAt, status: 'accepted' as const };
  }

  private items(serverId: string, row: Row): ApplicationItem[] {
    const server = this.servers.servers.find((s) => s.id === serverId);
    const state = row.state === 'unavailable' ? 'unavailable' : row.state === 'stale' ? 'stale' : 'current';
    return row.processes.map((p) => ({
      key: `${serverId}:${row.source ?? ''}:${String(p.pmId)}`, serverId, serverName: server?.name ?? '?', serverStatus: 'online',
      source: row.source ?? '', pmId: p.pmId, name: p.name, status: p.status, uptimeSeconds: p.uptimeSeconds, restarts: p.restarts,
      cpuPercent: p.cpuPercent, memoryBytes: p.memoryBytes, execMode: p.execMode, firstSeenAt: (row.collectedAt ?? new Date()).toISOString(),
      inventoryState: state, capturedAt: row.capturedAt?.toISOString() ?? null, collectedAt: row.collectedAt?.toISOString() ?? null,
    }));
  }

  /** Scope each read was asked for (ADR-028: null = admin/global, else the user id). */
  scopes: (string | null | undefined)[] = [];

  listApplications({ limit, cursor, serverId, status, q = null, context = null, scope }: { limit: number; cursor: ApplicationCursor | null; serverId: string | null; status: ProcessStatus | null; q?: string | null; context?: string | null; scope?: string | null }) {
    if (this.failing) return Promise.reject(new Error('synthetic'));
    this.scopes.push(scope);
    const all = [...this.rows.entries()].flatMap(([id, row]) => this.items(id, row))
      .filter((a) => (serverId === null || a.serverId === serverId) && (status === null || a.status === status) && (q === null || a.name.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => a.name.localeCompare(b.name) || a.serverId.localeCompare(b.serverId) || a.pmId - b.pmId)
      .filter((a) => !cursor || a.name > cursor.name || (a.name === cursor.name && (a.serverId > cursor.serverId || (a.serverId === cursor.serverId && a.pmId > cursor.pmId))));
    const items = all.slice(0, limit);
    const last = items.at(-1);
    return Promise.resolve({ items, nextCursor: all.length > limit && last ? encodeCursor({ name: last.name, serverId: last.serverId, pmId: last.pmId, context }) : null });
  }

  serverApplications(serverId: string, scope?: string | null) {
    if (this.failing) return Promise.reject(new Error('synthetic'));
    this.scopes.push(scope);
    if (!this.servers.servers.some((s) => s.id === serverId)) return Promise.resolve(null);
    const row = this.rows.get(serverId);
    const inventory: InventoryInfo = row
      ? {
          state: row.state === 'ok' ? 'current' : row.state, reason: row.reason, source: row.source, capturedAt: row.capturedAt?.toISOString() ?? null,
          collectedAt: row.collectedAt?.toISOString() ?? null, reportedAt: row.reportedAt.toISOString(), processCount: row.collectedAt ? row.processes.length : null,
        }
      : { state: 'not_reported', reason: null, source: null, capturedAt: null, collectedAt: null, reportedAt: null, processCount: null };
    return Promise.resolve({ serverId, serverStatus: 'online' as const, inventory, items: row ? this.items(serverId, row) : [] });
  }
}
