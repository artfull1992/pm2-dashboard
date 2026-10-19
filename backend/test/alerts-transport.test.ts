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
const send = (fetchImpl: typeof fetch, timeoutMs = 3000, signal = new AbortController().signal) => sendToSlack(WEBHOOK, 'synthetic', { timeoutMs, signal, fetchImpl });
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

/**
 * A local HTTP peer that answers once the whole request body arrived: `head` (status line + headers), then `body`,
 * then `end` = close the connection | keep it open (hang). Returns the port and a promise for "response written".
 */
async function peer(head: string, body: string, end: 'close' | 'hang' | 'finish') {
  let written!: () => void;
  const responded = new Promise<void>((r) => { written = r; });
  const port = await listen((sock) => {
    let received = '';
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      received += d.toString();
      if (!received.includes('"synthetic"}')) return;
      sock.write(`${head}\r\n\r\n${body}`, () => {
        written();
        if (end === 'close') sock.destroy();
        if (end === 'finish') sock.end();
      });
    });
  });
  return { url: `http://127.0.0.1:${String(port)}/services/x`, responded };
}
const status = (code: string, extra: string[] = []) => [`HTTP/1.1 ${code}`, ...extra].join('\r\n');

// Review 2026-10-19 (P2): a failure while READING the response (after the headers) is not a definite answer.
describe('Slack transport: the response body is interrupted after the headers', () => {
  it('200 with Content-Length 2, only "o", then the connection drops → unknown (Slack may have accepted it)', async () => {
    const p = await peer(status('200 OK', ['Content-Length: 2', 'Connection: close']), 'o', 'close');
    expect(await send(via(p.url))).toEqual({ kind: 'unknown', code: 'connection_lost' });
  });

  it('timeout while reading the body → unknown/timeout', async () => {
    const p = await peer(status('200 OK', ['Content-Length: 2']), 'o', 'hang');
    expect(await send(via(p.url), 300)).toEqual({ kind: 'unknown', code: 'timeout' });
  });

  it('external abort (shutdown) while reading the body → unknown/aborted', async () => {
    const p = await peer(status('200 OK', ['Content-Length: 2']), 'o', 'hang');
    const ac = new AbortController();
    void p.responded.then(() => setTimeout(() => { ac.abort(); }, 50));
    expect(await send(via(p.url), 3000, ac.signal)).toEqual({ kind: 'unknown', code: 'aborted' });
  });

  it('429 / 5xx keep their meaning even if the body is cut: retry', async () => {
    const r = await peer(status('429 Too Many Requests', ['Retry-After: 30', 'Content-Length: 20']), 'rate', 'close');
    expect(await send(via(r.url))).toEqual({ kind: 'retry', code: 'rate_limited', retryAfterSeconds: 30 });
    const s = await peer(status('503 Service Unavailable', ['Content-Length: 20']), 'x', 'close');
    expect(await send(via(s.url))).toEqual({ kind: 'retry', code: 'http_503', retryAfterSeconds: null });
  });

  it('a 4xx rejection stays permanent even if its body is cut (the status already says "not accepted")', async () => {
    const p = await peer(status('404 Not Found', ['Content-Length: 17']), 'chan', 'close');
    expect(await send(via(p.url))).toEqual({ kind: 'permanent', code: 'http_404' });
  });
});

describe('Slack transport: complete responses (unchanged classification)', () => {
  it.each([
    ['200 "ok"', status('200 OK', ['Content-Length: 2']), 'ok', { kind: 'sent' }],
    ['200 with an unexpected body', status('200 OK', ['Content-Length: 4']), 'nope', { kind: 'permanent', code: 'unexpected_response' }],
    ['404 channel_not_found', status('404 Not Found', ['Content-Length: 17']), 'channel_not_found', { kind: 'permanent', code: 'channel_not_found' }],
    ['oversized 200 body (bounded read)', status('200 OK', ['Content-Length: 5000']), 'x'.repeat(5000), { kind: 'permanent', code: 'unexpected_response' }],
    ['429 with Retry-After', status('429 Too Many Requests', ['Retry-After: 120', 'Content-Length: 12']), 'rate_limited', { kind: 'retry', code: 'rate_limited', retryAfterSeconds: 120 }],
    ['500', status('500 Internal Server Error', ['Content-Length: 5']), 'error', { kind: 'retry', code: 'http_500', retryAfterSeconds: null }],
  ])('%s', async (_n, head, body, outcome) => {
    const p = await peer(head, body, 'finish');
    expect(await send(via(p.url))).toEqual(outcome);
  });
});

// Review 2026-10-19 (second, P2): the 1 KiB response bound. An oversized body is never a confirmation, whatever its
// prefix and however it is split into chunks; a cut body stays "unknown". Synthetic streams only.
describe('Slack transport: response size bound', () => {
  const enc = new TextEncoder();
  /** 200 response whose body arrives in the given chunks; `fail` = the stream errors after them (connection lost). */
  const streamed = (chunks: string[], init: { status?: number; headers?: Record<string, string>; fail?: boolean } = {}) => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); if (init.fail) c.error(new Error('socket closed')); else c.close(); },
      }), { status: init.status ?? 200, headers: init.headers ?? {} }));
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  };
  const oversized = { kind: 'permanent', code: 'unexpected_response' };

  it.each([
    ['"ok" as its own first chunk, then 1025 × "x"', ['ok', 'x'.repeat(1025)]],
    ['"ok" + 1023 × "x" (1025 bytes) in one chunk', [`ok${'x'.repeat(1023)}`]],
    ['the same 1025 bytes split into single bytes', Array.from(`ok${'x'.repeat(1023)}`)],
    ['"ok", then exactly one byte too many in a later chunk', ['ok', 'x'.repeat(1022), 'x']],
  ])('%s → never "sent": unexpected_response', async (_n, chunks) => {
    const s = streamed(chunks);
    expect(await send(s.fetchImpl)).toEqual(oversized);
  });

  it('exactly at the bound (1024 bytes) is a complete body: "ok" + padding is not "ok"; plain "ok" in any split is sent', async () => {
    expect(await send(streamed([`ok${' '.repeat(1022)}`]).fetchImpl)).toEqual({ kind: 'sent' }); // trimmed "ok", 1024 bytes: complete
    expect(await send(streamed([`ok${'x'.repeat(1022)}`]).fetchImpl)).toEqual(oversized);
    expect(await send(streamed(['o', 'k']).fetchImpl)).toEqual({ kind: 'sent' });
    expect(await send(streamed(['ok']).fetchImpl)).toEqual({ kind: 'sent' });
  });

  it('cut bodies stay unknown (not oversized, not failed): "o" then lost; "ok" then lost', async () => {
    expect(await send(streamed(['o'], { fail: true }).fetchImpl)).toEqual({ kind: 'unknown', code: 'connection_lost' });
    expect(await send(streamed(['ok'], { fail: true }).fetchImpl)).toEqual({ kind: 'unknown', code: 'connection_lost' });
  });

  it('429 / 5xx / 4xx keep their status meaning with an oversized body', async () => {
    expect(await send(streamed(['x'.repeat(2000)], { status: 429, headers: { 'retry-after': '30' } }).fetchImpl)).toEqual({ kind: 'retry', code: 'rate_limited', retryAfterSeconds: 30 });
    expect(await send(streamed(['x'.repeat(2000)], { status: 502 }).fetchImpl)).toEqual({ kind: 'retry', code: 'http_502', retryAfterSeconds: null });
    // A known Slack code followed by more than the bound is not trusted as that code: the status decides.
    expect(await send(streamed(['channel_not_found', 'x'.repeat(2000)], { status: 404 }).fetchImpl)).toEqual({ kind: 'permanent', code: 'http_404' });
  });
});
