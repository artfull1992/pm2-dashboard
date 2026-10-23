import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
  signal: AbortSignal | undefined;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response>;

/** Replaces global fetch; every request is recorded for assertions. */
export function installFetch(handler: Handler) {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      credentials: init?.credentials,
      signal: init?.signal ?? undefined,
    };
    calls.push(req);
    return Promise.resolve(handler(req));
  }));
  return calls;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export const CSRF = 'C'.repeat(43);

export function session(role: 'admin' | 'operator' | 'viewer' = 'admin', email = `${role}@example.test`) {
  const permissions = {
    viewer: ['monitoring:read'],
    operator: ['monitoring:read', 'processes:control', 'logs:read'],
    admin: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
  }[role];
  return {
    user: { id: `00000000-0000-4000-8000-00000000000${String(['admin', 'operator', 'viewer'].indexOf(role))}`, email, role },
    permissions,
    csrfToken: CSRF,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export function renderApp(path = '/', state?: unknown) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[{ pathname: path, state }]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Simulated window width for media queries (see setup.ts); reset to 1440 after every test. */
export function setViewportWidth(width: number) {
  (globalThis as { __setViewportWidth?: (w: number) => void }).__setViewportWidth?.(width);
}
