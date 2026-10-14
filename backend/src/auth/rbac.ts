// Role → permission matrix (ADR-011). One role per user; permissions are derived on the server from the
// role currently stored in the database — never from client input.
// Permissions for monitoring/process control are a fixed contract for upcoming tasks: no endpoint uses them yet.

export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'monitoring:read', // future: servers, applications, metrics, logs
  'processes:control', // future: start/stop/restart of allowed managed processes
  'users:manage', // future: user administration
  'servers:manage', // server registry and Agent credentials (Task 007)
  'audit:read',
  'logs:read', // bounded stdout/stderr tail of explicitly allowed services (Task 010, ADR-018)
  'alerts:manage', // alert delivery state, queue and non-secret configuration (Task 013, ADR-021)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  viewer: ['monitoring:read'],
  // Logs can contain sensitive data: viewer does not get logs:read; processes:control does not imply it.
  operator: ['monitoring:read', 'processes:control', 'logs:read'],
  admin: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
});

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Unknown roles get no permissions (deny by default). */
export function permissionsFor(role: string): readonly Permission[] {
  return isRole(role) ? ROLE_PERMISSIONS[role] : [];
}

export function hasPermission(role: string, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}
