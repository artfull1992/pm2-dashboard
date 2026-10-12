import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Session and CSRF tokens (ADR-011).
// * Session token: 32 random bytes, base64url, sent only in the HttpOnly cookie. The DB stores SHA-256(token).
// * CSRF token: base64url(HMAC-SHA256(key = session token, "nc-csrf-v1")) — bound to the session, derivable
//   only by someone holding the cookie value, so it needs no storage and dies with the session.

export const SESSION_TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(token: string | undefined): token is string {
  return token !== undefined && TOKEN_RE.test(token);
}

export function sessionTokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('nc-csrf-v1').digest('base64url');
}

export function csrfTokenMatches(sessionToken: string, provided: string | undefined): boolean {
  if (provided === undefined || !TOKEN_RE.test(provided)) return false;
  return timingSafeEqual(Buffer.from(csrfTokenFor(sessionToken)), Buffer.from(provided));
}

export interface CookieSettings {
  secure: boolean;
  ttlSeconds: number;
}

/** __Host- prefix requires Secure, Path=/ and no Domain — browsers then refuse any weaker variant. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-nc_session' : 'nc_session';
}

export function sessionCookie(token: string, settings: CookieSettings): string {
  return [
    `${sessionCookieName(settings.secure)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(settings.ttlSeconds)}`,
    ...(settings.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [`${sessionCookieName(secure)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

/** Reads one cookie value from a Cookie header. Duplicate names → undefined (ambiguous, treated as absent). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  return values[0]?.slice(name.length + 1);
}
