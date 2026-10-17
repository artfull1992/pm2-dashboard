import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sendToSlack } from '../src/alerts/slack.js';

// Slack transport outcome on network errors (ADR-021): "unknown" = the request may have reached Slack; "retry/network"
// only when it certainly did not (no connection, no DNS, TLS handshake refused). Real Node fetch against a local TCP
// server (synthetic; never Slack): the request is redirected by fetchImpl, the webhook URL is synthetic.

const WEBHOOK = `https://hooks.slack.com/services/T0SYNTH06/B0SYNTH06/${'k'.repeat(24)}`;
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => { s.close(r); }); });

function listen(onConnection: (sock: import('node:net').Socket) => void): Promise<number> {
  const server = createServer(onConnection);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}
const via = (url: string): typeof fetch => (_u: unknown, init?: RequestInit) => fetch(url, init);
const send = (fetchImpl: typeof fetch) => sendToSlack(WEBHOOK, 'synthetic', { timeoutMs: 3000, signal: new AbortController().signal, fetchImpl });
const failing = (cause: unknown) => (() => Promise.reject(new TypeError('fetch failed', { cause }))) as unknown as typeof fetch;

describe('Slack transport: network errors', () => {
  it('the connection drops after the request was sent → unknown (it may have been delivered)', async () => {
    let received = '';
    const port = await listen((sock) => { sock.on('data', (d) => { received += d.toString(); sock.destroy(); }); });
    expect(await send(via(`http://127.0.0.1:${String(port)}/services/x`))).toEqual({ kind: 'unknown', code: 'connection_lost' });
    expect(received).toContain('synthetic'); // the body really reached the peer before the drop
  });

  it('nothing listens (connection refused) → retry/network (certainly not delivered)', async () => {
    const port = await listen(() => undefined);
    await new Promise((r) => { servers.pop()?.close(r); });
    expect(await send(via(`http://127.0.0.1:${String(port)}/x`))).toEqual({ kind: 'retry', code: 'network', retryAfterSeconds: null });
  });

  it.each([
    ['ENOTFOUND'], ['EAI_AGAIN'], ['ECONNREFUSED'], ['ENETUNREACH'], ['EHOSTUNREACH'], ['UND_ERR_CONNECT_TIMEOUT'],
    ['CERT_HAS_EXPIRED'], ['ERR_TLS_CERT_ALTNAME_INVALID'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE'], ['SELF_SIGNED_CERT_IN_CHAIN'],
  ])('%s before any request → retry/network', async (code) => {
    expect(await send(failing(Object.assign(new Error('x'), { code })))).toEqual({ kind: 'retry', code: 'network', retryAfterSeconds: null });
  });

  it('every address refused (AggregateError) → retry/network; mixed or unknown causes → unknown', async () => {
    const refused = (n: number) => Object.assign(new Error('x'), { code: 'ECONNREFUSED', n });
    expect(await send(failing(new AggregateError([refused(1), refused(2)])))).toMatchObject({ kind: 'retry', code: 'network' });
    expect(await send(failing(new AggregateError([refused(1), Object.assign(new Error('y'), { code: 'ECONNRESET' })])))).toEqual({ kind: 'unknown', code: 'connection_lost' });
    for (const cause of [Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }), Object.assign(new Error('x'), { code: 'ECONNRESET' }), Object.assign(new Error('x'), { code: 'EPIPE' }), new Error('no code'), undefined]) {
      expect(await send(failing(cause))).toEqual({ kind: 'unknown', code: 'connection_lost' });
    }
  });
});
