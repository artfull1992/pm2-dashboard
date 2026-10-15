// In-memory ServerStore with the PostgreSQL store's contract (incl. atomic "transactions" with audit).
// Real SQL semantics (locks, upsert, concurrency) are covered in backend/test/db/servers.test.ts.
import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '../../src/auth/store.js';
import type { IncomingSnapshot, ServerSnapshot } from '../../src/servers/snapshot.js';
import { ONLINE_WINDOW_SECONDS, type ServerDetail, type ServerStore, type ServerSummary } from '../../src/servers/store.js';

interface FakeServer { id: string; name: string; isActive: boolean; createdAt: Date }
interface FakeCredential { serverId: string; tokenHash: string; revokedAt: Date | null }

export class FakeServerStore implements ServerStore {
  readonly servers: FakeServer[] = [];
  readonly credentials: FakeCredential[] = [];
  readonly heartbeats = new Map<string, { receivedAt: Date; snapshot: ServerSnapshot }>();
  readonly audit: (AuditEvent & { actorUserId: string })[] = [];
  failAudit = false;
  failing = false;
  heartbeatCalls = 0;

  private check(): void {
    if (this.failing) throw Object.assign(new Error('connect ECONNREFUSED synthetic'), { code: 'ECONNREFUSED' });
  }

  private summary(s: FakeServer): ServerSummary {
    const hb = this.heartbeats.get(s.id);
    const status = !hb ? 'never_connected' : Date.now() - hb.receivedAt.getTime() < ONLINE_WINDOW_SECONDS * 1000 ? 'online' : 'offline';
    return {
      id: s.id, name: s.name, isActive: s.isActive, createdAt: s.createdAt.toISOString(), status,
      lastSeenAt: hb ? hb.receivedAt.toISOString() : null,
      hasActiveCredential: this.credentials.some((c) => c.serverId === s.id && !c.revokedAt),
    };
  }

  private audited(entry: AuditEvent, actorUserId: string): void {
    if (this.failAudit) throw new Error('audit insert failed (synthetic)');
    this.audit.push({ ...entry, actorUserId });
  }

  list({ limit, afterId }: { limit: number; afterId: string | null }) {
    this.check();
    const start = afterId ? this.servers.findIndex((s) => s.id === afterId) + 1 : 0;
    const slice = this.servers.slice(start, start + limit + 1);
    const items = slice.slice(0, limit).map((s) => this.summary(s));
    return Promise.resolve({ items, nextAfterId: slice.length > limit ? (items.at(-1)?.id ?? null) : null });
  }

  get(id: string): Promise<ServerDetail | null> {
    this.check();
    const s = this.servers.find((x) => x.id === id);
    return Promise.resolve(s ? { ...this.summary(s), snapshot: this.heartbeats.get(id)?.snapshot ?? null } : null);
  }

  create({ name, actorUserId }: { name: string; actorUserId: string; requestId: string }) {
    this.check();
    if (this.servers.some((s) => s.name === name)) return Promise.resolve('name_taken' as const);
    const server = { id: randomUUID(), name, isActive: true, createdAt: new Date() };
    this.audited({ event: 'server.created', outcome: 'success', details: { serverId: server.id } }, actorUserId); // throws before mutation
    this.servers.push(server);
    return Promise.resolve(this.summary(server));
  }

  issueCredential({ serverId, tokenHash, actorUserId }: { serverId: string; tokenHash: Buffer; actorUserId: string; requestId: string }) {
    this.check();
    const server = this.servers.find((s) => s.id === serverId);
    if (!server) return Promise.resolve('not_found' as const);
    if (!server.isActive) return Promise.resolve('inactive' as const);
    const active = this.credentials.filter((c) => c.serverId === serverId && !c.revokedAt);
    this.audited({ event: 'agent.credential_issued', outcome: 'success', details: { serverId, rotated: active.length > 0 } }, actorUserId);
    for (const c of active) c.revokedAt = new Date();
    this.credentials.push({ serverId, tokenHash: tokenHash.toString('hex'), revokedAt: null });
    return Promise.resolve({ issuedAt: new Date(), rotated: active.length > 0 });
  }

  revokeCredential({ serverId, actorUserId }: { serverId: string; actorUserId: string; requestId: string }) {
    this.check();
    if (!this.servers.some((s) => s.id === serverId)) return Promise.resolve('not_found' as const);
    const active = this.credentials.filter((c) => c.serverId === serverId && !c.revokedAt);
    this.audited({ event: 'agent.credential_revoked', outcome: 'success', details: { serverId, revoked: active.length > 0 } }, actorUserId);
    for (const c of active) c.revokedAt = new Date();
    return Promise.resolve({ revoked: active.length > 0 });
  }

  private activeServerFor(tokenHash: Buffer): string | null {
    const cred = this.credentials.find((c) => c.tokenHash === tokenHash.toString('hex') && !c.revokedAt);
    const server = cred ? this.servers.find((s) => s.id === cred.serverId && s.isActive) : undefined;
    return server ? server.id : null;
  }

  resolveAgent(tokenHash: Buffer) {
    this.check();
    const serverId = this.activeServerFor(tokenHash);
    return Promise.resolve(serverId ? { serverId } : null);
  }

  recordHeartbeat({ tokenHash, snapshot }: { tokenHash: Buffer; snapshot: ServerSnapshot }) {
    this.check();
    this.heartbeatCalls += 1;
    const serverId = this.activeServerFor(tokenHash);
    if (!serverId) return Promise.resolve('unauthorized' as const);
    const receivedAt = new Date();
    this.heartbeats.set(serverId, { receivedAt, snapshot });
    return Promise.resolve({ serverId, receivedAt });
  }
}

export function validSnapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return { agentVersion: '0.5.0', hostname: 'node-1.example', platform: 'linux', arch: 'x64', loadAverage: [0.5, 0.4, 0.3], ...overrides };
}

/** What an Agent <= 0.4.x sends (and what rows written before ADR-023 contain): current fields + legacy host metrics. */
export function legacySnapshot(overrides: Partial<IncomingSnapshot> = {}): IncomingSnapshot {
  return {
    agentVersion: '0.4.0', hostname: 'node-1.example', platform: 'linux', arch: 'x64', uptimeSeconds: 3600,
    cpuCount: 4, loadAverage: [0.5, 0.4, 0.3], memory: { totalBytes: 8_000_000_000, freeBytes: 2_000_000_000 },
    ...overrides,
  };
}
