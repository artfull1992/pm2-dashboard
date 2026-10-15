import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { abortableSleep, runAgent } from '../src/agent.js';
import { AgentConfigError, loadAgentConfig, readSecureEnvFile } from '../src/config.js';
import { type FetchLike, type HeartbeatOutcome, MAX_RESPONSE_BYTES, nextDelaySeconds, parseAcceptedBody, parseRetryAfter, sendHeartbeat } from '../src/heartbeat.js';
import { collectSnapshot, type OsSource } from '../src/snapshot.js';

const TOKEN = 'ncag_' + 'S'.repeat(43);
const dir = mkdtempSync(join(tmpdir(), 'nc-agent-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))); });

const ACCEPTED = { status: 'accepted', receivedAt: '2026-10-12T10:00:00.000Z', intervalSeconds: 30 };
const acceptedBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...ACCEPTED, ...overrides });

const env = (overrides: Record<string, string> = {}) => ({ NC_AGENT_API_URL: 'https://nodecontrol.example.test', NC_AGENT_TOKEN: TOKEN, ...overrides });
const config = (overrides: Record<string, string> = {}) => loadAgentConfig(env(overrides));
const issuesOf = (e: Record<string, string>) => { try { loadAgentConfig(e); } catch (error) { return (error as AgentConfigError).issues; } return []; };

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('configuration', () => {
  it('defaults and https origin', () => {
    expect(config()).toMatchObject({ intervalSeconds: 30, timeoutSeconds: 10, maxBackoffSeconds: 900, token: TOKEN });
  });

  it.each([
    ['http to a remote host', { NC_AGENT_API_URL: 'http://nodecontrol.example.test' }, 'must use https'],
    ['http loopback without the explicit flag', { NC_AGENT_API_URL: 'http://127.0.0.1:3100' }, 'must use https'],
    ['insecure flag on a non-loopback host', { NC_AGENT_API_URL: 'http://10.0.0.5', NC_AGENT_ALLOW_INSECURE_LOOPBACK: 'true' }, 'must use https'],
    ['credentials in URL', { NC_AGENT_API_URL: 'https://u:p@nodecontrol.example.test' }, 'bare origin'],
    ['path/query in URL', { NC_AGENT_API_URL: 'https://nodecontrol.example.test/api?x=1' }, 'bare origin'],
    ['not a URL', { NC_AGENT_API_URL: 'nodecontrol' }, 'absolute URL'],
    ['missing token', { NC_AGENT_TOKEN: '' }, 'NC_AGENT_TOKEN is not set'],
    ['bad token', { NC_AGENT_TOKEN: 'ncag_short' }, 'invalid format'],
    ['interval too small', { NC_AGENT_INTERVAL_SECONDS: '1' }, 'NC_AGENT_INTERVAL_SECONDS'],
  ])('rejects %s without echoing values', (_name, overrides, rule) => {
    const issues = issuesOf(env(overrides));
    expect(issues.join(' ')).toContain(rule);
    expect(issues.join(' ')).not.toContain('ncag_short');
    expect(issues.join(' ')).not.toContain(TOKEN);
  });

  it('http is allowed only for loopback with the explicit dev/test flag', () => {
    expect(config({ NC_AGENT_API_URL: 'http://127.0.0.1:41730', NC_AGENT_ALLOW_INSECURE_LOOPBACK: 'true' }).apiUrl.origin).toBe('http://127.0.0.1:41730');
  });

  it('env file must be 600 and owned by the agent user', () => {
    const file = join(dir, 'agent.env');
    writeFileSync(file, `NC_AGENT_TOKEN=${TOKEN}\n`);
    chmodSync(file, 0o644);
    expect(() => readSecureEnvFile(file)).toThrow(/chmod 600/);
    chmodSync(file, 0o600);
    expect(readSecureEnvFile(file)).toEqual({ NC_AGENT_TOKEN: TOKEN });
    expect(() => readSecureEnvFile(file, (process.getuid?.() ?? 0) + 1)).toThrow(/owned by the agent user/);
  });

  it('reports a missing env file as a configuration error (exit 2, not a restart loop)', () => {
    expect(() => readSecureEnvFile(join(dir, 'missing.env'))).toThrow(AgentConfigError);
    expect(() => readSecureEnvFile(join(dir, 'missing.env'))).toThrow(/missing or not accessible/);
  });
});

describe('snapshot', () => {
  const source = (overrides: Partial<Record<keyof OsSource, () => unknown>> = {}): OsSource => ({
    hostname: () => 'web-01.example', platform: () => 'linux', arch: () => 'x64', loadavg: () => [0.123, 1.5, 2], ...overrides,
  } as OsSource);

  it('contains exactly the contract fields (identification + load average), rounded and bounded', () => {
    const s = collectSnapshot(source());
    expect(Object.keys(s).sort()).toEqual(['agentVersion', 'arch', 'hostname', 'loadAverage', 'platform']);
    expect(s).toEqual({ agentVersion: '0.5.0', hostname: 'web-01.example', platform: 'linux', arch: 'x64', loadAverage: [0.12, 1.5, 2] });
  });

  it('does not even read host metrics that belong to Zabbix (memory, OS uptime, CPU count) — ADR-023', () => {
    const forbidden = () => { throw new Error('host metric must not be read'); };
    const s = collectSnapshot({ ...source(), uptime: forbidden, cpus: forbidden, totalmem: forbidden, freemem: forbidden } as OsSource);
    expect(s).not.toHaveProperty('memory');
    expect(s).not.toHaveProperty('uptimeSeconds');
    expect(s).not.toHaveProperty('cpuCount');
  });

  it('sanitizes unexpected OS values instead of sending them', () => {
    const s = collectSnapshot(source({ hostname: () => 'bad host; rm -rf', platform: () => 'Weird OS', loadavg: () => [Number.NaN, -1, 1e9] }));
    expect(s).toMatchObject({ hostname: 'invalid-hostname', platform: 'unknown', loadAverage: [0, 0, 100_000] });
  });

  it('real host snapshot passes the server-side shape', () => {
    const s = collectSnapshot();
    expect(s.hostname).toMatch(/^[A-Za-z0-9.-]+$/);
    expect(s.loadAverage).toHaveLength(3);
    for (const v of s.loadAverage) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('heartbeat request', () => {
  it('POSTs the snapshot with a bearer header to the fixed path; token never in the URL', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const outcome = await sendHeartbeat(config(), collectSnapshot(), new AbortController().signal, (url, init) => {
      seen = { url, init };
      return Promise.resolve(new Response(acceptedBody({ intervalSeconds: 45 }), { status: 200 }));
    });
    expect(outcome).toEqual({ kind: 'accepted', intervalSeconds: 45 });
    expect(seen?.url).toBe('https://nodecontrol.example.test/api/agent/heartbeat');
    expect(seen?.url).not.toContain(TOKEN);
    expect(seen?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(seen?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [401, {}, { kind: 'unauthorized' }], [403, {}, { kind: 'unauthorized' }],
    [429, { 'retry-after': '120' }, { kind: 'rate_limited', retryAfterSeconds: 120 }],
    [400, {}, { kind: 'rejected' }], [413, {}, { kind: 'rejected' }],
    [503, {}, { kind: 'unavailable' }], [500, {}, { kind: 'unavailable' }],
  ])('HTTP %i → outcome', async (status, headers, expected) => {
    const outcome = await sendHeartbeat(config(), collectSnapshot(), new AbortController().signal, () => Promise.resolve(new Response('{}', { status, headers })));
    expect(outcome).toEqual(expected);
  });

  it('network error, timeout and abort are distinguished', async () => {
    const snap = collectSnapshot();
    expect(await sendHeartbeat(config(), snap, new AbortController().signal, () => Promise.reject(new TypeError('fetch failed')))).toEqual({ kind: 'network' });
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); });
    expect(await sendHeartbeat(config({ NC_AGENT_TIMEOUT_SECONDS: '1' }), snap, new AbortController().signal, hang)).toEqual({ kind: 'timeout' });
    const controller = new AbortController();
    const pending = sendHeartbeat(config(), snap, controller.signal, hang);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('a redirect is an error and the credential is not sent to the redirect target', async () => {
    const targetHits: (string | undefined)[] = [];
    const targetPort = await listen(createHttpServer((req, res) => { targetHits.push(req.headers.authorization); res.end('{}'); }));
    const port = await listen(createHttpServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${String(targetPort)}/api/agent/heartbeat` }); res.end(); }));
    const cfg = config({ NC_AGENT_API_URL: `http://127.0.0.1:${String(port)}`, NC_AGENT_ALLOW_INSECURE_LOOPBACK: 'true' });
    expect(await sendHeartbeat(cfg, collectSnapshot(), new AbortController().signal)).toEqual({ kind: 'network' });
    expect(targetHits).toEqual([]);
  });

  it('TLS certificates are verified (self-signed server is refused, no request body reaches it)', async () => {
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    expect(gen.status).toBe(0);
    let hits = 0;
    const server = createHttpsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (_req, res) => { hits += 1; res.end('{}'); });
    const port = await listen(server);
    const cfg = config({ NC_AGENT_API_URL: `https://localhost:${String(port)}` });
    expect(await sendHeartbeat(cfg, collectSnapshot(), new AbortController().signal)).toEqual({ kind: 'network' });
    expect(hits).toBe(0);
  });

  it('parseRetryAfter accepts bounded seconds only', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('scheduling', () => {
  const cfg = config();

  it('accepted → interval (server suggestion bounded to 5..300) and resets failures', () => {
    const state = { failures: 4 };
    expect(nextDelaySeconds({ kind: 'accepted', intervalSeconds: 30 }, state, cfg)).toBe(30);
    expect(state.failures).toBe(0);
    expect(nextDelaySeconds({ kind: 'accepted', intervalSeconds: 1 }, state, cfg)).toBe(5);
    expect(nextDelaySeconds({ kind: 'accepted', intervalSeconds: 9999 }, state, cfg)).toBe(300);
  });

  it('unauthorized → the long maximum, never a fast retry', () => {
    expect(nextDelaySeconds({ kind: 'unauthorized' }, { failures: 0 }, cfg)).toBe(900);
  });

  it('429 honours Retry-After within [interval, max]', () => {
    expect(nextDelaySeconds({ kind: 'rate_limited', retryAfterSeconds: 120 }, { failures: 0 }, cfg)).toBe(120);
    expect(nextDelaySeconds({ kind: 'rate_limited', retryAfterSeconds: 1 }, { failures: 0 }, cfg)).toBe(30);
    expect(nextDelaySeconds({ kind: 'rate_limited', retryAfterSeconds: 999_999 }, { failures: 0 }, cfg)).toBe(900);
  });

  it('network/5xx → exponential backoff with full jitter, capped', () => {
    const outcome: HeartbeatOutcome = { kind: 'unavailable' };
    const state = { failures: 0 };
    const low = [1, 2, 3].map(() => nextDelaySeconds(outcome, { failures: state.failures }, cfg, () => 0));
    const high = [1, 2, 3].map(() => nextDelaySeconds(outcome, { failures: state.failures }, cfg, () => 0.999));
    expect(low).toEqual([30, 30, 30]); // failures→1: ceiling 60, jitter 0.5 → 30
    expect(high.every((d) => d <= 60)).toBe(true);
    const capped = { failures: 20 };
    for (let i = 0; i < 20; i++) expect(nextDelaySeconds(outcome, capped, cfg, Math.random)).toBeLessThanOrEqual(900);
  });
});

describe('agent loop', () => {
  it('never overlaps requests, stops promptly on abort, logs metadata only', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const controller = new AbortController();
    const logged: string[] = [];
    const attempts = runAgent(config(), controller.signal, {
      fetchImpl: async () => {
        inFlight += 1; calls += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (calls >= 5) controller.abort();
        return new Response(acceptedBody({ intervalSeconds: 5 }), { status: calls % 2 ? 200 : 503 });
      },
      sleep: (_ms, signal) => abortableSleep(1, signal),
      logger: { info: (e) => logged.push(JSON.stringify(e)), warn: (e) => logged.push(JSON.stringify(e)) },
    });
    expect(await attempts).toBe(5);
    expect(maxInFlight).toBe(1);
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(logged.some((l) => l.includes('"outcome":"unavailable"'))).toBe(true);
  });

  it('abort during a long sleep resolves immediately', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('abort during an in-flight request ends the loop without another attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    const attempts = runAgent(config(), controller.signal, {
      fetchImpl: (_u, init) => { calls += 1; setTimeout(() => { controller.abort(); }, 5); return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); }); },
      logger: { info: () => undefined, warn: () => undefined },
    });
    expect(await attempts).toBe(1);
    expect(calls).toBe(1);
  });
});

// Regression for review finding P2 (Task 007.1): "accepted" only after a fully read, contract-valid 200 body.
describe('heartbeat response body', () => {
  const enc = new TextEncoder();
  const respond = (response: Response): FetchLike => () => Promise.resolve(response);
  const send = (fetchImpl: FetchLike, cfg = config(), signal = new AbortController().signal) => sendHeartbeat(cfg, collectSnapshot(), signal, fetchImpl);
  /** A real asynchronous stream: the first chunk arrives after the headers, then it never ends (until cancelled). */
  function stalledBody(onCancel: () => void = () => undefined) {
    let step = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 5));
        if (step++ === 0) controller.enqueue(enc.encode('{"status":"acc'));
        else await new Promise(() => undefined);
      },
      cancel() { onCancel(); },
    });
  }

  it('a valid 200 reply is accepted with the server interval', async () => {
    expect(await send(respond(new Response(acceptedBody(), { status: 200 })))).toEqual({ kind: 'accepted', intervalSeconds: 30 });
  });

  it('a stream error after the 200 headers is a failure, not accepted (Codex reproduction)', async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { await new Promise((r) => setTimeout(r, 5)); controller.error(new Error('stream broken')); },
    });
    expect(await send(respond(new Response(body, { status: 200 })))).toEqual({ kind: 'network' });
  });

  it('a stalled body is cut by the request timeout (the deadline covers the body read)', async () => {
    let cancelled = false;
    const started = Date.now();
    const outcome = await send(respond(new Response(stalledBody(() => { cancelled = true; }), { status: 200 })), config({ NC_AGENT_TIMEOUT_SECONDS: '1' }));
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(cancelled).toBe(true);
  });

  it('caller cancellation while the body is being read → aborted', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const pending = send(respond(new Response(stalledBody(() => { cancelled = true; }), { status: 200 })), config(), controller.signal);
    setTimeout(() => { controller.abort(); }, 30);
    expect(await pending).toEqual({ kind: 'aborted' });
    expect(cancelled).toBe(true);
  });

  it('real HTTP: connection dropped mid-body → network; body stalled → timeout', async () => {
    const dropPort = await listen(createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
      res.write('{"status":"accepted"');
      setTimeout(() => { res.socket?.destroy(); }, 20);
    }));
    const loopback = (port: number, extra: Record<string, string> = {}) => config({ NC_AGENT_API_URL: `http://127.0.0.1:${String(port)}`, NC_AGENT_ALLOW_INSECURE_LOOPBACK: 'true', ...extra });
    expect(await sendHeartbeat(loopback(dropPort), collectSnapshot(), new AbortController().signal)).toEqual({ kind: 'network' });
    const stallPort = await listen(createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":'); }));
    expect(await sendHeartbeat(loopback(stallPort, { NC_AGENT_TIMEOUT_SECONDS: '1' }), collectSnapshot(), new AbortController().signal)).toEqual({ kind: 'timeout' });
  });

  it.each([
    ['empty', ''], ['malformed JSON', '{"status":"accepted",'], ['JSON null', 'null'], ['array', '[]'], ['string', '"accepted"'],
    ['wrong status', acceptedBody({ status: 'ok' })], ['missing receivedAt', JSON.stringify({ status: 'accepted', intervalSeconds: 30 })],
    ['missing intervalSeconds', JSON.stringify({ status: 'accepted', receivedAt: ACCEPTED.receivedAt })],
  ])('%s body → invalid_response', async (_name, body) => {
    expect(await send(respond(new Response(body, { status: 200 })))).toEqual({ kind: 'invalid_response' });
  });

  it('a 200 without a body → invalid_response', async () => {
    expect(await send(respond(new Response(null, { status: 200 })))).toEqual({ kind: 'invalid_response' });
  });

  it('invalid UTF-8 → invalid_response', async () => {
    expect(await send(respond(new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 })))).toEqual({ kind: 'invalid_response' });
  });

  it.each([
    ['not a date', 'yesterday'], ['impossible date', '2026-02-31T00:00:00.000Z'], ['no timezone', '2026-10-12T10:00:00.000'],
    ['offset instead of Z', '2026-10-12T10:00:00.000+02:00'], ['number', 1_760_000_000_000],
  ])('receivedAt: %s → rejected', (_name, receivedAt) => {
    expect(parseAcceptedBody(acceptedBody({ receivedAt }))).toBeNull();
  });

  it.each([[4], [301], [30.5], [-30], ['30'], [null], [Number.MAX_SAFE_INTEGER + 2]])('intervalSeconds %s → rejected', (intervalSeconds) => {
    expect(parseAcceptedBody(acceptedBody({ intervalSeconds }))).toBeNull();
  });

  it('interval bounds 5 and 300 are accepted (same range as NC_AGENT_INTERVAL_SECONDS; backend sends 30)', () => {
    expect(parseAcceptedBody(acceptedBody({ intervalSeconds: 5 }))).toEqual({ intervalSeconds: 5 });
    expect(parseAcceptedBody(acceptedBody({ intervalSeconds: 300 }))).toEqual({ intervalSeconds: 300 });
  });

  it('oversized body without Content-Length: reading stops at the limit and the stream is cancelled', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { await new Promise((r) => setTimeout(r, 1)); pulled += 1; controller.enqueue(new Uint8Array(1024).fill(0x20)); },
      cancel() { cancelled = true; },
    });
    expect(await send(respond(new Response(body, { status: 200 })))).toEqual({ kind: 'invalid_response' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES / 1024 + 2);
  });

  it('oversized Content-Length is refused before reading; a lying small Content-Length does not lift the limit', async () => {
    let pulled = false;
    const lazy = new ReadableStream<Uint8Array>({ pull() { pulled = true; } }, { highWaterMark: 0 });
    expect(await send(respond(new Response(lazy, { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })))).toEqual({ kind: 'invalid_response' });
    expect(pulled).toBe(false);
    const big = `${acceptedBody()}${' '.repeat(MAX_RESPONSE_BYTES)}`;
    expect(await send(respond(new Response(big, { status: 200, headers: { 'content-length': '10' } })))).toEqual({ kind: 'invalid_response' });
  });

  it.each([
    [401, { kind: 'unauthorized' }], [403, { kind: 'unauthorized' }],
    [429, { kind: 'rate_limited', retryAfterSeconds: 60 }], [503, { kind: 'unavailable' }],
  ])('HTTP %i with a non-JSON or broken body keeps its classification', async (status, expected) => {
    const headers = { 'retry-after': '60' };
    expect(await send(respond(new Response('<html>proxy error</html>', { status, headers })))).toEqual(expected);
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('broken')); } });
    expect(await send(respond(new Response(broken, { status, headers })))).toEqual(expected);
  });

  it('invalid_response is a failure for scheduling: backoff grows and is not reset', () => {
    const cfg = config();
    const state = { failures: 2 };
    const delay = nextDelaySeconds({ kind: 'invalid_response' }, state, cfg, () => 0);
    expect(state.failures).toBe(3);
    expect(delay).toBe(120); // ceiling 30·2³ = 240, jitter 0.5
  });

  it('loop: invalid replies keep counting failures and logs carry neither the token nor the response body', async () => {
    const SECRET = 'SYNTHETIC_RESPONSE_SECRET_7f3a';
    const replies = [
      () => new Response(acceptedBody(), { status: 200 }),
      () => new Response(JSON.stringify({ status: 'accepted', receivedAt: SECRET, intervalSeconds: 30 }), { status: 200 }),
      () => new Response(`{"broken":"${SECRET}`, { status: 200 }),
      () => new Response(SECRET, { status: 503 }),
    ];
    const controller = new AbortController();
    const logged: Record<string, unknown>[] = [];
    let calls = 0;
    await runAgent(config(), controller.signal, {
      fetchImpl: () => {
        const reply = replies[calls++];
        if (calls >= replies.length) controller.abort();
        return Promise.resolve(reply ? reply() : new Response(null, { status: 503 }));
      },
      sleep: (_ms, signal) => abortableSleep(1, signal),
      random: () => 0,
      logger: { info: (e) => logged.push(e), warn: (e) => logged.push(e) },
    });
    expect(logged.map((e) => [e.outcome, e.consecutiveFailures])).toEqual([
      ['accepted', 0], ['invalid_response', 1], ['invalid_response', 2], ['unavailable', 3],
    ]);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
  });
});
