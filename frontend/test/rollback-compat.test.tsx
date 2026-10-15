import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetch, json, renderApp, session } from './support';

// Rollback compatibility release (ADR-023): the UI renders data written by the ADR-023 release — minimal snapshots
// without host memory/uptime/CPU count, and incidents closed as "retired" — instead of failing to parse it.

const ID = '11111111-1111-4111-8111-111111111111';
const minimal = { agentVersion: '0.5.0', hostname: 'node.example', platform: 'linux', arch: 'x64', loadAverage: [0.5, 0.25, 0.1] };
afterEach(() => { vi.unstubAllGlobals(); });

describe('rollback compatibility: minimal snapshots and retired incidents', () => {
  it('server page: minimal snapshot renders load, memory unknown ("—"), no invented CPU count or uptime', async () => {
    installFetch((req) => (req.url === `/api/servers/${ID}`
      ? json(200, { id: ID, name: 'web-01', isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: new Date().toISOString(), hasActiveCredential: true, snapshot: minimal })
      : json(200, session('viewer'))));
    renderApp(`/servers/${ID}`);
    const vitals = await screen.findByLabelText('Показники останнього heartbeat');
    expect(within(vitals).getByText('0.50 / 0.25 / 0.10')).toBeTruthy();
    expect(within(vitals).getByText('обсяг невідомий')).toBeTruthy();
    expect(vitals.textContent).not.toMatch(/ядер|0 %/);
    expect(screen.queryByText(/ядер$/)).toBeNull();
  });

  it('dashboard: null host metrics are shown as unknown, not as zero', async () => {
    const now = new Date().toISOString();
    installFetch((req) => (req.url === '/api/dashboard' ? json(200, {
      generatedAt: now, windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
      servers: { total: 1, inactive: 0, active: 1, online: 1, offline: 0, neverConnected: 0 }, inventory: { current: 0, stale: 0, unavailable: 0, notReported: 1 },
      processes: { live: { total: 0, online: 0, problem: 0, transitional: 0 }, notLive: 0 },
      attentionServers: { items: [], total: 0, limit: 20 }, attentionProcesses: { items: [], total: 0, limit: 20 },
      serverList: { items: [{ id: ID, name: 'web-01', status: 'online', lastSeenAt: now, metrics: { hostname: 'node.example', uptimeSeconds: null, cpuCount: null, loadAverage: [0.5, 0.25, 0.1], memory: null }, inventory: { state: 'not_reported', collectedAt: null }, processes: null }], total: 1, limit: 50 },
      recentActions: null,
    }) : json(200, session('viewer'))));
    renderApp('/');
    const row = (await screen.findByRole('rowheader', { name: /web-01/ })).closest('tr') as HTMLElement;
    expect(row.textContent).toContain('0.50 / 0.25 / 0.10');
    expect(within(row).getByText("(обсяг пам'яті невідомий)")).toBeTruthy();
    expect(row.textContent).not.toMatch(/ядер|0 %/);
  });

  it('alerts history: a "retired" incident is listed and not called a recovery', async () => {
    installFetch((req) => {
      if (req.url === '/api/alerts/status') return json(200, { engine: { enabled: true, running: true, lastEvaluationAt: null, lastEvaluationOk: null }, delivery: { enabled: false }, activeCount: 0, admin: null });
      if (req.url.startsWith('/api/alerts?state=resolved')) return json(200, { items: [{
        id: '00000000-0000-4000-8000-000000000001', rule: 'server_memory', severity: 'warning', status: 'resolved', resolution: 'retired', serverId: ID, serverName: 'web-01',
        serverStatus: 'online', processName: null, pmId: null, detail: { value: 95, threshold: 90 }, openedAt: '2026-10-14T10:00:00.000Z', lastObservedAt: '2026-10-14T10:05:00.000Z',
        resolvedAt: '2026-10-15T13:01:43.000Z', notification: null,
      }], nextBefore: null });
      if (req.url.startsWith('/api/alerts?')) return json(200, { items: [], nextBefore: null });
      return json(200, session('viewer'));
    });
    renderApp('/alerts');
    const history = (await screen.findByRole('heading', { name: 'Закриті інциденти' })).closest('section') as HTMLElement;
    expect(await within(history).findByText('Правило виведено з експлуатації (не відновлення)')).toBeTruthy();
    expect(within(history).queryByText('Відновлено')).toBeNull();
  });
});
