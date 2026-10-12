// Email policy shared by login and bootstrap (ADR-010/011): trim + lower-case, then the same shape the
// users_email_normalized / users_email_format CHECK constraints enforce.

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/u;
export const EMAIL_MAX_LENGTH = 254;

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) return null;
  return email;
}
