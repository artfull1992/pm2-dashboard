import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { RpcError, callDaemon } from '../pm2/rpc.js';
import { readAllowlist } from './allowlist.js';
import { listLogTargets, readLogs } from './logs.js';
import { LOG_LIMITS, type LogsRequest, type LogsResponse, type LogTargetsRequest, type LogTargetsResponse, parseLogsRequest } from './logs-protocol.js';
import { executeCommand, type ExecutorDeps, listTargets, type Pm2ActionMethod } from './executor.js';
import { Journal } from './journal.js';
import { type BrokerRequest, type BrokerResponse, type ExecuteResult, MAX_FRAME_BYTES, parseBrokerRequest } from './protocol.js';

// Local PM2 control broker (ADR-017): runs as the PM2 owner, listens ONLY on a unix socket (0660, group
// nc-pm2-control → the Agent), executes typed actions for allowlisted targets one at a time. No network, no shell.

export interface BrokerConfig {
  pm2Home: string;
  socketPath: string;
  allowlistPath: string;
  journalDir: string;
  pm2TimeoutMs: number;
  allowSelfOwnedAllowlist: boolean;
  /** Directories log files may be read from (ADR-018); default <PM2_HOME>/logs. */
  logDirs: string[];
}

export class BrokerConfigError extends Error {
  constructor(readonly issues: string[]) {
    super('invalid broker configuration');
  }
}

const absolute = (v: string | undefined, key: string, issues: string[], fallback?: string): string => {
  const value = v === undefined || v === '' ? fallback : v;
  if (!value || !isAbsolute(value) || normalize(value) !== value || value.endsWith('/') || value.includes('\0')) {
    issues.push(`${key} must be a normalized absolute path`);
    return '';
  }
  return value;
};

export function loadBrokerConfig(env: Record<string, string | undefined>, uid: number = process.getuid?.() ?? -1): BrokerConfig {
  const issues: string[] = [];
  if (uid === 0) issues.push('the broker must not run as root: run it as the PM2 owner');
  const pm2Home = absolute(env.NC_PM2_HOME, 'NC_PM2_HOME', issues);
  const socketPath = absolute(env.NC_BROKER_SOCKET, 'NC_BROKER_SOCKET', issues, '/run/goit-node-control-pm2-broker/broker.sock');
  const allowlistPath = absolute(env.NC_BROKER_ALLOWLIST, 'NC_BROKER_ALLOWLIST', issues);
  const journalDir = absolute(env.NC_BROKER_JOURNAL_DIR, 'NC_BROKER_JOURNAL_DIR', issues, '/var/lib/goit-node-control-pm2-broker');
  if (pm2Home && socketPath && !relative(pm2Home, socketPath).startsWith('..')) issues.push('NC_BROKER_SOCKET must not be inside NC_PM2_HOME');
  const rawTimeout = env.NC_PM2_TIMEOUT_SECONDS ?? '20';
  if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 1 || Number(rawTimeout) > 60) issues.push('NC_PM2_TIMEOUT_SECONDS must be an integer 1..60');
  const logDirs = (env.NC_BROKER_LOG_DIRS ?? (pm2Home ? `${pm2Home}/logs` : '')).split(',').map((d) => d.trim()).filter((d) => d !== '');
  for (const d of logDirs) {
    if (!isAbsolute(d) || normalize(d) !== d || d.endsWith('/') || d === '/' || /^\/(proc|sys|dev)(\/|$)/.test(d)) issues.push('NC_BROKER_LOG_DIRS must list normalized absolute directories (not /, /proc, /sys, /dev)');
  }
  if (logDirs.length > 8) issues.push('NC_BROKER_LOG_DIRS allows at most 8 directories');
  if (issues.length > 0) throw new BrokerConfigError(issues);
  return {
    pm2Home, socketPath, allowlistPath, journalDir, pm2TimeoutMs: Number(rawTimeout) * 1000,
    allowSelfOwnedAllowlist: env.NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST === 'true', logDirs,
  };
}

/** Executor dependencies bound to the real daemon socket, allowlist file and journal. */
export function realDeps(config: BrokerConfig, uid: number = process.getuid?.() ?? -1): ExecutorDeps {
  const socketPath = join(config.pm2Home, 'rpc.sock');
  const ensureDaemonSocket = async () => {
    try {
      const s = await lstat(socketPath);
      if (!s.isSocket() || s.uid !== uid) throw new RpcError('daemon_not_running');
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('daemon_not_running');
    }
  };
  return {
    loadAllowlist: () => readAllowlist(config.allowlistPath, { ownerUid: 0, selfUid: uid, allowSelfOwned: config.allowSelfOwnedAllowlist }),
    list: async () => {
      await ensureDaemonSocket();
      const raw = await callDaemon({ socketPath, timeoutMs: config.pm2TimeoutMs }, 'getMonitorData', {});
      if (!Array.isArray(raw)) throw new RpcError('protocol_error');
      return raw as unknown[];
    },
    act: async (method: Pm2ActionMethod, pmId: number) => {
      await ensureDaemonSocket();
      // restartProcessId takes {id}; without `env` PM2 does not merge any configuration change (ADR-017).
      await callDaemon({ socketPath, timeoutMs: config.pm2TimeoutMs }, method, method === 'restartProcessId' ? { id: pmId } : pmId);
    },
    journal: new Journal(config.journalDir),
    logDirs: config.logDirs,
  };
}

/** Keeps only log directories that exist and are their own real path (no symlinked directory is trusted). */
export async function verifiedLogDirs(dirs: readonly string[]): Promise<string[]> {
  const ok: string[] = [];
  for (const d of dirs) {
    try {
      if ((await realpath(d)) === d && (await lstat(d)).isDirectory()) ok.push(d);
    } catch {
      // missing directory: no logs can be read from it
    }
  }
  return ok;
}

export interface BrokerLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
}

export const MAX_PENDING_EXECUTIONS = 4;

export interface BrokerOptions {
  /** Reply deadline of one log read (default LOG_LIMITS.readTimeoutMs; tests shorten it). */
  logReadTimeoutMs?: number;
}

/** Socket server. One request per connection; executions are serialised (one PM2 action at a time). */
export function createBroker(deps: ExecutorDeps, logger: BrokerLogger, options: BrokerOptions = {}): {
  server: Server; idle: () => Promise<void>; logStats: () => { inFlight: number; overdue: number };
} {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;

  // Log reads (ADR-018) are read-only and independent of the action chain: bounded concurrency + reply timeout.
  // The file/PM2 calls of a read cannot be cancelled, so a slot is held until the read itself settles — a reply
  // timeout answers the client but does not free the slot (otherwise hung reads would pile up past the limit).
  const readTimeoutMs = options.logReadTimeoutMs ?? LOG_LIMITS.readTimeoutMs;
  let logReads = 0;
  let overdue = 0;
  const handleLogs = async (req: LogTargetsRequest | LogsRequest): Promise<LogTargetsResponse | LogsResponse> => {
    const logDeps = { loadAllowlist: deps.loadAllowlist, list: deps.list, logDirs: deps.logDirs ?? [] };
    if (req.op === 'logTargets') return listLogTargets(logDeps);
    const busy = (reason: 'broker_busy' | 'timeout'): LogsResponse =>
      ({ v: 1, op: 'logs', requestId: req.requestId, outcome: 'failed', reason, readAt: new Date().toISOString(), stdout: null, stderr: null });
    if (logReads >= LOG_LIMITS.maxConcurrentReads) return busy('broker_busy');
    logReads += 1;
    const started = Date.now();
    let late = false;
    // Released exactly once, when the read settles (resolve or reject), never on the reply timeout.
    const read = readLogs(req, logDeps).finally(() => {
      logReads -= 1;
      if (!late) return;
      overdue -= 1;
      logger.info({ msg: 'log read settled late', requestId: req.requestId, durationMs: Date.now() - started, inFlight: logReads });
    });
    read.catch(() => undefined); // after a timeout nobody awaits it: a late rejection must not become unhandled
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<LogsResponse>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        overdue += 1;
        // Metadata only: a hung read stays visible until it settles.
        logger.warn({ msg: 'log read overdue', requestId: req.requestId, inFlight: logReads, overdue });
        resolve(busy('timeout'));
      }, readTimeoutMs);
    });
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const handle = async (req: BrokerRequest): Promise<BrokerResponse> => {
    if (req.op === 'list') return { v: 1, op: 'list', ...(await listTargets(deps)) };
    if (pending >= MAX_PENDING_EXECUTIONS) {
      return { v: 1, op: 'execute', commandId: req.commandId, outcome: 'rejected', reason: 'broker_busy', before: null, after: null };
    }
    pending += 1;
    const run = chain.then(async () => {
      const started = Date.now();
      const r: ExecuteResult = await executeCommand(req, deps);
      logger.info({ msg: 'command', commandId: req.commandId, targetKey: req.targetKey, action: req.action, outcome: r.outcome, reason: r.reason, durationMs: Date.now() - started });
      return r;
    });
    chain = run.catch(() => undefined).finally(() => { pending -= 1; });
    return run;
  };

  const server = createServer({ allowHalfOpen: false }, (socket: Socket) => {
    socket.setTimeout(90_000, () => { socket.destroy(); });
    let buffer = '';
    let done = false;
    socket.setEncoding('utf8');
    socket.on('error', () => { socket.destroy(); });
    socket.on('data', (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { done = true; socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      done = true;
      let req: BrokerRequest | null = null;
      let logReq: LogTargetsRequest | LogsRequest | null = null;
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, newline));
        req = parseBrokerRequest(parsed);
        if (!req && typeof parsed === 'object' && parsed !== null && (parsed as { v?: unknown }).v === 1) logReq = parseLogsRequest(parsed as Record<string, unknown>);
      } catch {
        req = null;
      }
      if (logReq) {
        const op = logReq.op;
        // Metadata only: never the log text.
        handleLogs(logReq).then(
          (response) => { socket.end(`${JSON.stringify(response)}\n`); },
          (error: unknown) => { logger.warn({ msg: 'request failed', op, name: error instanceof Error ? error.name : 'unknown' }); socket.destroy(); },
        );
        return;
      }
      if (!req) { logger.warn({ msg: 'bad request' }); socket.destroy(); return; }
      handle(req).then(
        (response) => { socket.end(`${JSON.stringify(response)}\n`); },
        (error: unknown) => {
          logger.warn({ msg: 'request failed', op: req.op, name: error instanceof Error ? error.name : 'unknown' });
          socket.destroy();
        },
      );
    });
  });
  server.maxConnections = 8;
  return { server, idle: () => chain.then(() => undefined, () => undefined), logStats: () => ({ inFlight: logReads, overdue }) };
}

/** Binds the socket: the directory must belong to us and be closed to others; a stale socket of ours is replaced. */
export async function listenBroker(server: Server, socketPath: string, uid: number = process.getuid?.() ?? -1): Promise<void> {
  const dir = await lstat(dirname(socketPath));
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o007) !== 0) throw new Error('socket directory must be owned by the broker user and closed to others');
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket() || existing.uid !== uid) throw new Error('socket path is occupied by something else');
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  // Owner + group (nc-pm2-control = the Agent) only.
  await chmod(socketPath, 0o660);
}
