// In-memory fixed-window attempt counter with a hard cap on tracked keys (ADR-011).
// Single-instance only: state is per process and resets on restart. Windows expire, so there is
// no permanent lockout. Applied BEFORE any password hashing.

export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Counts an attempt. Returns 0 if allowed, otherwise seconds until the window resets. */
  hit(key: string, now?: number): number;
  size(): number;
}

export function createRateLimiter(rule: RateLimitRule, maxKeys = 10_000): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, now = Date.now()) {
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= now) {
        if (entry) windows.delete(key);
        if (windows.size >= maxKeys) {
          // Drop expired entries first; if still full, evict the oldest insertion (bounded memory).
          for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
          if (windows.size >= maxKeys) windows.delete(windows.keys().next().value as string);
        }
        entry = { count: 0, resetAt: now + rule.windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      return entry.count > rule.max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
    },
    size: () => windows.size,
  };
}

export const LOGIN_LIMITS = Object.freeze({
  // Per normalized-email digest: protects a single account against guessing.
  perAccount: { max: 5, windowMs: 15 * 60_000 },
  // Per client address (socket peer; trustProxy is off). Behind a future reverse proxy this becomes global.
  perAddress: { max: 30, windowMs: 15 * 60_000 },
});

export const PASSWORD_CHANGE_LIMITS = Object.freeze({
  // Per user id (ADR-019): every attempt counts, before any hashing — the same budget as a login per account.
  perUser: { max: 5, windowMs: 15 * 60_000 },
});

export const USER_ADMIN_LIMITS = Object.freeze({
  // Per acting admin: creating users hashes a password; the cap keeps admin mutations from monopolizing hashing.
  perActor: { max: 30, windowMs: 60_000 },
});
