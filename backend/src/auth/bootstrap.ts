import type { Database } from '../database.js';
import { insertAudit } from './store.js';

export type BootstrapResult =
  | { status: 'created'; userId: string }
  | { status: 'admin-exists' }
  | { status: 'email-taken' };

/**
 * Creates the first administrator, or refuses (ADR-011). One transaction:
 *  * SHARE ROW EXCLUSIVE lock on users serializes concurrent bootstraps (and any concurrent user writes);
 *  * refuses if any admin exists, or if the email already belongs to a user (no silent promotion/reset);
 *  * user row and `admin.bootstrap` audit row commit together or not at all.
 */
export function bootstrapAdmin(db: Database, input: { email: string; passwordHash: string }): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const admins = await tx.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (admins.rows.length > 0) return { status: 'admin-exists' } as const;
    const taken = await tx.query('SELECT 1 FROM users WHERE email = $1', [input.email]);
    if (taken.rows.length > 0) return { status: 'email-taken' } as const;
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, 'admin', true) RETURNING id",
      [input.email, input.passwordHash],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error('insert returned no row');
    await insertAudit(tx, { event: 'admin.bootstrap', outcome: 'success' }, { actorUserId: userId, requestId: null });
    return { status: 'created', userId } as const;
  });
}
