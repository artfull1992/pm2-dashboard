// In-memory AuthStore with the same contract as the PostgreSQL store, including atomicity:
// a failing audit write inside createSession/revokeSession leaves no mutation behind.
// Real SQL semantics are covered separately by backend/test/db/auth.test.ts.
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../src/auth/password.js';
import type { Role } from '../../src/auth/rbac.js';
import type { AuditContext, AuditEvent, AuditItem, AuthStore, LoginUser, SessionUser } from '../../src/auth/store.js';
import { type ActorRef, type CreateUserResult, decideUserChange, type UpdateUserResult, type UserStore, type UserView } from '../../src/auth/users-store.js';

interface FakeSession { id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }
type FakeUser = LoginUser & { createdAt: Date; updatedAt: Date };
type Method = keyof AuthStore | keyof UserStore;

/** Also implements UserStore (ADR-019) on the same users/sessions, with the same all-or-nothing semantics. */
type StoredAudit = Omit<AuditItem, 'context'>;

export class FakeAuthStore implements AuthStore, UserStore {
  readonly users = new Map<string, FakeUser>();
  readonly sessions: FakeSession[] = [];
  /** Stored rows: the read-time context is resolved by listAudit (as the SQL join does). */
  readonly audit: StoredAudit[] = [];
  /** Methods listed here throw (simulated database outage). */
  readonly failing = new Set<Method>();
  /** Audit inserts throw (inside and outside transactions). */
  failAuditWrites = false;
  calls: Partial<Record<Method, number>> = {};
  private nextAuditId = 1;

  private enter(method: Method): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    if (this.failing.has(method)) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 synthetic'), { code: 'ECONNREFUSED' });
  }

  async addUser(input: { email: string; password: string; role?: Role; isActive?: boolean }): Promise<FakeUser> {
    const now = new Date(Date.now() + this.users.size); // distinct, increasing creation times
    const user: FakeUser = {
      id: randomUUID(), email: input.email, role: input.role ?? 'viewer',
      passwordHash: await hashPassword(input.password), isActive: input.isActive ?? true, credentialVersion: 1, createdAt: now, updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  private appendAudit(entry: AuditEvent, context: AuditContext): StoredAudit {
    if (this.failAuditWrites) throw new Error('audit insert failed (synthetic)');
    return {
      id: String(this.nextAuditId++), occurredAt: new Date().toISOString(), event: entry.event, outcome: entry.outcome,
      actorUserId: context.actorUserId, requestId: context.requestId, details: { ...(entry.details ?? {}) },
    };
  }

  findLoginUser(email: string): Promise<LoginUser | null> {
    this.enter('findLoginUser');
    // A snapshot, like a database row: later changes to the stored user do not alter what was read.
    const found = [...this.users.values()].find((u) => u.email === email);
    return Promise.resolve(found ? { ...found } : null);
  }

  createSession(input: Parameters<AuthStore['createSession']>[0]): Promise<{ expiresAt: Date } | null> {
    this.enter('createSession');
    const user = this.users.get(input.userId);
    if (!user?.isActive || user.credentialVersion !== input.credentialVersion) return Promise.resolve(null);
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

  getCredentials(userId: string): Promise<{ passwordHash: string; credentialVersion: number } | null> {
    this.enter('getCredentials');
    const u = this.users.get(userId);
    return Promise.resolve(u?.isActive ? { passwordHash: u.passwordHash, credentialVersion: u.credentialVersion } : null);
  }

  private revokeAll(userId: string): number {
    let n = 0;
    for (const s of this.sessions) if (s.userId === userId && !s.revokedAt) { s.revokedAt = new Date(); n += 1; }
    return n;
  }

  private activeSessions(userId: string): number {
    return this.sessions.filter((s) => s.userId === userId && !s.revokedAt).length;
  }

  changePassword(input: { userId: string; expectedVersion: number; passwordHash: string; requestId: string }): Promise<{ status: 'changed'; sessionsRevoked: number } | { status: 'stale' }> {
    this.enter('changePassword');
    const u = this.users.get(input.userId);
    if (!u?.isActive || u.credentialVersion !== input.expectedVersion) return Promise.resolve({ status: 'stale' });
    const sessionsRevoked = this.activeSessions(u.id);
    const audit = this.appendAudit({ event: 'auth.password_change', outcome: 'success', details: { sessionsRevoked } }, { actorUserId: u.id, requestId: input.requestId });
    u.passwordHash = input.passwordHash;
    u.credentialVersion += 1;
    u.updatedAt = new Date();
    this.revokeAll(u.id);
    this.audit.push(audit);
    return Promise.resolve({ status: 'changed', sessionsRevoked });
  }

  private view(u: FakeUser): UserView {
    return { id: u.id, email: u.email, role: u.role, isActive: u.isActive, createdAt: u.createdAt.toISOString(), updatedAt: u.updatedAt.toISOString() };
  }

  private actorIsAdmin(actor: ActorRef): boolean {
    const u = this.users.get(actor.userId);
    const s = this.sessions.find((x) => x.id === actor.sessionId && x.userId === actor.userId);
    return Boolean(u?.isActive && u.role === 'admin' && s && !s.revokedAt && s.expiresAt > new Date());
  }

  listUsers(input: { limit: number; after: string | null }): Promise<{ items: UserView[]; nextAfter: string | null }> {
    this.enter('listUsers');
    const sorted = [...this.users.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const start = input.after === null ? 0 : sorted.findIndex((u) => u.id === input.after) + 1;
    const rest = input.after !== null && start === 0 ? [] : sorted.slice(start);
    const page = rest.slice(0, input.limit);
    return Promise.resolve({ items: page.map((u) => this.view(u)), nextAfter: rest.length > input.limit ? (page.at(-1)?.id ?? null) : null });
  }

  createUser(input: { actor: ActorRef; email: string; passwordHash: string; role: Role; requestId: string }): Promise<CreateUserResult> {
    this.enter('createUser');
    if (!this.actorIsAdmin(input.actor)) return Promise.resolve({ status: 'actor_revoked' });
    if ([...this.users.values()].some((u) => u.email === input.email)) return Promise.resolve({ status: 'email_taken' });
    const now = new Date(Date.now() + this.users.size);
    const user: FakeUser = { id: randomUUID(), email: input.email, role: input.role, passwordHash: input.passwordHash, isActive: true, credentialVersion: 1, createdAt: now, updatedAt: now };
    const audit = this.appendAudit({ event: 'user.created', outcome: 'success', details: { targetUserId: user.id, role: input.role } }, { actorUserId: input.actor.userId, requestId: input.requestId });
    this.users.set(user.id, user);
    this.audit.push(audit);
    return Promise.resolve({ status: 'created', user: this.view(user) });
  }

  updateUser(input: { actor: ActorRef; targetId: string; role?: Role; isActive?: boolean; requestId: string }): Promise<UpdateUserResult> {
    this.enter('updateUser');
    if (!this.actorIsAdmin(input.actor)) return Promise.resolve({ status: 'actor_revoked' });
    const t = this.users.get(input.targetId);
    if (!t) return Promise.resolve({ status: 'not_found' });
    const others = [...this.users.values()].filter((u) => u.role === 'admin' && u.isActive && u.id !== t.id).length;
    const change = { ...(input.role === undefined ? {} : { role: input.role }), ...(input.isActive === undefined ? {} : { isActive: input.isActive }) };
    const d = decideUserChange(input.actor.userId, t, change, others);
    if (d.status !== 'ok') return Promise.resolve({ status: d.status });
    if (!d.changed) return Promise.resolve({ status: 'updated', user: this.view(t), changed: false });
    const sessionsRevoked = this.activeSessions(t.id);
    const context = { actorUserId: input.actor.userId, requestId: input.requestId };
    const audits: StoredAudit[] = [];
    if (d.role !== t.role) audits.push(this.appendAudit({ event: 'user.role_changed', outcome: 'success', details: { targetUserId: t.id, fromRole: t.role, toRole: d.role, sessionsRevoked } }, context));
    if (d.isActive !== t.isActive) audits.push(this.appendAudit({ event: d.isActive ? 'user.activated' : 'user.deactivated', outcome: 'success', details: { targetUserId: t.id, sessionsRevoked } }, context));
    t.role = d.role;
    t.isActive = d.isActive;
    t.credentialVersion += 1;
    t.updatedAt = new Date();
    this.revokeAll(t.id);
    this.audit.push(...audits);
    return Promise.resolve({ status: 'updated', user: this.view(t), changed: true });
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
    // Stored rows carry no read-time context; the fake resolves only the actor's e-mail (like the LEFT JOIN).
    const items = sorted.slice(0, input.limit).map((a) => ({
      ...a, context: { actorEmail: a.actorUserId === null ? null : this.users.get(a.actorUserId)?.email ?? null, serverName: null, targetUserEmail: null, command: null },
    }));
    return Promise.resolve({ items, nextBeforeId: sorted.length > input.limit ? (items.at(-1)?.id ?? null) : null });
  }

  expireAll(): void {
    for (const s of this.sessions) s.expiresAt = new Date(Date.now() - 1000);
  }
}
