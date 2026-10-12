import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { abortableSleep, runAgent } from '../src/agent.js';
import { AgentConfigError, loadAgentConfig, readSecureEnvFile } from '../src/config.js';
import { type HeartbeatOutcome, nextDelaySeconds, parseRetryAfter, sendHeartbeat } from '../src/heartbeat.js';
import { collectSnapshot, type OsSource } from '../src/snapshot.js';

const TOKEN = 'ncag_' + 'S'.repeat(43);
const dir = mkdtempSync(join(tmpdir(), 'nc-agent-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });

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
});

describe('snapshot', () => {
  const source = (overrides: Partial<Record<keyof OsSource, () => unknown>> = {}): OsSource => ({
    hostname: () => 'web-01.example', platform: () => 'linux', arch: () => 'x64', uptime: () => 1234.9, cpus: () => [{}, {}],
    loadavg: () => [0.123, 1.5, 2], totalmem: () => 8e9, freemem: () => 2e9, ...overrides,
  } as OsSource);

  it('contains exactly the contract fields, rounded and bounded', () => {
    const s = collectSnapshot(source());
    expect(Object.keys(s).sort()).toEqual(['agentVersion', 'arch', 'cpuCount', 'hostname', 'loadAverage', 'memory', 'platform', 'uptimeSeconds']);
    expect(s).toMatchObject({ hostname: 'web-01.example', uptimeSeconds: 1234, cpuCount: 2, loadAverage: [0.12, 1.5, 2], memory: { totalBytes: 8e9, freeBytes: 2e9 } });
  });

  it('sanitizes unexpected OS values instead of sending them', () => {
    const s = collectSnapshot(source({ hostname: () => 'bad host; rm -rf', platform: () => 'Weird OS', loadavg: () => [Number.NaN, -1, 1e9], freemem: () => 9e9, cpus: () => [] }));
    expect(s).toMatchObject({ hostname: 'invalid-hostname', platform: 'unknown', cpuCount: 1, loadAverage: [0, 0, 100_000], memory: { totalBytes: 8e9, freeBytes: 8e9 } });
  });

  it('real host snapshot passes the server-side shape', () => {
    const s = collectSnapshot();
    expect(s.hostname).toMatch(/^[A-Za-z0-9.-]+$/);
    expect(s.memory.freeBytes).toBeLessThanOrEqual(s.memory.totalBytes);
  });
});

describe('heartbeat request', () => {
  it('POSTs the snapshot with a bearer header to the fixed path; token never in the URL', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const outcome = await sendHeartbeat(config(), collectSnapshot(), new AbortController().signal, (url, init) => {
      seen = { url, init };
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', intervalSeconds: 45 }), { status: 200 }));
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
    expect(nextDelaySeconds({ kind: 'accepted', intervalSeconds: null }, state, cfg)).toBe(30);
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
        return new Response(JSON.stringify({ intervalSeconds: 5 }), { status: calls % 2 ? 200 : 503 });
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
