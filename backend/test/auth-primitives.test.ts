import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../src/auth/email.js';
import {
  BusyError, checkPasswordPolicy, createLimiter, hashPassword, parsePasswordHash, PasswordHashFormatError, SCRYPT_PARAMS,
  verifyDummy, verifyPassword,
} from '../src/auth/password.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import { hasPermission, PERMISSIONS, permissionsFor, ROLE_PERMISSIONS, ROLES } from '../src/auth/rbac.js';
import {
  clearedSessionCookie, csrfTokenFor, csrfTokenMatches, isWellFormedToken, newSessionToken, readCookie, sessionCookie,
  sessionTokenDigest,
} from '../src/auth/tokens.js';

const PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  it('hash has the versioned format with the configured parameters and verifies', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$v1\$N=32768,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(PASSWORD);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword(`${PASSWORD} `, hash)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD.toUpperCase(), hash)).resolves.toBe(false);
  });

  it('uses a random salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(parsePasswordHash(a).salt.equals(parsePasswordHash(b).salt)).toBe(false);
  });

  it('does not normalize: composed and decomposed forms differ', async () => {
    const composed = 'pässwörd-long-1';
    const hash = await hashPassword(composed);
    await expect(verifyPassword(composed.normalize('NFD'), hash)).resolves.toBe(false);
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'bcrypt$2b$10$abc'],
    ['N too large (memory DoS)', `scrypt$v1$N=${String(2 ** 20)},r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['N too small', `scrypt$v1$N=${String(2 ** 10)},r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['N not a power of two', `scrypt$v1$N=30000,r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['r not 8', `scrypt$v1$N=32768,r=16,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['p too large', `scrypt$v1$N=32768,r=8,p=9$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['short key', `scrypt$v1$N=32768,r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(20)}`],
    ['oversized string', `scrypt$v1$N=32768,r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(300)}`],
  ])('rejects invalid/out-of-bounds hash: %s', async (_name, hash) => {
    await expect(verifyPassword(PASSWORD, hash)).rejects.toBeInstanceOf(PasswordHashFormatError);
  });

  it('dummy verification always fails', async () => {
    await expect(verifyDummy(PASSWORD)).resolves.toBe(false);
  });

  it('salt/key sizes match the constants', () => {
    expect(SCRYPT_PARAMS).toMatchObject({ saltLength: 16, keyLength: 32 });
  });
});

describe('password policy', () => {
  it.each([
    ['11 chars', 'a'.repeat(11), 'too_short'],
    ['12 chars', 'a'.repeat(12), null],
    ['128 chars', 'a'.repeat(128), null],
    ['129 chars', 'a'.repeat(129), 'too_long'],
    ['12 emoji = 12 code points', '🔐'.repeat(12), null],
    ['128 four-byte code points exceed 512 bytes? (=512, allowed)', '🔐'.repeat(128), null],
    ['whitespace is not trimmed', `   ${'a'.repeat(8)}`, 'too_short'],
  ])('%s', (_name, password, expected) => {
    expect(checkPasswordPolicy(password)).toBe(expected);
  });

  it('byte cap (512) is a backstop: 128 code points of 4 bytes is exactly the limit', () => {
    expect(Buffer.byteLength('\u{10FFFF}'.repeat(128))).toBe(512);
    expect(checkPasswordPolicy('\u{10FFFF}'.repeat(128))).toBeNull();
  });
});

describe('hash limiter', () => {
  it('never exceeds max concurrency and rejects when the queue is full', async () => {
    const limiter = createLimiter(2, 1);
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const task = () => limiter.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => release.push(r));
      running -= 1;
    });
    const a = task();
    const b = task();
    const c = task(); // queued
    await expect(task()).rejects.toBeInstanceOf(BusyError); // queue full
    expect(limiter.stats()).toEqual({ active: 2, queued: 1 });
    release.shift()?.();
    await new Promise((r) => setImmediate(r));
    release.splice(0).forEach((r) => { r(); });
    await new Promise((r) => setImmediate(r));
    release.splice(0).forEach((r) => { r(); });
    await Promise.all([a, b, c]);
    expect(peak).toBe(2);
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
  });
});

describe('tokens and cookies', () => {
  it('session tokens are 32 random bytes in base64url; digest is SHA-256', () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newSessionToken()).not.toBe(token);
    expect(sessionTokenDigest(token)).toHaveLength(32);
    expect(isWellFormedToken(token)).toBe(true);
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });

  it('CSRF token is bound to the session token', () => {
    const t1 = newSessionToken();
    const t2 = newSessionToken();
    expect(csrfTokenMatches(t1, csrfTokenFor(t1))).toBe(true);
    expect(csrfTokenMatches(t1, csrfTokenFor(t2))).toBe(false);
    expect(csrfTokenMatches(t1, undefined)).toBe(false);
    expect(csrfTokenMatches(t1, 'x')).toBe(false);
    expect(csrfTokenFor(t1)).not.toBe(t1);
  });

  it('secure cookie: __Host- prefix, HttpOnly, SameSite=Strict, Path=/, Secure, Max-Age, no Domain', () => {
    const cookie = sessionCookie('tok', { secure: true, ttlSeconds: 600 });
    expect(cookie).toBe('__Host-nc_session=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=600; Secure');
    expect(cookie).not.toMatch(/domain/i);
    expect(clearedSessionCookie(true)).toBe('__Host-nc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
  });

  it('insecure (dev) cookie has no prefix and no Secure flag', () => {
    expect(sessionCookie('tok', { secure: false, ttlSeconds: 60 })).toBe('nc_session=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=60');
  });

  it('readCookie picks exactly one value; duplicates are ambiguous', () => {
    expect(readCookie('a=1; nc_session=xyz; b=2', 'nc_session')).toBe('xyz');
    expect(readCookie('nc_session=1; nc_session=2', 'nc_session')).toBeUndefined();
    expect(readCookie(undefined, 'nc_session')).toBeUndefined();
    expect(readCookie(`nc_session=${'a'.repeat(9000)}`, 'nc_session')).toBeUndefined();
  });
});

describe('rbac matrix', () => {
  it('matches the documented matrix', () => {
    expect(ROLE_PERMISSIONS).toEqual({
      viewer: ['monitoring:read'],
      operator: ['monitoring:read', 'processes:control'],
      admin: ['monitoring:read', 'processes:control', 'users:manage', 'audit:read'],
    });
    for (const role of ROLES) for (const p of PERMISSIONS) expect(hasPermission(role, p)).toBe(ROLE_PERMISSIONS[role].includes(p));
  });

  it('unknown roles have no permissions', () => {
    expect(permissionsFor('superuser')).toEqual([]);
    expect(hasPermission('ADMIN', 'audit:read')).toBe(false);
  });
});

describe('login rate limiter', () => {
  it('allows max attempts per window, then reports seconds until reset; window expiry resets', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    expect(limiter.hit('k', 0)).toBe(0);
    expect(limiter.hit('k', 1000)).toBe(0);
    expect(limiter.hit('k', 2000)).toBe(58);
    expect(limiter.hit('other', 2000)).toBe(0);
    expect(limiter.hit('k', 60_000)).toBe(0); // new window: no permanent lockout
  });

  it('memory is bounded by maxKeys', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 }, 3);
    for (let i = 0; i < 10; i++) limiter.hit(`k${String(i)}`, 0);
    expect(limiter.size()).toBe(3);
  });
});

describe('email normalization', () => {
  it.each([
    [' Admin@Example.COM ', 'admin@example.com'],
    ['a@b', 'a@b'],
    ['no-at', null],
    ['a@b@c', null],
    ['with space@x.y', null],
    [`${'a'.repeat(250)}@x.yz`, null],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });
});
