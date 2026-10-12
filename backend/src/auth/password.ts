import { randomBytes, scrypt as scryptCallback, type ScryptOptions, timingSafeEqual } from 'node:crypto';

// Password hashing (ADR-011): node:crypto scrypt, versioned self-describing format
//   scrypt$v1$N=<N>,r=<r>,p=<p>$<salt base64url>$<key base64url>
// Verification accepts only parameters inside fixed bounds, so a stored/forged hash cannot make the
// server allocate unbounded memory or CPU. All expensive operations go through a bounded limiter.

export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keyLength: 32, saltLength: 16 });
// 128·N·r bytes = 32 MiB for the defaults; maxmem leaves headroom but caps anything larger.
const MAX_MEM = 64 * 1024 * 1024;
const ACCEPTED = Object.freeze({ minLogN: 14, maxLogN: 16, r: 8, maxP: 2 });
const MAX_ENCODED_LENGTH = 200;
const HASH_RE = /^scrypt\$v1\$N=(\d{1,7}),r=(\d{1,2}),p=(\d)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export const PASSWORD_POLICY = Object.freeze({ minCodePoints: 12, maxCodePoints: 128, maxBytes: 512 });

export type PasswordProblem = 'too_short' | 'too_long';

/** Length policy only; the password is never trimmed or normalized. */
export function checkPasswordPolicy(password: string): PasswordProblem | null {
  // The policy counts Unicode code points (not grapheme clusters or UTF-16 units), so spread is exactly right here.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const codePoints = [...password].length;
  if (codePoints < PASSWORD_POLICY.minCodePoints) return 'too_short';
  if (codePoints > PASSWORD_POLICY.maxCodePoints || Buffer.byteLength(password, 'utf8') > PASSWORD_POLICY.maxBytes) return 'too_long';
  return null;
}

export class PasswordHashFormatError extends Error {
  constructor() {
    super('unsupported password hash');
    this.name = 'PasswordHashFormatError';
  }
}

export class BusyError extends Error {
  constructor() {
    super('password hashing capacity exhausted');
    this.name = 'BusyError';
  }
}

/** Caps concurrent expensive work and the queue behind it; excess callers fail fast with BusyError. */
export function createLimiter(maxConcurrent: number, maxQueue: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        if (queue.length >= maxQueue) throw new BusyError();
        // The finishing task hands its slot over directly, so `active` never exceeds maxConcurrent.
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await task();
      } finally {
        const next = queue.shift();
        if (next) next();
        else active -= 1;
      }
    },
    stats: () => ({ active, queued: queue.length }),
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
export const DEFAULT_HASH_LIMITER = createLimiter(4, 32);

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => { if (error) reject(error); else resolve(key); });
  });
}

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; key: Buffer }

export function parsePasswordHash(encoded: string): ParsedHash {
  if (encoded.length > MAX_ENCODED_LENGTH) throw new PasswordHashFormatError();
  const match = HASH_RE.exec(encoded);
  if (!match) throw new PasswordHashFormatError();
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const logN = Math.log2(N);
  if (!Number.isInteger(logN) || logN < ACCEPTED.minLogN || logN > ACCEPTED.maxLogN || r !== ACCEPTED.r || p < 1 || p > ACCEPTED.maxP) {
    throw new PasswordHashFormatError();
  }
  const salt = Buffer.from(match[4] ?? '', 'base64url');
  const key = Buffer.from(match[5] ?? '', 'base64url');
  if (salt.length !== SCRYPT_PARAMS.saltLength || key.length !== SCRYPT_PARAMS.keyLength) throw new PasswordHashFormatError();
  return { N, r, p, salt, key };
}

export async function hashPassword(password: string, limiter: Limiter = DEFAULT_HASH_LIMITER): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const { N, r, p, keyLength } = SCRYPT_PARAMS;
  const key = await limiter.run(() => scrypt(password, salt, keyLength, { N, r, p, maxmem: MAX_MEM }));
  return `scrypt$v1$N=${String(N)},r=${String(r)},p=${String(p)}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time comparison of the derived key. Malformed or out-of-bounds hashes throw PasswordHashFormatError. */
export async function verifyPassword(password: string, encoded: string, limiter: Limiter = DEFAULT_HASH_LIMITER): Promise<boolean> {
  const { N, r, p, salt, key } = parsePasswordHash(encoded);
  const derived = await limiter.run(() => scrypt(password, salt, key.length, { N, r, p, maxmem: MAX_MEM }));
  return timingSafeEqual(derived, key);
}

let dummyHash: Promise<string> | undefined;

/** Same-cost verification for unknown users, so response time does not reveal whether an email exists. */
export async function verifyDummy(password: string, limiter: Limiter = DEFAULT_HASH_LIMITER): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'), limiter);
  await verifyPassword(password, await dummyHash, limiter);
  return false;
}
