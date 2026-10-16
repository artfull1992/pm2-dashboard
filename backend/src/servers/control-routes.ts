import type { FastifyInstance } from 'fastify';
import { BusyError, createLimiter, type Limiter } from '../auth/password.js';
import { describeError, PublicHttpError } from '../errors.js';
import {
  commandBodySchema, commandViewSchema, type ControlAction, type PollReport, pollProblem, pollSchema, POLL_BODY_LIMIT,
  POLL_INTERVAL_DISABLED_SECONDS, POLL_INTERVAL_ENABLED_SECONDS, RESULT_BODY_LIMIT, type ResultReport, resultProblem,
  resultSchema, targetSchema, TARGET_FRESH_SECONDS,
} from './control.js';
import type { ControlStore } from './control-store.js';

// Allowlisted PM2 control API (ADR-017). Browser: read for monitoring:read, command creation for processes:control
// (session + exact Origin + CSRF, enforced by the auth plugin). Machine: poll + result for the Agent credential only.

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } as const;
const unavailable = () => new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '5' });

const CONFLICT_MESSAGES = {
  control_disabled: 'Process control is disabled',
  server_offline: 'Server is offline',
  target_unavailable: 'Target is not available for control',
  action_not_allowed: 'Action is not allowed for this target',
  command_in_progress: 'Another command for this target is in progress',
  idempotency_conflict: 'Idempotency key was used for a different request',
} as const;

export interface ControlRoutesOptions {
  store: ControlStore;
  /** PM2_CONTROL_ENABLED (default false): when off, no command can be created or dispatched. */
  enabled: boolean;
  limiter?: Limiter;
}

export function registerControlRoutes(app: FastifyInstance, options: ControlRoutesOptions): void {
  const { store, enabled } = options;
  const limiter = options.limiter ?? createLimiter(4, 8);

  const guarded = async <T>(log: { error(o: object, m: string): void }, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await limiter.run(fn);
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      if (!(error instanceof BusyError)) log.error({ error: describeError(error) }, `${what} failed`);
      throw unavailable();
    }
  };

  app.get('/api/servers/:id/control', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      params: idParams,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['serverId', 'enabled', 'serverStatus', 'broker', 'targets', 'targetFreshSeconds'],
          properties: {
            serverId: { type: 'string' }, enabled: { type: 'boolean' },
            serverStatus: { type: 'string', enum: ['online', 'offline', 'never_connected'] },
            broker: {
              anyOf: [{ type: 'null' }, {
                type: 'object', additionalProperties: false, required: ['state', 'daemon', 'allowlist', 'reportedAt', 'fresh'],
                properties: {
                  state: { type: 'string', enum: ['ok', 'unavailable'] }, daemon: { type: ['string', 'null'] }, allowlist: { type: ['string', 'null'] },
                  reportedAt: { type: 'string' }, fresh: { type: 'boolean' },
                },
              }],
            },
            targets: { type: 'array', items: targetSchema }, targetFreshSeconds: { type: 'integer' },
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await guarded(request.log, 'Control view', () => store.controlView(id));
    if (!view) throw new PublicHttpError(404, 'Server not found');
    return { ...view, enabled, targetFreshSeconds: TARGET_FRESH_SECONDS };
  });

  app.get('/api/servers/:id/control-commands', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      params: idParams,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, targetKey: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
      },
      response: { 200: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: commandViewSchema } } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { limit, targetKey } = request.query as { limit: number; targetKey?: string };
    const items = await guarded(request.log, 'Command list', () => store.listCommands(id, limit, targetKey ?? null));
    if (!items) throw new PublicHttpError(404, 'Server not found');
    return { items };
  });

  app.get('/api/control-commands/:id', {
    config: { access: { permission: 'monitoring:read' } },
    schema: { params: idParams, response: { 200: commandViewSchema } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const command = await guarded(request.log, 'Command lookup', () => store.getCommand(id));
    if (!command) throw new PublicHttpError(404, 'Command not found');
    return command;
  });

  app.post('/api/servers/:id/control-commands', {
    config: { access: { permission: 'processes:control' } },
    schema: { params: idParams, body: commandBodySchema, response: { 200: commandViewSchema, 201: commandViewSchema } },
  }, async (request, reply) => {
    if (!enabled) throw new PublicHttpError(409, CONFLICT_MESSAGES.control_disabled);
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, 'Authentication required');
    const { id } = request.params as { id: string };
    const body = request.body as { targetKey: string; action: ControlAction; idempotencyKey: string };
    const result = await guarded(request.log, 'Command creation', () => store.createCommand({
      serverId: id, targetKey: body.targetKey, action: body.action, idempotencyKey: body.idempotencyKey, actorUserId: auth.userId, requestId: request.id,
    }));
    if (result === 'not_found') throw new PublicHttpError(404, 'Server not found');
    if (typeof result === 'string') throw new PublicHttpError(409, CONFLICT_MESSAGES[result]);
    // 201 = new command; 200 = the same request replayed with the same idempotency key (no new command).
    return reply.code(result.created ? 201 : 200).send(result.command);
  });

  app.post('/api/agent/control/poll', {
    config: { access: { machine: 'agent' } },
    bodyLimit: POLL_BODY_LIMIT,
    schema: {
      body: pollSchema,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['controlEnabled', 'commands', 'intervalSeconds'],
          properties: {
            controlEnabled: { type: 'boolean' }, intervalSeconds: { type: 'integer' },
            commands: {
              type: 'array', maxItems: 1,
              items: {
                type: 'object', additionalProperties: false, required: ['id', 'attempt', 'targetKey', 'action', 'deadlineAt'],
                properties: { id: { type: 'string' }, attempt: { type: 'integer' }, targetKey: { type: 'string' }, action: { type: 'string' }, deadlineAt: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const agent = request.agent;
    if (!agent) throw new PublicHttpError(401, 'Agent credential missing or invalid');
    const report = request.body as PollReport;
    if (pollProblem(report)) throw new PublicHttpError(400, 'Invalid control report');
    const result = await guarded(request.log, 'Control poll', () => store.poll({ tokenHash: agent.tokenHash, report, controlEnabled: enabled }));
    if (result === 'unauthorized') throw new PublicHttpError(401, 'Agent credential missing or invalid');
    return { controlEnabled: enabled, commands: result.commands, intervalSeconds: enabled ? POLL_INTERVAL_ENABLED_SECONDS : POLL_INTERVAL_DISABLED_SECONDS };
  });

  app.post('/api/agent/control/result', {
    config: { access: { machine: 'agent' } },
    bodyLimit: RESULT_BODY_LIMIT,
    schema: {
      body: resultSchema,
      response: { 200: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['recorded', 'duplicate'] } } } },
    },
  }, async (request) => {
    const agent = request.agent;
    if (!agent) throw new PublicHttpError(401, 'Agent credential missing or invalid');
    const result = request.body as ResultReport;
    if (resultProblem(result)) throw new PublicHttpError(400, 'Invalid command result');
    // Results are accepted even when control is disabled: a command already in the broker must be able to finish.
    const status = await guarded(request.log, 'Command result', () => store.recordResult({ tokenHash: agent.tokenHash, result }));
    if (status === 'unauthorized') throw new PublicHttpError(401, 'Agent credential missing or invalid');
    if (status === 'not_found') throw new PublicHttpError(404, 'Command not found');
    if (status === 'conflict') throw new PublicHttpError(409, 'Command is not awaiting this result');
    return { status };
  });
}
