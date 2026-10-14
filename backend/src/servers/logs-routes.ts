import type { FastifyInstance } from 'fastify';
import type { AuditContext, AuditEvent } from '../auth/store.js';
import { describeError, PublicHttpError } from '../errors.js';
import {
  type AgentLogReport, agentPollSchema, agentResultSchema, LOG_LIMITS, type LogHub, type LogResult, logStreamSchema, logTargetSchema, resultProblem,
} from './logs.js';

// Bounded authorized log viewing (ADR-018). Browser: logs:read (+ Origin + CSRF for the POST). Machine: the Agent's
// long-poll and result. Log text is only returned to the requesting user and never logged, audited or stored.

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
  serverExists: (id: string) => Promise<boolean>;
  /** Best-effort audit (metadata only). */
  audit: (entry: AuditEvent, context: AuditContext) => Promise<void>;
}

export function registerLogRoutes(app: FastifyInstance, options: LogRoutesOptions): void {
  const { hub, serverExists } = options;
  app.addHook('onClose', (_instance, done) => { hub.close(); done(); });

  const audit = async (log: { error(o: object, m: string): void }, entry: AuditEvent, context: AuditContext) => {
    try {
      await options.audit(entry, context);
    } catch (error) {
      log.error({ error: describeError(error), event: entry.event }, 'Audit write failed');
    }
  };
  const ensureServer = async (id: string, log: { error(o: object, m: string): void }) => {
    let exists: boolean;
    try {
      exists = await serverExists(id);
    } catch (error) {
      log.error({ error: describeError(error) }, 'Server lookup failed');
      throw new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '5' });
    }
    if (!exists) throw new PublicHttpError(404, 'Server not found');
  };

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
    await ensureServer(id, request.log);
    return { serverId: id, ...hub.status(id) };
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
    await ensureServer(id, request.log);
    const context = { actorUserId: auth.userId, requestId: request.id };
    const result = hub.create({ serverId: id, targetKey, actorUserId: auth.userId, lines });
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
    // Only the requesting user sees the result; anything else (other user, expired+cleaned, API restart) → 404.
    // A client that goes away frees its waiter at once (RESPONSE 'close', see the agent long-poll below).
    const view = await hub.get(id, auth.userId, { onClose: (cb) => { if (reply.raw.destroyed) cb(); else reply.raw.once('close', cb); } });
    if (!view) throw new PublicHttpError(404, 'Log request not found');
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
            requests: {
              type: 'array', maxItems: LOG_LIMITS.maxPerPoll,
              items: {
                type: 'object', additionalProperties: false, required: ['requestId', 'targetKey', 'lines', 'deadlineAt'],
                properties: { requestId: { type: 'string' }, targetKey: { type: 'string' }, lines: { type: 'integer' }, deadlineAt: { type: 'string' } },
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
    // Identity from the credential; a disconnected long-poll releases its slot.
    // The RESPONSE 'close' fires only when the connection goes away (or after sending); the request's 'close' fires as
    // soon as its body is consumed and would end every long-poll immediately (busy loop).
    const requests = await hub.agentPoll(agent.serverId, report, (cb) => { reply.raw.once('close', cb); });
    return { requests };
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
