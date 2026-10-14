import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Webhook secret at rest (ADR-022): AES-256-GCM, a random 12-byte nonce per record, AAD binds the ciphertext to the
// integration generation (it cannot be moved to another generation). The key comes only from api.env; it is never
// stored in the database. Every failure is a fixed code — never the plaintext, the key or crypto error text.

export interface SecretKey { version: number; key: Buffer }
export interface SealedSecret { ciphertext: Buffer; nonce: Buffer; tag: Buffer; keyVersion: number }
export type OpenError = 'key_missing' | 'key_version_mismatch' | 'decrypt_failed';

const aad = (generation: number) => Buffer.from(`node-control:slack-webhook:${String(generation)}`, 'utf8');

/** ALERTS_SECRET_KEY: base64 of exactly 32 random bytes. Returns null for absent/invalid (the caller reports the key name only). */
export function parseSecretKey(raw: string, versionRaw: string): SecretKey | 'invalid' | null {
  if (raw === '') return null;
  const key = Buffer.from(raw, 'base64');
  const version = Number(versionRaw === '' ? '1' : versionRaw);
  if (key.length !== 32 || key.toString('base64') !== raw.replace(/\s/g, '') || !Number.isInteger(version) || version < 1 || version > 1000) return 'invalid';
  return { version, key };
}

export function seal(plaintext: string, generation: number, key: SecretKey): SealedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(aad(generation));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyVersion: key.version };
}

export function open(sealed: SealedSecret, generation: number, key: SecretKey | null): { ok: true; value: string } | { ok: false; error: OpenError } {
  if (!key) return { ok: false, error: 'key_missing' };
  if (sealed.keyVersion !== key.version) return { ok: false, error: 'key_version_mismatch' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, sealed.nonce);
    decipher.setAAD(aad(generation));
    decipher.setAuthTag(sealed.tag);
    return { ok: true, value: Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8') };
  } catch {
    return { ok: false, error: 'decrypt_failed' };
  }
}
