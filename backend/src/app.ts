import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AlertsEngine, createRuntimeSource } from './alerts/engine.js';
import { registerAlertRoutes } from './alerts/routes.js';
import { registerSettingsRoutes } from './alerts/settings-routes.js';
import { createPgSettingsStore, type SettingsStore } from './alerts/settings-store.js';
import { type AlertsStore, createPgAlertsStore } from './alerts/store.js';
import type { Limiter } from './auth/password.js';
import type { RateLimiter } from './auth/rate-limit.js';
import { registerAuth } from './auth/plugin.js';
import { type AuthStore, createPgAuthStore } from './auth/store.js';
import { registerUserRoutes } from './auth/users-routes.js';
import { createPgUserStore, type UserStore } from './auth/users-store.js';
import { createPgControlStore, type ControlStore } from './servers/control-store.js';
import { registerControlRoutes } from './servers/control-routes.js';
import { createPgDashboardStore, type DashboardStore } from './servers/dashboard-store.js';
import { registerDashboardRoutes } from './servers/dashboard-routes.js';
import { LogHub } from './servers/logs.js';
import { registerLogRoutes } from './servers/logs-routes.js';
import { createPgInventoryStore, type InventoryStore } from './servers/inventory-store.js';
import { registerInventoryRoutes } from './servers/inventory-routes.js';
import { registerServerRoutes } from './servers/routes.js';
import { createPgServerStore, type ServerStore } from './servers/store.js';
import { ALERTS_DEFAULTS, type AlertsConfig, type AuthConfig, type LogLevel } from './config.js';
import { type Database, DatabaseCheckError, withTimeout } from './database.js';
import { describeError, toErrorResponse } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The alerts worker (ADR-021/022) when the app runs with an alerts configuration; null otherwise. */
    alertsEngine: AlertsEngine | null;
  }
}

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
  /**
   * Exact peer addresses trusted to set X-Forwarded-For (ADR-014). Empty/omitted → trustProxy off,
   * request.ip is the socket peer and forwarded headers are ignored.
   */
  trustedProxies?: readonly string[];
  /** Enables /api auth routes. Omitted only by health-only tests. */
  auth?: {
    config: AuthConfig;
    /** Test seam; production uses the PostgreSQL store on the shared pool. */
    createStore?: (database: Database) => AuthStore;
    /** Test seam for the server registry / Agent heartbeat store. */
    createServerStore?: (database: Database) => ServerStore;
    /** Test seam: bounds concurrent heartbeat transactions. */
    heartbeatLimiter?: Limiter;
    /** Test seam for the PM2 inventory store (ADR-016). */
    createInventoryStore?: (database: Database) => InventoryStore;
    /** Test seam: bounds concurrent inventory transactions. */
    inventoryLimiter?: Limiter;
    /** PM2_CONTROL_ENABLED (ADR-017); default false — no command can be created or dispatched. */
    controlEnabled?: boolean;
    /** Test seam for the PM2 control store. */
    createControlStore?: (database: Database) => ControlStore;
    /** Test seam: bounds concurrent control transactions. */
    controlLimiter?: Limiter;
    /** Test seam: in-memory log hub (ADR-018). */
    logHub?: LogHub;
    /**
     * Deployment-level alerts configuration (ADR-022). When present (production), settings are initialised on start
     * and the worker runs (it reads engine/delivery switches from the database each cycle). Absent → no worker.
     */
    alerts?: AlertsConfig;
    /** Test seams for alerts: stores and the HTTP transport used for Slack (never the real Slack in tests). */
    createAlertsStore?: (database: Database) => AlertsStore;
    createSettingsStore?: (database: Database) => SettingsStore;
    alertsFetch?: typeof fetch;
    /** Test seam for the dashboard aggregate (ADR-020). */
    createDashboardStore?: (database: Database) => DashboardStore;
    /** Test seam for user administration (ADR-019). */
    createUserStore?: (database: Database) => UserStore;
    /** Test seam: user administration rate limit per actor. */
    userAdminLimiter?: RateLimiter;
    extra?: Omit<Parameters<typeof registerAuth>[1], 'config' | 'store'>;
  };
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
    trustProxy: options.trustedProxies && options.trustedProxies.length > 0 ? [...options.trustedProxies] : false,
    genReqId: () => randomUUID(),
    // Strict schemas: `additionalProperties: false` REJECTS unknown fields (400) instead of Fastify's default of
    // silently stripping them — a spoofed field (e.g. serverId in an Agent payload) is an error, not ignored input.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const database = options.createDatabase(app.log.child({ component: 'database' }));
  app.addHook('onClose', async () => {
    await database.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Graceful shutdown: once close() starts, every response (incl. long-polls released in preClose) closes its
  // connection. Otherwise a keep-alive socket that became idle AFTER close() began keeps the server open until the
  // keep-alive timeout (~72 s) — far beyond the shutdown timeout.
  let closing = false;
  app.addHook('preClose', (done) => { closing = true; done(); });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (closing) reply.header('connection', 'close');
    return payload;
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
        const meta = error instanceof DatabaseCheckError ? error.meta : describeError(error);
        request.log.warn({ error: meta }, 'Readiness check failed');
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );

  if (options.auth) {
    const store = (options.auth.createStore ?? createPgAuthStore)(database);
    const serverStore = (options.auth.createServerStore ?? createPgServerStore)(database);
    registerAuth(app, { agentResolver: serverStore, ...options.auth.extra, config: options.auth.config, store });
    registerUserRoutes(app, {
      store: (options.auth.createUserStore ?? createPgUserStore)(database),
      audit: (entry, context) => store.recordAudit(entry, context),
      ...(options.auth.extra?.hashLimiter ? { hashLimiter: options.auth.extra.hashLimiter } : {}),
      ...(options.auth.userAdminLimiter ? { limiter: options.auth.userAdminLimiter } : {}),
    });
    registerServerRoutes(app, { store: serverStore, ...(options.auth.heartbeatLimiter ? { heartbeatLimiter: options.auth.heartbeatLimiter } : {}) });
    const inventoryStore = (options.auth.createInventoryStore ?? createPgInventoryStore)(database);
    registerInventoryRoutes(app, { store: inventoryStore, ...(options.auth.inventoryLimiter ? { inventoryLimiter: options.auth.inventoryLimiter } : {}) });
    const controlStore = (options.auth.createControlStore ?? createPgControlStore)(database);
    registerControlRoutes(app, {
      store: controlStore, enabled: options.auth.controlEnabled === true,
      ...(options.auth.controlLimiter ? { limiter: options.auth.controlLimiter } : {}),
    });
    registerDashboardRoutes(app, { store: (options.auth.createDashboardStore ?? createPgDashboardStore)(database) });

    // Alerts (ADR-021/022): settings live in the database; the worker runs inside this process when an alerts
    // configuration is supplied. It starts once the app is ready (after the one-time settings initialisation) and
    // stops in preClose (before in-flight requests are awaited and before the database is closed).
    const alertsConfig = options.auth.alerts ?? ALERTS_DEFAULTS;
    const alertsStore = (options.auth.createAlertsStore ?? createPgAlertsStore)(database);
    const settingsStore = (options.auth.createSettingsStore ?? createPgSettingsStore)(database);
    const source = createRuntimeSource(settingsStore, alertsConfig.secretKey);
    const alertsLog = app.log.child({ component: 'alerts' });
    const engine = options.auth.alerts
      ? new AlertsEngine(alertsStore, source, alertsConfig.publicUrl, alertsLog, options.auth.alertsFetch ? { fetchImpl: options.auth.alertsFetch } : {})
      : null;
    if (engine) {
      app.addHook('onReady', async () => {
        try {
          if (await settingsStore.initialize(alertsConfig.defaults)) alertsLog.info({}, 'Alert settings initialised from defaults');
        } catch (error) {
          alertsLog.error({ error: describeError(error) }, 'Alert settings initialisation failed');
        }
        if (alertsConfig.legacy.webhook) alertsLog.warn({ key: 'ALERTS_SLACK_WEBHOOK_URL' }, 'Ignored: the Slack webhook is configured in the admin UI (ADR-022)');
        if (alertsConfig.legacy.flags) alertsLog.warn({ keys: 'ALERTS_ENABLED,ALERTS_DELIVERY_ENABLED' }, 'Ignored: engine/delivery are switched in the admin UI (ADR-022)');
        engine.start();
      });
      app.addHook('preClose', async () => { await engine.stop(); });
    }
    app.decorate('alertsEngine', engine);
    registerAlertRoutes(app, { store: alertsStore, source, publicUrlConfigured: alertsConfig.publicUrl !== null, stats: () => engine?.stats() ?? null });
    registerSettingsRoutes(app, {
      settings: settingsStore, alerts: alertsStore, source, secretKey: alertsConfig.secretKey, publicUrl: alertsConfig.publicUrl,
      ...(options.auth.alertsFetch ? { fetchImpl: options.auth.alertsFetch } : {}),
    });
    registerLogRoutes(app, {
      hub: options.auth.logHub ?? new LogHub(),
      serverExists: async (id) => (await serverStore.get(id)) !== null,
      audit: (entry, context) => store.recordAudit(entry, context),
    });
  }

  app.setNotFoundHandler({}, async (_request, reply) => {
    return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
  });

  // Thrown values are untrusted: neither the response nor the log ever contains their message/name/cause/stack.
  app.setErrorHandler(async (error: unknown, request, reply) => {
    const meta = describeError(error);
    const { statusCode, body, headers } = toErrorResponse(error);
    if (statusCode >= 500) request.log.error({ error: meta }, 'Unhandled error');
    else request.log.info({ error: meta, statusCode }, 'Client error');
    if (headers) reply.headers(headers);
    return reply.code(statusCode).send(body);
  });

  return app;
}
