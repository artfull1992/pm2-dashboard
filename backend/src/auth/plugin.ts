import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../config.js';
import { describeError, PublicHttpError } from '../errors.js';
import { normalizeEmail } from './email.js';
import { BusyError, checkPasswordPolicy, DEFAULT_HASH_LIMITER, type Limiter, PasswordHashFormatError, verifyDummy, verifyPassword } from './password.js';
import { createRateLimiter, LOGIN_LIMITS, type RateLimiter } from './rate-limit.js';
import { hasPermission, type Permission, permissionsFor, type Role } from './rbac.js';
import type { AuditContext, AuditEvent, AuthStore } from './store.js';
import {
  agentTokenDigest, bearerToken, clearedSessionCookie, csrfTokenFor, csrfTokenMatches, isWellFormedAgentToken, isWellFormedToken,
  newSessionToken, readCookie, sessionCookie, sessionCookieName, sessionTokenDigest,
} from './tokens.js';

// Authentication, CSRF and RBAC for /api (ADR-011).
// Every /api route must declare `config.access`; registration fails otherwise (deny by default).

export type RouteAccess = 'public' | 'authenticated' | { permission: Permission } | { machine: 'agent' };

export interface AgentState {
  serverId: string;
  /** Digest of the presented bearer token (never the token itself). */
  tokenHash: Buffer;
}

export interface AgentResolver {
  resolveAgent(tokenHash: Buffer): Promise<{ serverId: string } | null>;
}

/** Machine (Agent) route limits: before any DB lookup, bounded key maps. */
export const AGENT_LIMITS = Object.freeze({
  perAddress: { max: 120, windowMs: 60_000 },
  perToken: { max: 20, windowMs: 60_000 },
});

export interface AuthState {
  sessionId: string;
  userId: string;
  email: string;
  role: Role;
  permissions: readonly Permission[];
  expiresAt: Date;
  /** Kept server-side only to derive/verify the CSRF token; never logged or serialized. */
  readonly token: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyRequest {
    auth: AuthState | null;
    agent: AgentState | null;
  }
}

export interface AuthPluginOptions {
  config: AuthConfig;
  store: AuthStore;
  hashLimiter?: Limiter;
  accountLimiter?: RateLimiter;
  addressLimiter?: RateLimiter;
  /** Machine authentication for `{ machine: 'agent' }` routes; absent → such routes answer 503. */
  agentResolver?: AgentResolver;
  agentAddressLimiter?: RateLimiter;
  agentTokenLimiter?: RateLimiter;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';
const RETRY_UNAVAILABLE = { 'retry-after': '5' };

export const AUTH_MESSAGES = Object.freeze({
  unauthenticated: 'Authentication required',
  badCredentials: 'Invalid email or password',
  origin: 'Request origin not allowed',
  csrf: 'CSRF token missing or invalid',
  forbidden: 'Insufficient permissions',
  rateLimited: 'Too many login attempts, try again later',
  machineOnly: 'Browser requests are not accepted on this endpoint',
  agentUnauthenticated: 'Agent credential missing or invalid',
  agentRateLimited: 'Too many requests',
  bearerNotAccepted: 'Bearer credentials are not accepted on this endpoint',
  unavailable: 'Service temporarily unavailable',
});

const unavailable = () => new PublicHttpError(503, AUTH_MESSAGES.unavailable, RETRY_UNAVAILABLE);

const userSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'email', 'role'],
  properties: { id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } },
} as const;
const sessionInfoSchema = {
  type: 'object', additionalProperties: false, required: ['user', 'permissions', 'csrfToken', 'expiresAt'],
  properties: {
    user: userSchema,
    permissions: { type: 'array', items: { type: 'string' } },
    csrfToken: { type: 'string' },
    expiresAt: { type: 'string' },
  },
} as const;
const auditItemSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'occurredAt', 'event', 'outcome', 'actorUserId', 'requestId', 'details'],
  properties: {
    id: { type: 'string' }, occurredAt: { type: 'string' }, event: { type: 'string' }, outcome: { type: 'string' },
    actorUserId: { type: ['string', 'null'] }, requestId: { type: ['string', 'null'] },
    // Server-defined keys only (see store.ts AuditEvent); listed explicitly so nothing else is serialized.
    details: {
      type: 'object', additionalProperties: false,
      properties: {
        reason: { type: 'string' }, permission: { type: 'string' }, route: { type: 'string' },
        serverId: { type: 'string' }, rotated: { type: 'boolean' }, revoked: { type: 'boolean' },
      },
    },
  },
} as const;

function sessionInfo(auth: Pick<AuthState, 'userId' | 'email' | 'role' | 'expiresAt' | 'token'>) {
  return {
    user: { id: auth.userId, email: auth.email, role: auth.role },
    permissions: [...permissionsFor(auth.role)],
    csrfToken: csrfTokenFor(auth.token),
    expiresAt: auth.expiresAt.toISOString(),
  };
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  const { config, store } = options;
  const hashLimiter = options.hashLimiter ?? DEFAULT_HASH_LIMITER;
  const accountLimiter = options.accountLimiter ?? createRateLimiter(LOGIN_LIMITS.perAccount);
  const addressLimiter = options.addressLimiter ?? createRateLimiter(LOGIN_LIMITS.perAddress);
  const cookieName = sessionCookieName(config.cookieSecure);
  const allowedOrigins = new Set(config.allowedOrigins);

  const agentAddressLimiter = options.agentAddressLimiter ?? createRateLimiter(AGENT_LIMITS.perAddress);
  const agentTokenLimiter = options.agentTokenLimiter ?? createRateLimiter(AGENT_LIMITS.perToken);

  app.decorateRequest('auth', null);
  app.decorateRequest('agent', null);

  /**
   * Machine authentication (ADR-015). Bearer token only; a browser context (Origin / Sec-Fetch-* / session
   * cookie) is refused so the two auth modes never mix. Limits run before any database work.
   */
  async function authenticateAgent(request: FastifyRequest): Promise<void> {
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      throw new PublicHttpError(403, AUTH_MESSAGES.machineOnly);
    }
    if (readCookie(request.headers.cookie, cookieName) !== undefined) {
      throw new PublicHttpError(401, AUTH_MESSAGES.agentUnauthenticated);
    }
    const addressKey = isIP(request.ip) === 0 ? 'unresolved' : request.ip;
    const addressRetry = agentAddressLimiter.hit(addressKey);
    if (addressRetry > 0) throw new PublicHttpError(429, AUTH_MESSAGES.agentRateLimited, { 'retry-after': String(addressRetry) });

    const token = bearerToken(request.headers.authorization);
    if (!isWellFormedAgentToken(token)) throw new PublicHttpError(401, AUTH_MESSAGES.agentUnauthenticated);
    const tokenHash = agentTokenDigest(token);
    const tokenRetry = agentTokenLimiter.hit(tokenHash.toString('base64url'));
    if (tokenRetry > 0) throw new PublicHttpError(429, AUTH_MESSAGES.agentRateLimited, { 'retry-after': String(tokenRetry) });

    if (!options.agentResolver) throw unavailable();
    let agent;
    try {
      agent = await options.agentResolver.resolveAgent(tokenHash);
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Agent credential lookup failed');
      throw unavailable();
    }
    if (!agent) throw new PublicHttpError(401, AUTH_MESSAGES.agentUnauthenticated);
    request.agent = { serverId: agent.serverId, tokenHash };
  }

  // Deny by default: an /api route without an explicit access declaration is a startup error.
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/api/') && route.config?.access === undefined) {
      throw new Error(`route ${route.method.toString()} ${route.url} must declare config.access`);
    }
  });

  /** Audit that must not grant access if it fails: logs metadata and continues with the denial. */
  async function auditBestEffort(request: FastifyRequest, entry: AuditEvent, context: AuditContext): Promise<void> {
    try {
      await store.recordAudit(entry, context);
    } catch (error) {
      request.log.error({ error: describeError(error), event: entry.event }, 'Audit write failed; request still denied');
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    const access = request.routeOptions.config.access;
    if (!request.url.startsWith('/api/') || access === undefined) return;
    reply.header('cache-control', 'no-store');
    const stateChanging = !SAFE_METHODS.has(request.method);

    // Machine routes have their own auth flow and never use cookies, Origin or CSRF.
    if (typeof access === 'object' && 'machine' in access) {
      await authenticateAgent(request);
      return;
    }
    // Browser routes: a bearer credential is never accepted (no ambiguous auth modes; agent tokens stay machine-only).
    if (request.headers.authorization !== undefined) throw new PublicHttpError(401, AUTH_MESSAGES.bearerNotAccepted);

    // 1. Origin allowlist for every state-changing /api request, including login (login CSRF).
    //    A missing Origin is rejected: browsers always send it on POST; other clients must set it explicitly.
    if (stateChanging) {
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if (origin === undefined || !allowedOrigins.has(origin) || (fetchSite !== undefined && fetchSite !== 'same-origin')) {
        request.log.warn({ reason: 'origin' }, 'State-changing request rejected');
        throw new PublicHttpError(403, AUTH_MESSAGES.origin);
      }
    }
    if (access === 'public') return;

    // 2. Session from the cookie; role/active flag re-read from the database on every request.
    const token = readCookie(request.headers.cookie, cookieName);
    let session = null;
    if (isWellFormedToken(token)) {
      try {
        session = await store.resolveSession(sessionTokenDigest(token));
      } catch (error) {
        request.log.error({ error: describeError(error) }, 'Session lookup failed');
        throw unavailable();
      }
    }
    if (!session || token === undefined) {
      if (token !== undefined) reply.header('set-cookie', clearedSessionCookie(config.cookieSecure));
      throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    }
    request.auth = { ...session, permissions: permissionsFor(session.role), token };

    // 3. Session-bound CSRF token in a header for authenticated state-changing requests (incl. logout).
    if (stateChanging) {
      const header = request.headers[CSRF_HEADER];
      if (!csrfTokenMatches(token, typeof header === 'string' ? header : undefined)) {
        request.log.warn({ reason: 'csrf' }, 'State-changing request rejected');
        throw new PublicHttpError(403, AUTH_MESSAGES.csrf);
      }
    }

    // 4. Permission check (server-side role → permissions).
    if (typeof access === 'object' && 'permission' in access && !hasPermission(session.role, access.permission)) {
      await auditBestEffort(
        request,
        { event: 'authz.denied', outcome: 'denied', details: { permission: access.permission, route: request.routeOptions.url ?? '' } },
        { actorUserId: session.userId, requestId: request.id },
      );
      throw new PublicHttpError(403, AUTH_MESSAGES.forbidden);
    }
  });

  app.post('/api/auth/login', {
    config: { access: 'public' },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'password'],
        properties: { email: { type: 'string', minLength: 1, maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 1024 } },
      },
      response: { 200: sessionInfoSchema },
    },
  }, async (request, reply) => {
    const { email: rawEmail, password } = request.body as { email: string; password: string };
    const email = normalizeEmail(rawEmail);

    // Rate limits before any database lookup or hashing. The account key is a digest, not the email.
    const accountKey = createHash('sha256').update(email ?? rawEmail.trim().toLowerCase()).digest('base64url');
    // request.ip: socket peer, or — only behind a configured trusted proxy — the address that proxy put in
    // X-Forwarded-For (Fastify trustProxy, ADR-014). Headers are never read here directly. A non-IP result
    // (misconfigured proxy) falls into one shared bucket instead of an attacker-chosen key.
    const addressKey = isIP(request.ip) === 0 ? 'unresolved' : request.ip;
    const retryAfter = Math.max(addressLimiter.hit(addressKey), accountLimiter.hit(accountKey));
    if (retryAfter > 0) throw new PublicHttpError(429, AUTH_MESSAGES.rateLimited, { 'retry-after': String(retryAfter) });

    const fail = async (actorUserId: string | null, reason: 'invalid_credentials' | 'inactive_user'): Promise<never> => {
      await auditBestEffort(request, { event: 'auth.login', outcome: 'failure', details: { reason } }, { actorUserId, requestId: request.id });
      throw new PublicHttpError(401, AUTH_MESSAGES.badCredentials);
    };

    // Malformed input cannot match any account; rejected without touching the database.
    if (email === null || checkPasswordPolicy(password) !== null) return fail(null, 'invalid_credentials');

    let user;
    try {
      user = await store.findLoginUser(email);
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Login lookup failed');
      throw unavailable();
    }

    let valid = false;
    try {
      valid = user ? await verifyPassword(password, user.passwordHash, hashLimiter) : await verifyDummy(password, hashLimiter);
    } catch (error) {
      if (error instanceof BusyError) throw new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': '1' });
      if (!(error instanceof PasswordHashFormatError)) throw error;
      request.log.error({ error: describeError(error) }, 'Stored password hash rejected');
    }
    if (!user || !valid) return fail(user?.id ?? null, 'invalid_credentials');
    if (!user.isActive) return fail(user.id, 'inactive_user');

    // Session fixation: always a fresh token; a presented old session is revoked in the same transaction.
    const presented = readCookie(request.headers.cookie, cookieName);
    const token = newSessionToken();
    let created;
    try {
      created = await store.createSession({
        userId: user.id,
        tokenHash: sessionTokenDigest(token),
        ttlSeconds: config.sessionTtlSeconds,
        previousTokenHash: isWellFormedToken(presented) ? sessionTokenDigest(presented) : null,
        requestId: request.id,
      });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Session creation failed');
      throw unavailable();
    }
    reply.header('set-cookie', sessionCookie(token, { secure: config.cookieSecure, ttlSeconds: config.sessionTtlSeconds }));
    return sessionInfo({ userId: user.id, email: user.email, role: user.role, expiresAt: created.expiresAt, token });
  });

  app.post('/api/auth/logout', { config: { access: 'authenticated' } }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    try {
      await store.revokeSession({ sessionId: auth.sessionId, userId: auth.userId, requestId: request.id });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Logout failed');
      throw unavailable();
    }
    reply.header('set-cookie', clearedSessionCookie(config.cookieSecure));
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { config: { access: 'authenticated' }, schema: { response: { 200: sessionInfoSchema } } }, (request) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    return sessionInfo(auth);
  });

  app.get('/api/audit', {
    config: { access: { permission: 'audit:read' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, beforeId: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['items', 'nextBeforeId'],
          properties: { items: { type: 'array', items: auditItemSchema }, nextBeforeId: { type: ['string', 'null'] } },
        },
      },
    },
  }, async (request) => {
    const { limit, beforeId } = request.query as { limit: number; beforeId?: string };
    try {
      return await store.listAudit({ limit, beforeId: beforeId ?? null });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Audit query failed');
      throw unavailable();
    }
  });
}

