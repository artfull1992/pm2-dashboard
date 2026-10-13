import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { RpcError, callDaemon } from '../pm2/rpc.js';
import { readAllowlist } from './allowlist.js';
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
  if (issues.length > 0) throw new BrokerConfigError(issues);
  return {
    pm2Home, socketPath, allowlistPath, journalDir, pm2TimeoutMs: Number(rawTimeout) * 1000,
    allowSelfOwnedAllowlist: env.NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST === 'true',
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
  };
}

export interface BrokerLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
}

export const MAX_PENDING_EXECUTIONS = 4;

/** Socket server. One request per connection; executions are serialised (one PM2 action at a time). */
export function createBroker(deps: ExecutorDeps, logger: BrokerLogger): { server: Server; idle: () => Promise<void> } {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;

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
      try {
        req = parseBrokerRequest(JSON.parse(buffer.slice(0, newline)));
      } catch {
        req = null;
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
  return { server, idle: () => chain.then(() => undefined, () => undefined) };
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
