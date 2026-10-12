// In-memory AuthStore with the same contract as the PostgreSQL store, including atomicity:
// a failing audit write inside createSession/revokeSession leaves no mutation behind.
// Real SQL semantics are covered separately by backend/test/db/auth.test.ts.
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../src/auth/password.js';
import type { Role } from '../../src/auth/rbac.js';
import type { AuditContext, AuditEvent, AuditItem, AuthStore, LoginUser, SessionUser } from '../../src/auth/store.js';

interface FakeSession { id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }

export class FakeAuthStore implements AuthStore {
  readonly users = new Map<string, LoginUser>();
  readonly sessions: FakeSession[] = [];
  readonly audit: AuditItem[] = [];
  /** Methods listed here throw (simulated database outage). */
  readonly failing = new Set<keyof AuthStore>();
  /** Audit inserts throw (inside and outside transactions). */
  failAuditWrites = false;
  calls: Partial<Record<keyof AuthStore, number>> = {};
  private nextAuditId = 1;

  private enter(method: keyof AuthStore): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    if (this.failing.has(method)) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 synthetic'), { code: 'ECONNREFUSED' });
  }

  async addUser(input: { email: string; password: string; role?: Role; isActive?: boolean }): Promise<LoginUser> {
    const user: LoginUser = {
      id: randomUUID(), email: input.email, role: input.role ?? 'viewer',
      passwordHash: await hashPassword(input.password), isActive: input.isActive ?? true,
    };
    this.users.set(user.id, user);
    return user;
  }

  private appendAudit(entry: AuditEvent, context: AuditContext): AuditItem {
    if (this.failAuditWrites) throw new Error('audit insert failed (synthetic)');
    return {
      id: String(this.nextAuditId++), occurredAt: new Date().toISOString(), event: entry.event, outcome: entry.outcome,
      actorUserId: context.actorUserId, requestId: context.requestId, details: { ...(entry.details ?? {}) },
    };
  }

  findLoginUser(email: string): Promise<LoginUser | null> {
    this.enter('findLoginUser');
    return Promise.resolve([...this.users.values()].find((u) => u.email === email) ?? null);
  }

  createSession(input: Parameters<AuthStore['createSession']>[0]): Promise<{ expiresAt: Date }> {
    this.enter('createSession');
    // "Transaction": compute every change first, apply only if the audit row could be written.
    const audit = this.appendAudit({ event: 'auth.login', outcome: 'success' }, { actorUserId: input.userId, requestId: input.requestId });
    const previous = input.previousTokenHash?.toString('hex');
    for (const s of this.sessions) if (previous && s.tokenHash === previous && !s.revokedAt) s.revokedAt = new Date();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    this.sessions.push({ id: randomUUID(), userId: input.userId, tokenHash: input.tokenHash.toString('hex'), expiresAt, revokedAt: null });
    this.audit.push(audit);
    return Promise.resolve({ expiresAt });
  }

  resolveSession(tokenHash: Buffer): Promise<SessionUser | null> {
    this.enter('resolveSession');
    const s = this.sessions.find((x) => x.tokenHash === tokenHash.toString('hex'));
    const user = s ? this.users.get(s.userId) : undefined;
    if (!s || !user || s.revokedAt || s.expiresAt <= new Date() || !user.isActive) return Promise.resolve(null);
    return Promise.resolve({ sessionId: s.id, userId: user.id, email: user.email, role: user.role, expiresAt: s.expiresAt });
  }

  revokeSession(input: { sessionId: string; userId: string; requestId: string }): Promise<boolean> {
    this.enter('revokeSession');
    const s = this.sessions.find((x) => x.id === input.sessionId && !x.revokedAt);
    if (!s) return Promise.resolve(false);
    const audit = this.appendAudit({ event: 'auth.logout', outcome: 'success' }, { actorUserId: input.userId, requestId: input.requestId });
    s.revokedAt = new Date();
    this.audit.push(audit);
    return Promise.resolve(true);
  }

  recordAudit(entry: AuditEvent, context: AuditContext): Promise<void> {
    this.enter('recordAudit');
    this.audit.push(this.appendAudit(entry, context));
    return Promise.resolve();
  }

  listAudit(input: { limit: number; beforeId: string | null }): Promise<{ items: AuditItem[]; nextBeforeId: string | null }> {
    this.enter('listAudit');
    const sorted = [...this.audit].sort((a, b) => Number(b.id) - Number(a.id))
      .filter((a) => input.beforeId === null || Number(a.id) < Number(input.beforeId));
    const items = sorted.slice(0, input.limit);
    return Promise.resolve({ items, nextBeforeId: sorted.length > input.limit ? (items.at(-1)?.id ?? null) : null });
  }

  expireAll(): void {
    for (const s of this.sessions) s.expiresAt = new Date(Date.now() - 1000);
  }
}
