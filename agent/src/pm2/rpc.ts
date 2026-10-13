import { connect, type Socket } from 'node:net';

// Minimal read-only client for an ALREADY RUNNING PM2 daemon (ADR-016). It speaks PM2's RPC wire format
// (axon req/rep over the daemon's unix socket, frames encoded with amp + amp-message) and calls exactly one method,
// `getMonitorData`. It never uses the pm2 package: pm2's Client launches a daemon when none is running, while a
// plain connect() to a missing/stale unix socket simply fails — nothing is spawned, created or changed.
//
// Wire format (amp v1): 1 byte meta (version << 4 | argc), then per argument a 4-byte big-endian length and the bytes.
// amp-message arguments: "s:" + string, "j:" + JSON. Request: [j:{type:'call',method,args:[{}]}, s:<id>].
// Reply: [j:{args:[result]} | j:{error}, s:<id>].
//
// The reply contains full pm2_env objects (application env vars included); it is bounded in size, parsed in memory
// and handed to the sanitiser — never logged or written anywhere.

export type RpcFailure = 'daemon_not_running' | 'permission_denied' | 'timeout' | 'protocol_error';

export class RpcError extends Error {
  constructor(readonly reason: RpcFailure) {
    super(reason);
  }
}

const AMP_VERSION = 1;
/** Upper bound for the daemon's reply (full pm2_env of every process). */
export const MAX_REPLY_BYTES = 64 * 1024 * 1024;

function packArg(arg: string | object): Buffer {
  return Buffer.from(typeof arg === 'string' ? `s:${arg}` : `j:${JSON.stringify(arg)}`, 'utf8');
}

export function encodeFrame(args: (string | object)[]): Buffer {
  const parts = args.map(packArg);
  const header = Buffer.alloc(1);
  header[0] = (AMP_VERSION << 4) | parts.length;
  const chunks: Buffer[] = [header];
  for (const part of parts) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length, 0);
    chunks.push(len, part);
  }
  return Buffer.concat(chunks);
}

/** Returns the decoded frame and the bytes consumed, or how many bytes are needed before it can be decoded. */
export function decodeFrame(buf: Buffer, maxBytes: number = MAX_REPLY_BYTES): { args: unknown[]; consumed: number } | { need: number } {
  if (buf.length < 1) return { need: 1 };
  const meta = buf[0] ?? 0;
  if (meta >> 4 !== AMP_VERSION) throw new RpcError('protocol_error');
  const argc = meta & 0xf;
  let off = 1;
  const args: unknown[] = [];
  for (let i = 0; i < argc; i++) {
    if (buf.length < off + 4) return { need: off + 4 };
    const len = buf.readUInt32BE(off);
    if (len > maxBytes) throw new RpcError('protocol_error');
    off += 4;
    if (buf.length < off + len) return { need: off + len };
    args.push(unpackArg(buf.subarray(off, off + len)));
    off += len;
  }
  return { args, consumed: off };
}

function unpackArg(raw: Buffer): unknown {
  const prefix = raw.subarray(0, 2).toString('latin1');
  if (prefix === 's:') return raw.subarray(2).toString('utf8');
  if (prefix === 'j:') {
    try {
      return JSON.parse(raw.subarray(2).toString('utf8')) as unknown;
    } catch {
      throw new RpcError('protocol_error');
    }
  }
  return raw;
}

function failureFor(error: unknown): RpcFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK') return 'daemon_not_running';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  return 'protocol_error';
}

export interface RpcCallOptions {
  socketPath: string;
  timeoutMs: number;
  maxReplyBytes?: number;
}

/**
 * Calls `getMonitorData` once and resolves with the raw result (to be sanitised immediately by the caller).
 * Exactly one request per connection; the connection is always destroyed afterwards.
 */
export function getMonitorData({ socketPath, timeoutMs, maxReplyBytes = MAX_REPLY_BYTES }: RpcCallOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `nc-pm2-exporter:${String(process.pid)}:0`;
    let settled = false;
    const socket: Socket = connect({ path: socketPath });
    // Chunks are only concatenated when enough bytes for the next decoding step have arrived (no quadratic copying).
    const chunks: Buffer[] = [];
    let total = 0;
    let need = 1;
    const finish = (error: RpcError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => { finish(new RpcError('timeout')); }, timeoutMs);

    socket.on('error', (error) => { finish(new RpcError(failureFor(error))); });
    socket.on('close', () => { finish(new RpcError('protocol_error')); });
    socket.on('connect', () => {
      socket.write(encodeFrame([{ type: 'call', method: 'getMonitorData', args: [{}] }, id]));
    });
    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxReplyBytes + 64) { finish(new RpcError('protocol_error')); return; }
      chunks.push(chunk);
      if (total < need) return;
      const buffered = Buffer.concat(chunks, total);
      chunks.length = 0;
      chunks.push(buffered);
      let frame;
      try {
        frame = decodeFrame(buffered, maxReplyBytes);
      } catch (error) {
        finish(error instanceof RpcError ? error : new RpcError('protocol_error'));
        return;
      }
      if ('need' in frame) { need = frame.need; return; }
      const [reply, replyId] = frame.args;
      if (frame.args.length !== 2 || replyId !== id || typeof reply !== 'object' || reply === null) { finish(new RpcError('protocol_error')); return; }
      const body = reply as { args?: unknown; error?: unknown };
      if (body.error !== undefined || !Array.isArray(body.args)) { finish(new RpcError('protocol_error')); return; }
      finish(null, body.args[0]);
    });
  });
}
