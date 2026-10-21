import { connect } from 'node:net';
import { type BrokerRequest, type BrokerResponse, MAX_FRAME_BYTES, MAX_RESPONSE_BYTES_V2, parseBrokerResponse } from './protocol.js';

// Agent-side client of the local broker socket (ADR-017). `sent` tells whether the request may have reached the
// broker: only an unsent request is known not to have been executed.

export class BrokerError extends Error {
  constructor(readonly kind: 'connect' | 'transport' | 'timeout' | 'protocol', readonly sent: boolean) {
    super(kind);
  }
}

export function brokerRequest(socketPath: string, req: BrokerRequest, timeoutMs: number): Promise<BrokerResponse> {
  return brokerCall(socketPath, req, timeoutMs, (value) => parseBrokerResponse(value, req), req.v === 2 && req.op === 'list' ? MAX_RESPONSE_BYTES_V2 : MAX_FRAME_BYTES);
}

/** One request/response over the broker socket with a caller-supplied strict parser; the answer is bounded. */
export function brokerCall<T>(socketPath: string, req: object, timeoutMs: number, parse: (value: unknown) => T | null, maxResponseBytes: number = MAX_FRAME_BYTES): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let buffer = '';
    const socket = connect({ path: socketPath });
    const finish = (error: BrokerError | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (value !== undefined) resolve(value);
    };
    const timer = setTimeout(() => { finish(new BrokerError('timeout', sent)); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      sent = true;
      socket.write(`${JSON.stringify(req)}\n`);
    });
    socket.on('error', () => { finish(new BrokerError(sent ? 'transport' : 'connect', sent)); });
    socket.on('close', () => { finish(new BrokerError(sent ? 'transport' : 'connect', sent)); });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxResponseBytes) { finish(new BrokerError('protocol', sent)); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let parsed: T | null;
      try {
        parsed = parse(JSON.parse(buffer.slice(0, newline)));
      } catch {
        parsed = null;
      }
      if (parsed !== null) finish(null, parsed);
      else finish(new BrokerError('protocol', sent));
    });
  });
}
