import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditItem } from '../src/api/types';
import { useAuth } from '../src/auth/AuthContext';
import { actionText, detailRows, eventLabel, targetOf } from '../src/components/auditEvents';
import { checkDraft } from '../src/components/ProjectInfo';
import { descriptionProblem, githubProblem, projectUrlProblem } from '../src/components/projectInfoRules';
import casesJson from '../../backend/test/fixtures/project-info-cases.json?raw';
import { CSRF, deferred, installFetch, json, type RecordedRequest, renderApp, renderAppWith, session, setViewportWidth } from './support';

type User = ReturnType<typeof userEvent.setup>;

// «Про проєкт» in the overview of an application (ADR-036): view / empty / partial / loading / error, inline editing by
// an admin only, one PUT per save, 409 and unknown results with an explicit GET re-read (editing locked meanwhile), the
// page guard (service / tab / close / route / beforeunload), late answers of another service or session, safe links and
// plain text. Synthetic API only; the rules are checked against the same cases as the backend.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NAME = { [A]: 'alpha', [B]: 'beta' } as const;
const app = (serverId: string, over: Record<string, unknown> = {}) => ({
  key: `${serverId}:pm2:3`, serverId, serverName: NAME[serverId as keyof typeof NAME], serverStatus: 'online', source: 'pm2', pmId: 3, name: 'api',
  status: 'online', uptimeSeconds: 100, restarts: 0, cpuPercent: 1, memoryBytes: 1024, execMode: 'fork', firstSeenAt: '2026-10-13T10:00:00.000Z',
  inventoryState: 'current', capturedAt: null, collectedAt: '2026-10-13T12:00:01.000Z', ...over,
});
const control = (id: string) => ({
  serverId: id, enabled: true, serverStatus: 'online', broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: new Date().toISOString(), fresh: true },
  targets: [{ targetKey: `api-${NAME[id as keyof typeof NAME]}`, name: 'api', pmId: 3, actions: ['restart', 'stop', 'start'], matchStatus: 'ok' }], targetFreshSeconds: 60,
});
const serverPage = { items: [A, B].map((id) => ({ id, name: NAME[id as keyof typeof NAME], isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: new Date().toISOString(), hasActiveCredential: true })), nextAfterId: null, onlineWindowSeconds: 90 };
const UPDATED = '2026-11-01T10:00:00.000Z';
const info = (serverId: string, over: Record<string, unknown> = {}) => ({
  serverId, serviceName: 'api', revision: 0, githubUrl: null, projectUrl: null, description: null, updatedAt: null, ...over,
});
const filled = (serverId: string, over: Record<string, unknown> = {}) => info(serverId, {
  revision: 2, githubUrl: 'https://github.com/acme/api', projectUrl: 'https://api.example.com', description: 'Публічний API\nдругий рядок', updatedAt: UPDATED, ...over,
});

afterEach(() => { vi.unstubAllGlobals(); setViewportWidth(1440); });

const nav: { current: NavigateFunction | null; logout: (() => Promise<unknown>) | null } = { current: null, logout: null };
function Probe() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  useEffect(() => { nav.current = navigate; nav.logout = logout; }, [navigate, logout]);
  return null;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response> | undefined;
/** `project` answers GET/PUT …/project-info (default: empty state for both servers). */
function backend(role: 'admin' | 'operator' | 'viewer', project: Handler = (req) => (req.method === 'GET' ? json(200, info(req.url.includes(A) ? A : B)) : undefined), items = () => [app(A), app(B)]) {
  return installFetch((req) => {
    if (req.url.includes('/project-info')) {
      const r = project(req);
      if (r) return r;
    }
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url === '/api/auth/logout') return new Response(null, { status: 204 });
    if (req.url.startsWith('/api/servers?')) return json(200, serverPage);
    if (req.url.startsWith('/api/applications?')) return json(200, { items: items(), nextCursor: null, freshWindowSeconds: 180 });
    for (const id of [A, B]) {
      if (req.url === `/api/servers/${id}/control`) return json(200, control(id));
      if (req.url === `/api/servers/${id}/log-targets`) return json(200, { serverId: id, state: 'supported', reportedAt: new Date().toISOString(), targets: [] });
      if (req.url === `/api/servers/${id}/applications`) return json(200, { serverId: id, serverStatus: 'online', items: [app(id)], freshWindowSeconds: 180, inventory: { state: 'current', reason: null, source: 'pm2', capturedAt: null, collectedAt: '2026-10-13T12:00:01.000Z', reportedAt: null, processCount: 1 } });
      if (req.url.startsWith(`/api/servers/${id}/control-commands?`)) return json(200, { items: [] });
    }
    return json(404, {});
  });
}
const reads = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'GET' && c.url.includes('/project-info'));
const saves = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'PUT' && c.url.includes('/project-info'));
const bodyOf = (c: RecordedRequest | undefined) => JSON.parse(c?.body ?? '{}') as Record<string, unknown>;

const rowOf = (server: 'alpha' | 'beta') => screen.findByRole('button', { name: new RegExp(`^api на ${server}:`) });
const panelOf = (server: 'alpha' | 'beta') => screen.findByRole('region', { name: `Деталі: api на ${server}` });
async function open(user: User, server: 'alpha' | 'beta' = 'alpha') {
  await user.click(await rowOf(server));
  const panel = await panelOf(server);
  return { panel, block: await within(panel).findByRole('region', { name: 'Про проєкт' }) };
}
const renderAt = (path = '/applications') => renderAppWith(path, <Probe />);
async function edit(user: User, block: HTMLElement) {
  await user.click(await within(block).findByRole('button', { name: /^(Редагувати інформацію про проєкт|Додати інформацію)$/ }));
  return within(block).getByRole('form', { name: 'Редагування інформації про проєкт' });
}
const fields = (form: HTMLElement) => ({
  github: within(form).getByLabelText<HTMLInputElement>('GitHub'),
  url: within(form).getByLabelText<HTMLInputElement>('Адреса проєкту'),
  description: within(form).getByLabelText<HTMLTextAreaElement>('Короткий опис'),
});
const leaveDialog = () => screen.findByRole('dialog', { name: 'Скасувати зміни?' });
const armed = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

interface Cases { github: { valid: string[]; invalid: string[] }; projectUrl: { valid: string[]; invalid: string[] }; description: { valid: string[]; invalid: string[] } }
const CASES = JSON.parse(casesJson) as Cases;

describe('rules: the same cases as the API', () => {
  it('GitHub, project address and description accept and refuse exactly the shared cases', () => {
    for (const v of CASES.github.valid) expect(githubProblem(v), v).toBeNull();
    for (const v of CASES.github.invalid) expect(githubProblem(v), JSON.stringify(v)).not.toBeNull();
    for (const v of CASES.projectUrl.valid) expect(projectUrlProblem(v), v).toBeNull();
    for (const v of CASES.projectUrl.invalid) expect(projectUrlProblem(v), JSON.stringify(v)).not.toBeNull();
    for (const v of CASES.description.valid) expect(descriptionProblem(v), JSON.stringify(v)).toBeNull();
    for (const v of CASES.description.invalid) expect(descriptionProblem(v), JSON.stringify(v)).toBe('invalid_text');
  });
  it('checkDraft: trims, normalizes line breaks, empty → null; every invalid field gets its own message', () => {
    expect(checkDraft({ githubUrl: ' https://github.com/o/r ', projectUrl: '', description: ' a\r\nb ' })).toEqual({ ok: true, value: { githubUrl: 'https://github.com/o/r', projectUrl: null, description: 'a\nb' } });
    const bad = checkDraft({ githubUrl: 'https://gitlab.com/o/r', projectUrl: 'javascript:alert(1)', description: 'x'.repeat(2001) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['description', 'githubUrl', 'projectUrl']);
  });
});

describe('view', () => {
  it('first in the overview; process parameters in a closed disclosure with every field; one GET with the name as query data', async () => {
    const calls = backend('viewer');
    renderAt();
    const user = userEvent.setup();
    const { panel, block } = await open(user);
    expect(await within(block).findByText('Інформацію про проєкт ще не додано.')).toBeTruthy();
    const content = within(panel).getByRole('tabpanel');
    expect(content.firstElementChild).toBe(block);
    const details = content.querySelector('details');
    expect(details?.open).toBe(false);
    const summary = within(content).getByText('Параметри процесу');
    expect(summary.tagName).toBe('SUMMARY');
    for (const label of ['Сервер', 'PM2 id', 'Режим', 'Рестарти, усього', 'Зібрано', 'Дані']) expect(within(details as HTMLElement).getByText(label)).toBeTruthy();
    expect(within(details as HTMLElement).getByText(/«—» означає невідоме значення/)).toBeTruthy();
    await user.click(summary);
    expect(details?.open).toBe(true);
    expect(reads(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/project-info?service=api`]);
    // viewer: no edit and no add
    expect(within(block).queryByRole('button')).toBeNull();
  });

  it('admin, empty: offers to add, never shows invented values', async () => {
    backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    expect(await within(block).findByRole('button', { name: 'Додати інформацію' })).toBeTruthy();
    expect(within(block).queryByRole('link')).toBeNull();
    expect(within(block).queryByRole('button', { name: 'Редагувати інформацію про проєкт' })).toBeNull();
  });

  it('filled: safe external links (new tab, no opener, no referrer, announced) and the description as plain text with line breaks', async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>\nрядок 2';
    backend('admin', (req) => (req.method === 'GET' ? json(200, filled(A, { description: payload })) : undefined));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const github = await within(block).findByRole('link', { name: /https:\/\/github\.com\/acme\/api.*відкривається в новій вкладці/ });
    for (const link of [github, within(block).getByRole('link', { name: /https:\/\/api\.example\.com/ })]) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    expect(github.getAttribute('href')).toBe('https://github.com/acme/api');
    const text = within(block).getByText((_, el) => el?.classList.contains('project-info__text') === true);
    expect(text.textContent).toBe(payload);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(within(block).getByRole('button', { name: 'Редагувати інформацію про проєкт' })).toBeTruthy();
  });

  it('partial: saved values shown, the rest «Не вказано»', async () => {
    backend('viewer', (req) => (req.method === 'GET' ? json(200, info(A, { revision: 1, updatedAt: UPDATED, projectUrl: 'http://localhost:3000/' })) : undefined));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    expect(await within(block).findByRole('link', { name: /http:\/\/localhost:3000\// })).toBeTruthy();
    expect(within(block).getAllByText('Не вказано')).toHaveLength(2);
    expect(within(block).queryByRole('button')).toBeNull(); // viewer: read only
  });

  it('editing follows applications:metadata:write, not servers:manage: an operator without servers:manage edits, a session without the permission does not', async () => {
    backend('operator', (req) => (req.method === 'GET' ? json(200, info(A, { revision: 1, updatedAt: UPDATED, projectUrl: 'http://localhost:3000/' })) : undefined));
    const view = renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    expect(await within(block).findByRole('button', { name: 'Редагувати інформацію про проєкт' })).toBeTruthy();
    view.unmount();
    vi.unstubAllGlobals();
    // An admin-like session that lacks the new permission (an older API) never shows the editor.
    installFetch((req) => {
      if (req.url === '/api/auth/me') return json(200, { ...session('admin'), permissions: session('admin').permissions.filter((p) => p !== 'applications:metadata:write') });
      if (req.url.includes('/project-info')) return json(200, info(A));
      if (req.url.startsWith('/api/servers?')) return json(200, serverPage);
      if (req.url.startsWith('/api/applications?')) return json(200, { items: [app(A)], nextCursor: null, freshWindowSeconds: 180 });
      if (req.url === `/api/servers/${A}/control`) return json(200, control(A));
      if (req.url === `/api/servers/${A}/log-targets`) return json(200, { serverId: A, state: 'supported', reportedAt: new Date().toISOString(), targets: [] });
      if (req.url === `/api/servers/${A}/applications`) return json(200, { serverId: A, serverStatus: 'online', items: [app(A)], freshWindowSeconds: 180, inventory: { state: 'current', reason: null, source: 'pm2', capturedAt: null, collectedAt: '2026-10-13T12:00:01.000Z', reportedAt: null, processCount: 1 } });
      return json(404, {});
    });
    renderAt();
    const again = await open(user);
    expect(await within(again.block).findByText('Інформацію про проєкт ще не додано.')).toBeTruthy();
    expect(within(again.block).queryByRole('button')).toBeNull();
  });

  it('operator: saves through the same contract (one PUT, CSRF, base revision) and sees the server values', async () => {
    const calls = backend('operator', (req) => (req.method === 'GET' ? json(200, info(A)) : json(200, info(A, { revision: 1, description: 'від оператора', updatedAt: UPDATED }))));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'від оператора');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Інформацію про проєкт збережено.')).toBeTruthy();
    expect(saves(calls)).toHaveLength(1);
    expect(saves(calls)[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(bodyOf(saves(calls)[0])).toEqual({ serviceName: 'api', expectedRevision: 0, githubUrl: null, projectUrl: null, description: 'від оператора' });
  });

  it('an unsafe URL in an answer is never turned into a link (contract error → load error)', async () => {
    backend('admin', (req) => (req.method === 'GET' ? json(200, filled(A, { projectUrl: 'javascript:alert(1)' })) : undefined));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    expect(await within(block).findByText('Не вдалося завантажити інформацію про проєкт')).toBeTruthy();
    expect(within(block).queryByRole('link')).toBeNull();
  });

  it('loading, then a failed load: explained with a retry; metrics, tabs and actions stay', async () => {
    const first = deferred<Response>();
    let n = 0;
    const calls = backend('admin', (req) => { if (req.method !== 'GET') return undefined; n += 1; return n === 1 ? first.promise : json(200, filled(A)); });
    renderAt();
    const user = userEvent.setup();
    const { panel, block } = await open(user);
    expect(within(block).getByText('Завантаження інформації про проєкт…')).toBeTruthy();
    first.resolve(json(503, {}, { 'retry-after': '5' }));
    expect(await within(block).findByText('Не вдалося завантажити інформацію про проєкт')).toBeTruthy();
    expect(within(panel).getByText('CPU')).toBeTruthy();
    expect(within(panel).getByRole('tab', { name: 'Логи' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Перезапустити' })).toBeTruthy();
    await user.click(within(block).getByRole('button', { name: 'Спробувати ще раз' }));
    expect(await within(block).findByRole('link', { name: /github\.com\/acme\/api/ })).toBeTruthy();
    expect(reads(calls)).toHaveLength(2);
  });

  it('reads only for the overview: other tabs do not request it, and coming back does not read again', async () => {
    const calls = backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { panel } = await open(user);
    await waitFor(() => { expect(reads(calls)).toHaveLength(1); });
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    await user.click(within(panel).getByRole('tab', { name: 'Огляд' }));
    expect(await within(panel).findByText('Інформацію про проєкт ще не додано.')).toBeTruthy();
    expect(reads(calls)).toHaveLength(1);
  });
});

describe('editing', () => {
  it('admin: inline form prefilled, «Усі поля необов’язкові»; one PUT with CSRF and the base revision; server values shown after; focus back on «Редагувати»', async () => {
    const calls = backend('admin', (req) => {
      if (req.method === 'GET') return json(200, filled(A));
      return json(200, filled(A, { revision: 3, description: 'Новий опис', projectUrl: null }));
    });
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    expect(within(form).getByText(/Усі поля необов’язкові/)).toBeTruthy();
    const f = fields(form);
    expect(document.activeElement).toBe(f.github);
    expect([f.github.value, f.url.value, f.description.value]).toEqual(['https://github.com/acme/api', 'https://api.example.com', 'Публічний API\nдругий рядок']);
    await user.clear(f.url);
    await user.clear(f.description);
    await user.type(f.description, '  Новий опис  ');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Інформацію про проєкт збережено.')).toBeTruthy();
    expect(saves(calls)).toHaveLength(1);
    expect(saves(calls)[0]?.url).toBe(`/api/servers/${A}/project-info`);
    expect(saves(calls)[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(bodyOf(saves(calls)[0])).toEqual({ serviceName: 'api', expectedRevision: 2, githubUrl: 'https://github.com/acme/api', projectUrl: null, description: 'Новий опис' });
    expect(within(block).getByText('Новий опис')).toBeTruthy();
    expect(within(block).getAllByText('Не вказано')).toHaveLength(1);
    expect(document.activeElement).toBe(within(block).getByRole('button', { name: 'Редагувати інформацію про проєкт' }));
  });

  it('«Скасувати» restores the saved values without a request', async () => {
    const calls = backend('admin', (req) => (req.method === 'GET' ? json(200, filled(A)) : undefined));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, ' змінено');
    await user.click(within(form).getByRole('button', { name: 'Скасувати' }));
    expect(within(block).getByText((_, el) => el?.classList.contains('project-info__text') === true).textContent).toBe('Публічний API\nдругий рядок');
    const again = await edit(user, block);
    expect(fields(again).description.value).toBe('Публічний API\nдругий рядок');
    expect(saves(calls)).toHaveLength(0);
  });

  it('invalid values are explained at their fields; nothing is sent', async () => {
    const calls = backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    const f = fields(form);
    await user.type(f.github, 'https://gitlab.com/acme/api');
    await user.type(f.url, 'javascript:alert(1)');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(within(form).getByText(/https:\/\/github.com\/<власник>\/<репозиторій>/)).toBeTruthy();
    expect(within(form).getByText(/Лише явна адреса http:\/\/ або https:\/\//)).toBeTruthy();
    expect(f.github.getAttribute('aria-invalid')).toBe('true');
    expect(f.url.getAttribute('aria-describedby')).toMatch(/-error$/);
    expect(saves(calls)).toHaveLength(0);
    // Fixing a field clears its message.
    await user.clear(f.github);
    expect(f.github.getAttribute('aria-invalid')).toBeNull();
  });

  it('pending: fields and buttons locked, handlers too — a second submit or a forced change does nothing; one PUT', async () => {
    const answer = deferred<Response>();
    const calls = backend('admin', (req) => (req.method === 'GET' ? json(200, info(A)) : answer.promise));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    const f = fields(form);
    await user.type(f.description, 'опис');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    const saving = within(form).getByRole<HTMLButtonElement>('button', { name: 'Збереження…' });
    expect(saving.disabled).toBe(true);
    expect(f.description.disabled).toBe(true);
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Скасувати' }).disabled).toBe(true);
    fireEvent.submit(form);
    fireEvent.change(f.description, { target: { value: 'інше' } });
    expect(saves(calls)).toHaveLength(1);
    expect(armed()).toBe(true); // a save in flight arms beforeunload
    answer.resolve(json(200, info(A, { revision: 1, description: 'опис', updatedAt: UPDATED })));
    expect(await within(block).findByText('Інформацію про проєкт збережено.')).toBeTruthy();
    expect(within(block).getByText('опис')).toBeTruthy();
    expect(saves(calls)).toHaveLength(1);
    expect(armed()).toBe(false);
  });

  it('409: draft kept, saving blocked until an explicit GET re-read; editing locked during the read; a differing state is shown, then saved on purpose with the new revision', async () => {
    const reread = deferred<Response>();
    let reads = 0;
    const calls = backend('admin', (req) => {
      if (req.method === 'GET') { reads += 1; return reads === 1 ? json(200, filled(A)) : reread.promise; }
      return bodyOf(req).expectedRevision === 2 ? json(409, {}) : json(200, filled(A, { revision: 4, description: 'моя версія' }));
    });
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    const f = fields(form);
    await user.clear(f.description);
    await user.type(f.description, 'моя версія');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Інформацію вже змінено в іншому місці')).toBeTruthy();
    expect(f.description.value).toBe('моя версія');
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Зберегти' }).disabled).toBe(true);
    await user.click(within(block).getByRole('button', { name: 'Перечитати збережений стан' }));
    expect(within(block).getByRole('button', { name: 'Перечитування…' })).toBeTruthy();
    expect(f.description.disabled).toBe(true);
    fireEvent.change(f.description, { target: { value: 'під час читання' } });
    reread.resolve(json(200, filled(A, { revision: 3, description: 'чужа версія' })));
    expect(await within(block).findByText(/Перечитано збережений стан \(ревізія 3\) — він відрізняється/)).toBeTruthy();
    expect(f.description.value).toBe('моя версія'); // the GET never overwrote the draft
    expect(within(block).getByText('Збережено зараз (ревізія 3):')).toBeTruthy();
    expect(within(block).getByText('чужа версія')).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Інформацію про проєкт збережено.')).toBeTruthy();
    expect(saves(calls).map((c) => bodyOf(c).expectedRevision)).toEqual([2, 3]);
  });

  it('no answer: «Результат невідомий», no automatic retry; a re-read equal to the draft ends editing without claiming authorship', async () => {
    let gets = 0;
    const calls = installFetchWithSaveError();
    function installFetchWithSaveError() {
      return backend('admin', (req) => {
        if (req.method === 'GET') { gets += 1; return json(200, gets === 1 ? info(A) : info(A, { revision: 1, description: 'опис', updatedAt: UPDATED })); }
        return Promise.reject(new TypeError('network down'));
      });
    }
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'опис');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Результат невідомий')).toBeTruthy();
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Зберегти' }).disabled).toBe(true);
    expect(saves(calls)).toHaveLength(1);
    await user.click(within(block).getByRole('button', { name: 'Перечитати збережений стан' }));
    expect(await within(block).findByText(/Збережений стан збігається з вашою чернеткою \(ревізія 1\)/)).toBeTruthy();
    expect(within(block).getByText(/не доводить, що зберегла саме ваша спроба/)).toBeTruthy();
    expect(within(block).queryByRole('form')).toBeNull();
    expect(saves(calls)).toHaveLength(1);
  });

  it('a list refresh (polling) and a filter change never reset the draft; resizing across 1280 px keeps it too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = backend('admin');
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      const { block } = await open(user);
      const form = await edit(user, block);
      await user.type(fields(form).description, 'чернетка');
      const before = calls.filter((c) => c.url.startsWith('/api/applications?')).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(calls.filter((c) => c.url.startsWith('/api/applications?')).length).toBeGreaterThan(before);
      expect(fields(form).description.value).toBe('чернетка');
      await user.selectOptions(screen.getByLabelText('Статус'), 'online');
      await waitFor(() => { expect(calls.some((c) => c.url.includes('status=online'))).toBe(true); });
      expect(fields(within(await panelOf('alpha')).getByRole('form')).description.value).toBe('чернетка');
      act(() => { setViewportWidth(1024); });
      const narrow = await panelOf('alpha');
      expect(fields(within(narrow).getByRole('form')).description.value).toBe('чернетка');
      expect(reads(calls)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the page guard', () => {
  it('another service, another tab or closing the details with a dirty draft asks first; «Продовжити редагування» keeps it', async () => {
    const calls = backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { panel, block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'чернетка');
    expect(armed()).toBe(true);

    await user.click(await rowOf('beta'));
    await user.click(within(await leaveDialog()).getByRole('button', { name: 'Продовжити редагування' }));
    expect(screen.getByRole('region', { name: 'Деталі: api на alpha' })).toBe(panel);
    expect(fields(form).description.value).toBe('чернетка');

    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    await user.click(within(await leaveDialog()).getByRole('button', { name: 'Продовжити редагування' }));
    expect(within(panel).getByRole('tab', { name: 'Огляд' }).getAttribute('aria-selected')).toBe('true');

    await user.click(within(panel).getByRole('button', { name: 'Закрити деталі' }));
    await user.click(within(await leaveDialog()).getByRole('button', { name: 'Продовжити редагування' }));
    expect(fields(form).description.value).toBe('чернетка');
    expect(saves(calls)).toHaveLength(0);
  });

  it('«Відкинути зміни» drops the draft and continues: the other service loads its own information', async () => {
    const calls = backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    await user.type(fields(await edit(user, block)).description, 'чернетка');
    await user.click(await rowOf('beta'));
    await user.click(within(await leaveDialog()).getByRole('button', { name: 'Відкинути зміни' }));
    const beta = await panelOf('beta');
    expect(await within(beta).findByText('Інформацію про проєкт ще не додано.')).toBeTruthy();
    expect(reads(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/project-info?service=api`, `/api/servers/${B}/project-info?service=api`]);
    expect(armed()).toBe(false);
    // Back to alpha: the dropped draft does not come back.
    await user.click(await rowOf('alpha'));
    const alpha = await panelOf('alpha');
    expect(await within(alpha).findByText('Інформацію про проєкт ще не додано.')).toBeTruthy();
    expect(within(alpha).queryByRole('form')).toBeNull();
  });

  it('no question without changes: opening the editor alone does not guard anything', async () => {
    backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    await edit(user, block);
    expect(armed()).toBe(false);
    await user.click(await rowOf('beta'));
    expect(await panelOf('beta')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaving the page (link, Back) is blocked by the data router with a dirty draft; a pending save says it is still running', async () => {
    const answer = deferred<Response>();
    backend('admin', (req) => (req.method === 'GET' ? json(200, info(A)) : answer.promise));
    const view = renderApp('/applications');
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'чернетка');
    await act(async () => { await view.router.navigate('/servers'); });
    await user.click(within(await leaveDialog()).getByRole('button', { name: 'Продовжити редагування' }));
    expect(view.router.state.location.pathname).toBe('/applications');

    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    await act(async () => { await view.router.navigate('/servers'); });
    const pending = await screen.findByRole('dialog', { name: 'Збереження ще виконується' });
    await user.click(within(pending).getByRole('button', { name: 'Не чекати результату' }));
    await waitFor(() => { expect(view.router.state.location.pathname).toBe('/servers'); });
    // The late answer lands nowhere.
    answer.resolve(json(200, info(A, { revision: 1, description: 'чернетка', updatedAt: UPDATED })));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Інформацію про проєкт збережено.')).toBeNull();
  });

  it('logout with a dirty draft is never blocked', async () => {
    backend('admin');
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    await user.type(fields(await edit(user, block)).description, 'чернетка');
    await act(async () => { await nav.logout?.(); });
    expect(await screen.findByRole('heading', { name: /Node Control|Вхід/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(armed()).toBe(false);
  });
});

describe('answers bound to their service and session', () => {
  it('a late GET of the previous service never shows on the current one', async () => {
    const lateA = deferred<Response>();
    backend('admin', (req) => (req.method !== 'GET' ? undefined : req.url.includes(A) ? lateA.promise : json(200, info(B, { revision: 1, description: 'опис beta', updatedAt: UPDATED }))));
    renderAt();
    const user = userEvent.setup();
    await open(user, 'alpha');
    await user.click(await rowOf('beta'));
    const beta = await panelOf('beta');
    expect(await within(beta).findByText('опис beta')).toBeTruthy();
    lateA.resolve(json(200, filled(A, { description: 'опис alpha' })));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('опис alpha')).toBeNull();
    expect(within(beta).getByText('опис beta')).toBeTruthy();
  });

  it('a late PUT answer after switching away (discarded) changes nothing on the next service', async () => {
    const answer = deferred<Response>();
    backend('admin', (req) => (req.method === 'GET' ? json(200, info(req.url.includes(A) ? A : B)) : answer.promise));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'опис alpha');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    await user.click(await rowOf('beta'));
    await user.click(within(await screen.findByRole('dialog', { name: 'Збереження ще виконується' })).getByRole('button', { name: 'Не чекати результату' }));
    const beta = await panelOf('beta');
    expect(await within(beta).findByText('Інформацію про проєкт ще не додано.')).toBeTruthy();
    answer.resolve(json(200, info(A, { revision: 1, description: 'опис alpha', updatedAt: UPDATED })));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Інформацію про проєкт збережено.')).toBeNull();
    expect(screen.queryByText('опис alpha')).toBeNull();
  });

  it('401 on save ends the session (login screen)', async () => {
    backend('admin', (req) => (req.method === 'GET' ? json(200, info(A)) : json(401, {})));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'опис');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByLabelText('Пароль')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([403, 404])('%i on save: the data and the draft are cleared', async (status) => {
    backend('admin', (req) => (req.method === 'GET' ? json(200, filled(A)) : json(status, {})));
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, ' змінено');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Застосунок або доступ до нього більше недоступні')).toBeTruthy();
    expect(within(block).queryByRole('form')).toBeNull();
    expect(within(block).queryByRole('link')).toBeNull();
    expect(within(block).queryByText(/Публічний API/)).toBeNull();
    expect(armed()).toBe(false);
  });

  it.each([403, 404])('%i on load: nothing is shown, the rest of the details stays', async (status) => {
    backend('viewer', (req) => (req.method === 'GET' ? json(status, {}) : undefined));
    renderAt();
    const user = userEvent.setup();
    const { panel, block } = await open(user);
    expect(await within(block).findByText('Інформація про проєкт недоступна.')).toBeTruthy();
    expect(within(panel).getByText('CPU')).toBeTruthy();
  });

  it('400 and 429 on save: explained, the draft stays and can be saved again', async () => {
    let n = 0;
    const calls = backend('admin', (req) => {
      if (req.method === 'GET') return json(200, info(A));
      n += 1;
      return n === 1 ? json(400, {}) : n === 2 ? json(429, {}, { 'retry-after': '30' }) : json(200, info(A, { revision: 1, description: 'опис', updatedAt: UPDATED }));
    });
    renderAt();
    const user = userEvent.setup();
    const { block } = await open(user);
    const form = await edit(user, block);
    await user.type(fields(form).description, 'опис');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Сервер не прийняв значення')).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Забагато змін поспіль')).toBeTruthy();
    expect(fields(form).description.value).toBe('опис');
    await user.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(block).findByText('Інформацію про проєкт збережено.')).toBeTruthy();
    expect(saves(calls)).toHaveLength(3);
  });
});

describe('audit wording', () => {
  const item = (over: Partial<AuditItem> = {}): AuditItem => ({
    id: '42', occurredAt: UPDATED, event: 'application.project_info_changed', outcome: 'success', actorUserId: '00000000-0000-4000-8000-000000000000', requestId: 'r',
    details: { serverId: A, serviceName: 'api', revision: 3, changed: 'github,url,description' }, context: { actorEmail: 'admin@example.test', serverName: 'alpha', targetUserEmail: null, command: null }, ...over,
  });
  it('readable label, action, target (service · server) and changed fields — no technical code shown as the title', () => {
    expect(eventLabel('application.project_info_changed')).toBe('Зміна інформації про проєкт');
    expect(actionText(item())).toBe('Змінив інформацію про проєкт');
    expect(targetOf(item())).toEqual({ primary: 'api', secondary: 'alpha' });
    expect(detailRows(item().details, 'application.project_info_changed')).toEqual([['Ревізія', '3'], ['Змінено', 'GitHub, адреса проєкту, опис']]);
    // Other events keep their codes.
    expect(detailRows({ changed: 'rules' }, 'settings.alerts_changed')).toEqual([['Змінено', 'rules']]);
  });
});
