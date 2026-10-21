import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../auth/rbac.js';
import { type AccessChecker, requestScope, type Scope, scopeOf } from '../auth/scope.js';
import type { AuditContext, AuditEvent } from '../auth/store.js';
import { describeError, PublicHttpError } from '../errors.js';
import {
  type AgentLogReport, agentPollSchema, agentResultSchema, LOG_LIMITS, type LogHub, type LogResult, logStreamSchema, logTargetSchema, resultProblem,
} from './logs.js';

// Bounded authorized log viewing (ADR-018). Browser: logs:read (+ Origin + CSRF for the POST). Machine: the Agent's
// long-poll and result. Log text is only returned to the requesting user and never logged, audited or stored.
//
// ADR-028 (review e621e31): access is decided NOW, not when a request started. Before any result is handed out the
// session, active flag and role are re-read (app.revalidateSession — the same lookup as every request) and the grant
// is checked with the scope derived from them; before a queued request is handed to the Agent its requester's current
// role/active flag/grant are re-read too, and the request carries the service name and definition identity it was
// authorised for, so a broker (protocol v2) refuses a changed target instead of reading it.

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } as const;

const CONFLICTS = {
  not_connected: 'Log viewing is not available: the agent is not connected or does not support it',
  unsupported: 'Log viewing is not supported by this server\'s agent or broker',
  broker_unavailable: 'Log viewing is temporarily unavailable on this server',
  target_not_allowed: 'Logs of this service are not allowed',
} as const;

const resultViewSchema = {
  anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, required: ['outcome', 'reason', 'readAt', 'stdout', 'stderr'],
    properties: { outcome: { type: 'string' }, reason: { type: ['string', 'null'] }, readAt: { type: 'string' }, stdout: logStreamSchema, stderr: logStreamSchema },
  }],
} as const;

export interface LogRoutesOptions {
  hub: LogHub;
  /** Resource scope (ADR-028): every target list, request and result read is checked against it. */
  access: AccessChecker;
  /** Best-effort audit (metadata only). */
  audit: (entry: AuditEvent, context: AuditContext) => Promise<void>;
}

export function registerLogRoutes(app: FastifyInstance, options: LogRoutesOptions): void {
  const { hub, access } = options;
  // preClose runs BEFORE Fastify waits for in-flight requests: held Agent long-polls and result waiters are answered
  // here, so the server can finish closing. In onClose (after that wait) a 25 s long-poll would stall the shutdown
  // past its timeout. onClose repeats it idempotently for paths that skip preClose.
  app.addHook('preClose', (done) => { hub.close(); done(); });
  app.addHook('onClose', (_instance, done) => { hub.close(); done(); });

  const audit = async (log: { error(o: object, m: string): void }, entry: AuditEvent, context: AuditContext) => {
    try {
      await options.audit(entry, context);
    } catch (error) {
      log.error({ error: describeError(error), event: entry.event }, 'Audit write failed');
    }
  };
  const checked = async <T>(log: { error(o: object, m: string): void }, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      log.error({ error: describeError(error) }, 'Access lookup failed');
      throw new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '5' });
    }
  };
  // Missing and not granted look the same (ADR-028).
  const ensureServer = async (id: string, scope: Scope, log: { error(o: object, m: string): void }) => {
    if (!(await checked(log, () => access.serverVisible(scope, id)))) throw new PublicHttpError(404, 'Server not found');
  };
  const serviceVisible = async (scope: Scope, serverId: string, name: string, log: { error(o: object, m: string): void }) =>
    (await checked(log, () => access.visibleServices(scope, serverId, [name]))).has(name);

  app.get('/api/servers/:id/log-targets', {
    config: { access: { permission: 'logs:read' } },
    schema: {
      params: idParams,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['serverId', 'state', 'reportedAt', 'targets'],
          properties: {
            serverId: { type: 'string' }, state: { type: 'string', enum: ['supported', 'not_connected', 'unsupported', 'broker_unavailable'] },
            reportedAt: { type: ['string', 'null'] }, targets: { type: 'array', items: logTargetSchema },
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const scope = requestScope(request.auth);
    await ensureServer(id, scope, request.log);
    const status = hub.status(id, scope !== null);
    // Only the services the user may see: hidden names are neither listed nor counted.
    const visible = await checked(request.log, () => access.visibleServices(scope, id, status.targets.map((t) => t.name)));
    return { serverId: id, ...status, targets: status.targets.filter((t) => visible.has(t.name)) };
  });

  app.post('/api/servers/:id/log-requests', {
    config: { access: { permission: 'logs:read' } },
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['targetKey'],
        properties: { targetKey: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' }, lines: { type: 'integer', minimum: 1, maximum: LOG_LIMITS.maxLines, default: LOG_LIMITS.maxLines } },
      },
      response: { 202: { type: 'object', additionalProperties: false, required: ['requestId', 'deadlineAt'], properties: { requestId: { type: 'string' }, deadlineAt: { type: 'string' } } } },
    },
  }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, 'Authentication required');
    const { id } = request.params as { id: string };
    const { targetKey, lines } = request.body as { targetKey: string; lines: number };
    const scope = requestScope(auth);
    await ensureServer(id, scope, request.log);
    const context = { actorUserId: auth.userId, requestId: request.id };
    // The service of the target as currently reported; a hidden one is answered exactly like a missing one.
    const status = hub.status(id, scope !== null);
    const reported = status.targets.find((t) => t.targetKey === targetKey);
    const serviceName = reported && (await serviceVisible(scope, id, reported.name, request.log)) ? reported.name : null;
    const result = status.state !== 'supported' ? status.state
      : serviceName === null ? 'target_not_allowed' as const
        : hub.create({ serverId: id, targetKey, serviceName, actorUserId: auth.userId, lines, scoped: scope !== null });
    if (result === 'rate_limited') throw new PublicHttpError(429, 'Too many log requests', { 'retry-after': '10' });
    if (result === 'busy') throw new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '5' });
    if (typeof result === 'string') {
      if (result === 'target_not_allowed') await audit(request.log, { event: 'logs.view_denied', outcome: 'denied', details: { serverId: id, targetKey, reason: result } }, context);
      throw new PublicHttpError(409, CONFLICTS[result]);
    }
    // Opening a viewer is audited, its 5-second auto-refresh is not (throttled per actor/server/target).
    if (result.audit) await audit(request.log, { event: 'logs.view_opened', outcome: 'success', details: { serverId: id, targetKey } }, context);
    return reply.code(202).send({ requestId: result.request.requestId, deadlineAt: result.request.deadlineAt });
  });

  app.get('/api/log-requests/:id', {
    config: { access: { permission: 'logs:read' } },
    schema: {
      params: idParams,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['requestId', 'serverId', 'targetKey', 'status', 'deadlineAt', 'result'],
          properties: {
            requestId: { type: 'string' }, serverId: { type: 'string' }, targetKey: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'done', 'expired'] }, deadlineAt: { type: 'string' }, result: resultViewSchema,
          },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, 'Authentication required');
    const { id } = request.params as { id: string };
    const scope = requestScope(auth);
    // Only the requesting user sees the result; anything else (other user, expired+cleaned, API restart) → 404.
    // The access is checked before waiting AND after it (ADR-028): a long-poll or a cached result after the grant was
    // revoked gets 404 like an unknown request.
    const own = hub.peek(id, auth.userId);
    if (!own || !(await serviceVisible(scope, own.serverId, own.serviceName, request.log))) throw new PublicHttpError(404, 'Log request not found');
    // A client that goes away frees its waiter at once (RESPONSE 'close', see the agent long-poll below).
    const view = await hub.get(id, auth.userId, { onClose: (cb) => { if (reply.raw.destroyed) cb(); else reply.raw.once('close', cb); } });
    if (!view) throw new PublicHttpError(404, 'Log request not found');
    if (typeof view === 'object') {
      // After the wait (or a cached result): the session, active flag and role as they are now — never the ones from
      // before the wait (a captured admin scope is not a lasting permission). Then the grant with the CURRENT scope.
      const now = await app.revalidateSession(request, reply);
      if (!now) throw new PublicHttpError(401, 'Authentication required');
      if (!hasPermission(now.role, 'logs:read')) throw new PublicHttpError(403, 'Forbidden');
      const current = scopeOf(now);
      // A result read by a version-1 Agent was not verified by the broker at read time: admins only.
      if ((view.legacy && current !== null) || !(await serviceVisible(current, view.serverId, view.serviceName, request.log))) {
        throw new PublicHttpError(404, 'Log request not found');
      }
    }
    if (view === 'limit_request' || view === 'limit_actor') throw new PublicHttpError(429, 'Too many waiting log reads', { 'retry-after': '1' });
    if (view === 'limit_global') throw new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '2' });
    return view;
  });

  app.post('/api/agent/logs/poll', {
    config: { access: { machine: 'agent' } },
    bodyLimit: LOG_LIMITS.pollBodyBytes,
    schema: {
      body: agentPollSchema,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['requests'],
          properties: {
            // Version 2 only (ADR-028): every log read is authorised per user and service.
            accessModel: { type: 'string', enum: ['scoped'] },
            requests: {
              type: 'array', maxItems: LOG_LIMITS.maxPerPoll,
              items: {
                type: 'object', additionalProperties: false, required: ['requestId', 'targetKey', 'lines', 'deadlineAt'],
                properties: {
                  requestId: { type: 'string' }, targetKey: { type: 'string' }, lines: { type: 'integer' }, deadlineAt: { type: 'string' },
                  // Version 2 only: what the target must still be when the broker reads it.
                  name: { type: 'string' }, identity: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const agent = request.agent;
    if (!agent) throw new PublicHttpError(401, 'Agent credential missing or invalid');
    const report = request.body as AgentLogReport;
    if (new Set(report.targets.map((t) => t.targetKey)).size !== report.targets.length) throw new PublicHttpError(400, 'Invalid log report');
    // Version 2: a matched target always carries its identity, an unmatched one never.
    if (report.version === 2 && report.targets.some((t) => (t.matchStatus === 'ok') !== (typeof t.identity === 'string'))) throw new PublicHttpError(400, 'Invalid log report');
    if (report.version === 2 && report.total !== undefined && report.total < report.targets.length) throw new PublicHttpError(400, 'Invalid log report');
    // Identity from the credential; a disconnected long-poll releases its slot.
    // The RESPONSE 'close' fires only when the connection goes away (or after sending); the request's 'close' fires as
    // soon as its body is consumed and would end every long-poll immediately (busy loop).
    const taken = await hub.agentPoll(agent.serverId, report, (cb) => { reply.raw.once('close', cb); });
    // The requester's rights NOW (role, active flag, grant) before anything is handed to the Agent; a version-1 Agent
    // only serves admins (it cannot verify the target at read time). A refused request ends rejected, unread.
    const requests = [];
    for (const t of taken) {
      let allowed = false;
      try {
        const actor = await access.actorScope(t.actorUserId, 'logs:read');
        allowed = actor !== null && (report.version === 2 || actor.scope === null)
          && (await access.visibleServices(actor.scope, agent.serverId, [t.name])).has(t.name);
      } catch (error) {
        request.log.error({ error: describeError(error) }, 'Access lookup failed');
      }
      if (!allowed) { hub.reject(t.requestId, 'not_authorized'); continue; }
      const base = { requestId: t.requestId, targetKey: t.targetKey, lines: t.lines, deadlineAt: t.deadlineAt };
      requests.push(report.version === 2 ? { ...base, name: t.name, identity: t.identity } : base);
    }
    return { requests, ...(report.version === 2 ? { accessModel: 'scoped' as const } : {}) };
  });

  app.post('/api/agent/logs/result', {
    config: { access: { machine: 'agent' } },
    bodyLimit: LOG_LIMITS.resultBodyBytes,
    schema: { body: agentResultSchema, response: { 200: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['recorded'] } } } } },
  }, (request) => {
    const agent = request.agent;
    if (!agent) throw new PublicHttpError(401, 'Agent credential missing or invalid');
    const body = request.body as LogResult & { requestId: string };
    const result: LogResult = { outcome: body.outcome, reason: body.reason, readAt: body.readAt, stdout: body.stdout, stderr: body.stderr };
    if (resultProblem(result)) throw new PublicHttpError(400, 'Invalid log result');
    const status = hub.agentResult(agent.serverId, body.requestId, result);
    if (status === 'not_found') throw new PublicHttpError(404, 'Log request not found');
    if (status === 'conflict') throw new PublicHttpError(409, 'Log request is not awaiting a result');
    return { status };
  });
}
