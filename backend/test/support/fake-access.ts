import { hasPermission, type Permission, type Role } from '../../src/auth/rbac.js';
import type { AccessChecker, Scope } from '../../src/auth/scope.js';

/**
 * In-memory resource grants (ADR-028) for API tests without PostgreSQL. Same rules as the SQL fragments of scope.ts:
 * scope null (admin) sees everything; a user sees a server with a grant, a service with mode 'all' or a selected name.
 * `allowUngranted` keeps older route tests that are not about grants working (every user treated as granted).
 */
export class FakeAccessChecker implements AccessChecker {
  readonly grants = new Map<string, Map<string, { mode: 'all' | 'selected'; services: Set<string> }>>();
  allowUngranted = false;
  /** Current role/active flag of a user (the real checker reads `users`); unset → nobody (fail closed). */
  actors: (userId: string) => { role: Role; isActive: boolean } | undefined = () => undefined;

  /** `exists`: whether a server exists at all (the real checker reads the servers table). */
  constructor(private readonly exists: (serverId: string) => Promise<boolean> = () => Promise.resolve(true)) {}

  grant(userId: string, serverId: string, mode: 'all' | 'selected', services: string[] = []): void {
    const byServer = this.grants.get(userId) ?? new Map<string, { mode: 'all' | 'selected'; services: Set<string> }>();
    byServer.set(serverId, { mode, services: new Set(services) });
    this.grants.set(userId, byServer);
  }

  revoke(userId: string, serverId?: string): void {
    if (serverId === undefined) this.grants.delete(userId);
    else this.grants.get(userId)?.delete(serverId);
  }

  actorScope(userId: string, permission: Permission): Promise<{ scope: Scope } | null> {
    const a = this.actors(userId);
    if (!a?.isActive || !hasPermission(a.role, permission)) return Promise.resolve(null);
    return Promise.resolve({ scope: a.role === 'admin' ? null : userId });
  }

  private server(scope: Scope, serverId: string) {
    if (scope === null) return { mode: 'all' as const, services: new Set<string>() };
    const g = this.grants.get(scope)?.get(serverId);
    return g ?? (this.allowUngranted ? { mode: 'all' as const, services: new Set<string>() } : null);
  }

  async serverVisible(scope: Scope, serverId: string): Promise<boolean> {
    return (await this.exists(serverId)) && this.server(scope, serverId) !== null;
  }

  visibleServices(scope: Scope, serverId: string, names: readonly string[]): Promise<Set<string>> {
    const g = this.server(scope, serverId);
    return Promise.resolve(new Set(g === null ? [] : names.filter((n) => g.mode === 'all' || g.services.has(n))));
  }
}
