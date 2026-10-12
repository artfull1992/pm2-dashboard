import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { safeInternalPath } from '../src/auth/guards';
import { CSRF, deferred, installFetch, json, noContent, renderApp, session } from './support';

const PASSWORD = 'synthetic-Ui-Passw0rd';
let storageWrites: string[];

beforeEach(() => {
  storageWrites = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) { storageWrites.push(key); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(storageWrites).toEqual([]); // nothing (tokens, passwords, session) ever goes to web storage
  expect(document.cookie).toBe(''); // the session cookie is HttpOnly and never touched by JS
});

async function fillLogin(email = 'admin@example.test', password = PASSWORD) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Пароль'), password);
  await user.click(screen.getByRole('button', { name: 'Увійти' }));
  return user;
}

describe('startup session check', () => {
  it('me 200 → dashboard with user, role and permitted navigation only', async () => {
    installFetch(() => json(200, session('viewer')));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Огляд' })).toBeTruthy();
    expect(screen.getByText('viewer@example.test')).toBeTruthy();
    expect(screen.getByText('Спостерігач')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Основна навігація' });
    expect(nav.textContent).toContain('Сервери');
    expect(nav.textContent).not.toContain('Журнал аудиту');
  });

  it('me 401 → login page', async () => {
    installFetch(() => json(401, {}));
    renderApp('/servers');
    expect(await screen.findByRole('heading', { name: 'GOIT Node Control' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it.each([
    ['503', () => json(503, {}, { 'retry-after': '5' })],
    ['network error', () => Promise.reject(new TypeError('offline'))],
  ])('me %s → "unavailable" with retry, not a logout', async (_name, failure) => {
    let fail = true;
    installFetch(() => (fail ? failure() : json(200, session())));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Сервіс тимчасово недоступний' })).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    expect(await screen.findByRole('heading', { name: 'Огляд' })).toBeTruthy();
  });
});

describe('login', () => {
  it('success → returns to the requested internal page; password field is cleared; password only sent in the login request', async () => {
    const calls = installFetch((req) => (req.url === '/api/auth/me' ? json(401, {}) : json(200, session('admin'))));
    renderApp('/login', { from: '/audit' });
    installFetch((req) => {
      calls.push(req);
      if (req.url === '/api/auth/login') return json(200, session('admin'));
      return json(200, { items: [], nextBeforeId: null });
    });
    await fillLogin();
    expect(await screen.findByRole('heading', { name: 'Журнал аудиту' })).toBeTruthy();
    const withPassword = calls.filter((c) => c.body?.includes(PASSWORD));
    expect(withPassword.map((c) => c.url)).toEqual(['/api/auth/login']);
  });

  it.each([
    [401, {}, 'Невірний email або пароль.'],
    [403, {}, 'Вхід із цієї адреси заборонено. Зверніться до адміністратора.'],
    [429, { 'retry-after': '30' }, 'Забагато спроб входу. Спробуйте через 30 с.'],
    [503, { 'retry-after': '120' }, 'Сервіс тимчасово недоступний. Спробуйте через 2 хв.'],
  ])('%i → specific message, password cleared, focus back on password', async (status, headers, message) => {
    installFetch((req) => (req.url === '/api/auth/me' ? json(401, {}) : json(status, { message: 'raw server text' }, headers)));
    renderApp('/login');
    await fillLogin();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByText(/raw server text/)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Пароль').value).toBe('');
    expect(document.activeElement).toBe(screen.getByLabelText('Пароль'));
  });

  it('accessible client validation: errors linked to fields, focus moves, no request sent', async () => {
    const calls = installFetch(() => json(401, {}));
    renderApp('/login');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Увійти' }));
    const email = screen.getByLabelText('Email');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Введіть коректний email.');
    expect(document.activeElement).toBe(email);
    expect(calls.filter((c) => c.url === '/api/auth/login')).toHaveLength(0);
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil', 'javascript:alert(1)', '/login'])('never redirects to %s', (from) => {
    expect(safeInternalPath(from)).toBe('/');
  });
});

describe('logout', () => {
  it('204 → login page; CSRF header from memory; private UI gone', async () => {
    const calls = installFetch((req) => (req.url === '/api/auth/logout' ? noContent() : json(200, session())));
    renderApp('/');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Вийти' }));
    expect(await screen.findByText('Ви вийшли з системи.')).toBeTruthy();
    const logout = calls.find((c) => c.url === '/api/auth/logout');
    expect(logout?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(logout?.credentials).toBe('same-origin');
    expect(screen.queryByText('admin@example.test')).toBeNull();
  });

  it('401 (session already gone) → treated as logged out', async () => {
    installFetch((req) => (req.url === '/api/auth/logout' ? json(401, {}) : json(200, session())));
    renderApp('/');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Вийти' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
  });

  it('503 → stays signed in and explains the failure', async () => {
    installFetch((req) => (req.url === '/api/auth/logout' ? json(503, {}) : json(200, session())));
    renderApp('/');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Вийти' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Не вдалося вийти');
    expect(screen.getByText('admin@example.test')).toBeTruthy();
  });
});

describe('protected routes and permissions', () => {
  it.each(['viewer', 'operator'] as const)('%s: direct /audit URL → forbidden, audit API never called', async (role) => {
    const calls = installFetch(() => json(200, session(role)));
    renderApp('/audit');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/api/audit'))).toBe(false);
  });

  it('admin sees the audit link; unknown private path shows not found', async () => {
    installFetch(() => json(200, session('admin')));
    renderApp('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Сторінку не знайдено' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Журнал аудиту' })).toBeTruthy();
  });

  it('servers and applications show honest empty states, no fake controls', async () => {
    installFetch(() => json(200, session('operator')));
    renderApp('/servers');
    expect(await screen.findByRole('heading', { name: 'Ще немає підключених серверів' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /перезапуст|зупин|старт/i })).toBeNull();
  });
});

describe('session races', () => {
  function Probe() {
    const auth = useAuth();
    return (
      <div>
        <p data-testid="status">{auth.state.status === 'authenticated' ? `auth:${auth.state.session.user.email}` : auth.state.status}</p>
        <button type="button" onClick={() => { void auth.login('b@example.test', PASSWORD); }}>login-b</button>
        <button type="button" onClick={() => { void auth.logout(); }}>logout</button>
        <button type="button" onClick={() => { auth.checkSession(); }}>check</button>
        <button type="button" onClick={() => { auth.sessionExpired(); }}>expire</button>
      </div>
    );
  }

  it('a stale me response cannot restore a session that already expired', async () => {
    const me = deferred<Response>();
    installFetch(() => me.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await userEvent.setup().click(screen.getByText('expire'));
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
    await act(async () => { me.resolve(json(200, session('admin'))); await Promise.resolve(); });
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
  });

  it('a slow login that resolves after logout does not sign the user back in', async () => {
    const login = deferred<Response>();
    installFetch((req) => {
      if (req.url === '/api/auth/me') return json(200, session('admin', 'a@example.test'));
      if (req.url === '/api/auth/login') return login.promise;
      return noContent();
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => { expect(screen.getByTestId('status').textContent).toBe('auth:a@example.test'); });
    const user = userEvent.setup();
    await user.click(screen.getByText('login-b'));
    await user.click(screen.getByText('logout'));
    await waitFor(() => { expect(screen.getByTestId('status').textContent).toBe('anonymous'); });
    await act(async () => { login.resolve(json(200, session('admin', 'b@example.test'))); await Promise.resolve(); });
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
  });

  it('a new login supersedes a pending startup me', async () => {
    const me = deferred<Response>();
    installFetch((req) => (req.url === '/api/auth/me' ? me.promise : json(200, session('admin', 'b@example.test'))));
    render(<AuthProvider><Probe /></AuthProvider>);
    await userEvent.setup().click(screen.getByText('login-b'));
    await waitFor(() => { expect(screen.getByTestId('status').textContent).toBe('auth:b@example.test'); });
    await act(async () => { me.resolve(json(401, {})); await Promise.resolve(); });
    expect(screen.getByTestId('status').textContent).toBe('auth:b@example.test');
  });
});
