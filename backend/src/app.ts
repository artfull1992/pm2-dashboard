import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { LogLevel } from './config.js';
import { type Database, toSafeError, withTimeout } from './database.js';

export interface LogDestination {
  write(chunk: string): void;
}

export interface BuildAppOptions {
  logLevel: LogLevel;
  readinessTimeoutMs: number;
  /** Called once with the app logger; the app closes the returned database on shutdown. */
  createDatabase: (log: FastifyBaseLogger) => Database;
  /** Log destination override (tests). Defaults to stdout. */
  logStream?: LogDestination;
}

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

const statusSchema = (status: string) => ({
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: [status] } },
});

function loggerOptions(options: BuildAppOptions): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level: options.logLevel,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    serializers: {
      // Path only: query strings may carry tokens. Headers and bodies are never logged.
      req: (req: { method: string; url: string; id: string }) => ({
        method: req.method,
        path: req.url.split('?')[0],
        reqId: req.id,
      }),
    },
    ...(options.logStream ? { stream: options.logStream } : {}),
  };
}

/** Creates the Fastify app. Does not listen on a port and does not install process signal handlers. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(options),
    // Client-supplied IDs are ignored to keep log correlation trustworthy.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  const database = options.createDatabase(app.log.child({ component: 'database' }));
  app.addHook('onClose', async () => {
    await database.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/health/live', { schema: { response: { 200: statusSchema('ok') } } }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  app.get(
    '/health/ready',
    { schema: { response: { 200: statusSchema('ready'), 503: statusSchema('unavailable') } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        await withTimeout(database.check(), options.readinessTimeoutMs);
        return { status: 'ready' };
      } catch (error) {
        // database.check() already attaches a sanitized cause; timeouts from withTimeout carry none.
        const err = error instanceof Error && error.cause !== undefined ? error.cause : toSafeError(error);
        request.log.warn({ err }, 'Readiness check failed');
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );

  app.setNotFoundHandler({}, async (_request, reply) => {
    return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
  });

  app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply.code(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
    }
    // Fastify's own 4xx errors (validation, payload size, content type) carry client-safe messages.
    request.log.info({ err: toSafeError(error) }, 'Client error');
    return reply.code(statusCode).send({ statusCode, error: error.name, message: error.message });
  });

  return app;
}
