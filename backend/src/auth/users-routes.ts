import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describeError, PublicHttpError } from '../errors.js';
import { normalizeEmail } from './email.js';
import { BusyError, checkPasswordPolicy, DEFAULT_HASH_LIMITER, hashPassword, type Limiter } from './password.js';
import { AUTH_MESSAGES } from './plugin.js';
import { createRateLimiter, type RateLimiter, USER_ADMIN_LIMITS } from './rate-limit.js';
import { ROLES } from './rbac.js';
import type { AuditEvent, AuthStore } from './store.js';
import type { Role } from './rbac.js';
import type { UserStore } from './users-store.js';

// User administration API (ADR-019). users:manage only; Origin + CSRF for every mutation (plugin.ts). The actor,
// its session and the role matrix come from the server; the store re-checks the actor under a lock at commit time.

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const userViewSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'email', 'role', 'isActive', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, isActive: { type: 'boolean' },
    createdAt: { type: 'string' }, updatedAt: { type: 'string' },
  },
} as const;

export const USER_MESSAGES = Object.freeze({
  invalid: 'Invalid email, password or role',
  emailTaken: 'A user with this email already exists',
  notFound: 'User not found',
  selfChange: 'You cannot change your own role or activity',
  lastAdmin: 'At least one active administrator must remain',
  rateLimited: 'Too many user administration requests, try again later',
});

export interface UserRoutesOptions {
  store: UserStore;
  /** Best-effort audit of refusals (metadata only), like authz.denied. */
  audit: AuthStore['recordAudit'];
  hashLimiter?: Limiter;
  limiter?: RateLimiter;
}

export function registerUserRoutes(app: FastifyInstance, options: UserRoutesOptions): void {
  const { store } = options;
  const hashLimiter = options.hashLimiter ?? DEFAULT_HASH_LIMITER;
  const limiter = options.limiter ?? createRateLimiter(USER_ADMIN_LIMITS.perActor);
  const unavailable = (retryAfter = '5') => new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': retryAfter });

  const audit = async (request: FastifyRequest, entry: AuditEvent, actorUserId: string) => {
    try {
      await options.audit(entry, { actorUserId, requestId: request.id });
    } catch (error) {
      request.log.error({ error: describeError(error), event: entry.event }, 'Audit write failed');
    }
  };
  const actorOf = (request: FastifyRequest) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    const retryAfter = request.method === 'GET' ? 0 : limiter.hit(auth.userId);
    if (retryAfter > 0) throw new PublicHttpError(429, USER_MESSAGES.rateLimited, { 'retry-after': String(retryAfter) });
    return { userId: auth.userId, sessionId: auth.sessionId };
  };
  /** The actor lost admin rights or its session between the request check and the commit. */
  const actorRevoked = () => new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);

  app.get('/api/users', {
    config: { access: { permission: 'users:manage' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, after: { type: 'string', pattern: UUID_PATTERN } },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['items', 'nextAfter'],
          properties: { items: { type: 'array', items: userViewSchema }, nextAfter: { type: ['string', 'null'] } },
        },
      },
    },
  }, async (request) => {
    actorOf(request);
    const { limit, after } = request.query as { limit: number; after?: string };
    try {
      return await store.listUsers({ limit, after: after ?? null });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'User list failed');
      throw unavailable();
    }
  });

  app.post('/api/users', {
    config: { access: { permission: 'users:manage' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'password', 'role'],
        properties: {
          email: { type: 'string', minLength: 1, maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 1024 },
          role: { type: 'string', enum: ROLES },
        },
      },
      response: { 201: userViewSchema },
    },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const body = request.body as { email: string; password: string; role: Role };
    const email = normalizeEmail(body.email);
    if (email === null || checkPasswordPolicy(body.password) !== null) throw new PublicHttpError(400, USER_MESSAGES.invalid);
    let passwordHash;
    try {
      passwordHash = await hashPassword(body.password, hashLimiter);
    } catch (error) {
      if (error instanceof BusyError) throw unavailable('1');
      throw error;
    }
    let result;
    try {
      result = await store.createUser({ actor, email, passwordHash, role: body.role, requestId: request.id });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'User creation failed');
      throw unavailable();
    }
    if (result.status === 'actor_revoked') throw actorRevoked();
    if (result.status === 'email_taken') {
      await audit(request, { event: 'user.create_rejected', outcome: 'failure', details: { reason: 'email_taken' } }, actor.userId);
      throw new PublicHttpError(409, USER_MESSAGES.emailTaken);
    }
    return reply.code(201).send(result.user);
  });

  app.patch('/api/users/:id', {
    config: { access: { permission: 'users:manage' } },
    // Ajv type coercion would turn "false" into false: activity must be a real JSON boolean.
    preValidation: (request, _reply, done) => {
      const body = request.body as Record<string, unknown> | null;
      if (body && typeof body === 'object' && 'isActive' in body && typeof body.isActive !== 'boolean') { done(new PublicHttpError(400, USER_MESSAGES.invalid)); return; }
      done();
    },
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } },
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { role: { type: 'string', enum: ROLES }, isActive: { type: 'boolean' } },
      },
      response: { 200: userViewSchema },
    },
  }, async (request) => {
    const actor = actorOf(request);
    const { id } = request.params as { id: string };
    const { role, isActive } = request.body as { role?: Role; isActive?: boolean };
    const denied = async (reason: 'self_change' | 'last_admin', status: 403 | 409, message: string): Promise<never> => {
      await audit(request, { event: 'user.update_rejected', outcome: 'denied', details: { targetUserId: id, reason } }, actor.userId);
      throw new PublicHttpError(status, message);
    };
    // Own account: refused before any database work (the store checks it again under the lock).
    if (id === actor.userId) return denied('self_change', 403, USER_MESSAGES.selfChange);
    let result;
    try {
      result = await store.updateUser({ actor, targetId: id, ...(role === undefined ? {} : { role }), ...(isActive === undefined ? {} : { isActive }), requestId: request.id });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'User update failed');
      throw unavailable();
    }
    switch (result.status) {
      case 'updated': return result.user;
      case 'actor_revoked': throw actorRevoked();
      case 'not_found': throw new PublicHttpError(404, USER_MESSAGES.notFound);
      case 'self_change': return denied('self_change', 403, USER_MESSAGES.selfChange);
      case 'last_admin': return denied('last_admin', 409, USER_MESSAGES.lastAdmin);
    }
  });
}
