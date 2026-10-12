import { randomInt } from 'node:crypto';

// Alphanumeric only: safe in .env files, connection URIs and shells without escaping.
export const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const MIN_PASSWORD_LENGTH = 32;

// 48 chars from a 62-symbol alphabet ≈ 285 bits of entropy. randomInt is a CSPRNG without modulo bias.
export function generatePassword(length = 48) {
  if (!Number.isInteger(length) || length < MIN_PASSWORD_LENGTH) {
    throw new RangeError(`Password length must be an integer >= ${MIN_PASSWORD_LENGTH}`);
  }
  let password = '';
  for (let i = 0; i < length; i++) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}
