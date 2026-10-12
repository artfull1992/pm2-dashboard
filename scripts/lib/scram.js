import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

// Builds a PostgreSQL SCRAM-SHA-256 verifier client-side (RFC 5802 / RFC 7677), so the plaintext
// password never reaches the server, its SQL statements or its logs.

export const SCRAM_ITERATIONS = 4096;
const VERIFIER_RE = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function deriveScramKeys(password, salt, iterations = SCRAM_ITERATIONS) {
  // SASLprep is the identity for printable ASCII; reject anything else rather than implement it.
  if (typeof password !== 'string' || !/^[\x21-\x7e]+$/.test(password)) {
    throw new TypeError('SCRAM password must be non-empty printable ASCII without spaces');
  }
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = hmac(saltedPassword, 'Client Key');
  return {
    clientKey,
    storedKey: createHash('sha256').update(clientKey).digest(),
    serverKey: hmac(saltedPassword, 'Server Key'),
  };
}

export function scramVerifier(password, { salt = randomBytes(16), iterations = SCRAM_ITERATIONS } = {}) {
  const { storedKey, serverKey } = deriveScramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export function isScramVerifier(value) {
  return typeof value === 'string' && VERIFIER_RE.test(value);
}

export function redactScramVerifiers(text) {
  return String(text).replace(/SCRAM-SHA-256\$[^'"\s]+/g, 'SCRAM-SHA-256$[redacted]');
}
