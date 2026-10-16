import {
  type ApplicationPage, type AuditPage, type CommandView, ContractError, type ControlAction, type ControlView, type IssuedCredential,
  parseApplicationPage, parseAuditPage, parseCommandList, parseCommandView, parseControlView, parseIssuedCredential,
  type LogRequestView, type LogTargetsView, parseLogRequestCreated, parseLogRequestView, parseLogTargets,
  parseDashboard, type DashboardView, parseSettingsView, parseSlackTestResult, type SettingsView, type SlackTestResult, parseAlertsStatus, parseIncidentPage, type AlertsStatus, type IncidentPage, parseRevokeResult, parseServerApplications, parseUserPage, parseUserView, type Role, type UserPage, type UserView, parseServerDetail, parseServerPage, parseServerSummary, parseSessionInfo,
  type ProcessStatus, type ServerApplications, type ServerDetail, type ServerPage, type ServerSummary, type SessionInfo,
} from './types';

// Central API client (ADR-012):
//  * relative /api URLs only, `credentials: 'same-origin'` — the browser manages the HttpOnly session cookie;
//  * bounded timeout + caller cancellation; never retries automatically (login/logout are not idempotent);
//  * responses are validated at this boundary; server text is never surfaced — the UI maps error kinds to its
//    own messages; the CSRF token is passed in explicitly from in-memory auth state.

export const REQUEST_TIMEOUT_MS = 10_000;

export type ApiErrorKind =
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'rate_limited' // 429
  | 'unavailable' // 503 / 502 / 504
  | 'invalid_request' // 400
  | 'not_found' // 404
  | 'conflict' // 409
  | 'unprocessable' // 422 (e.g. wrong current password)
  | 'too_large' // 413
  | 'network' // fetch rejected (offline, DNS, refused)
  | 'timeout'
  | 'aborted' // cancelled by the caller (unmount, logout)
  | 'unexpected'; // anything else, incl. contract violations

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(kind: ApiErrorKind, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400: return 'invalid_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 422: return 'unprocessable';
    case 413: return 'too_large';
    case 429: return 'rate_limited';
    case 502: case 503: case 504: return 'unavailable';
    default: return 'unexpected';
  }
}

/** Retry-After as a bounded number of seconds (header may be seconds or an HTTP date). */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) : Math.ceil((Date.parse(header) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, 24 * 3600);
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Validates the 2xx JSON body; omitted → the response must be 204. */
  parse?: (value: unknown) => T;
}

export async function apiRequest<T = undefined>(path: `/api/${string}`, options: RequestOptions<T> = {}): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrfToken !== undefined) headers['x-csrf-token'] = options.csrfToken;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers,
      signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    if (options.signal?.aborted) throw new ApiError('aborted');
    if (timeout.aborted) throw new ApiError('timeout');
    throw new ApiError('network');
  }
  // A transport may still complete after cancellation: a result nobody waits for any more is never returned
  // (checked after the response, after the body, and right before returning).
  const settled = () => {
    if (options.signal?.aborted) throw new ApiError('aborted');
    if (timeout.aborted) throw new ApiError('timeout');
  };
  settled();

  if (!response.ok) {
    throw new ApiError(kindForStatus(response.status), response.status, parseRetryAfter(response.headers.get('retry-after')));
  }
  if (!options.parse) {
    if (response.status !== 204) throw new ApiError('unexpected', response.status);
    settled();
    return undefined as T;
  }
  let result: T;
  try {
    result = options.parse(await response.json());
  } catch (error) {
    settled();
    if (error instanceof ContractError || error instanceof SyntaxError) throw new ApiError('unexpected', response.status);
    throw new ApiError('unexpected', response.status);
  }
  settled();
  return result;
}

export const authApi = {
  me: (signal?: AbortSignal) => apiRequest('/api/auth/me', { parse: parseSessionInfo, ...(signal ? { signal } : {}) }),
  login: (email: string, password: string, signal?: AbortSignal) =>
    apiRequest('/api/auth/login', { method: 'POST', body: { email, password }, parse: parseSessionInfo, ...(signal ? { signal } : {}) }),
  logout: (csrfToken: string, signal?: AbortSignal) =>
    apiRequest('/api/auth/logout', { method: 'POST', csrfToken, ...(signal ? { signal } : {}) }),
  /** 204 on success; every session (this one included) is gone afterwards. Never retried automatically. */
  changePassword: (currentPassword: string, newPassword: string, csrfToken: string, signal?: AbortSignal) =>
    apiRequest('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword }, csrfToken, ...(signal ? { signal } : {}) }),
};

// --- Alert settings (Task 013.1, ADR-022) --------------------------------------------------------------------------
export interface SettingsPatchBody {
  revision: number; engineEnabled?: boolean; deliveryEnabled?: boolean;
  rules?: Partial<SettingsView['rules']>; timing?: Partial<SettingsView['timing']>; advanced?: Partial<SettingsView['advanced']>;
}
/** Every mutation is sent once; never retried automatically. The webhook is only ever sent, never received. */
export const settingsApi = {
  get: (signal?: AbortSignal): Promise<SettingsView> => apiRequest('/api/settings/alerts', { parse: parseSettingsView, ...(signal ? { signal } : {}) }),
  patch: (body: SettingsPatchBody, csrfToken: string, signal?: AbortSignal): Promise<SettingsView> =>
    apiRequest('/api/settings/alerts', { method: 'PATCH', body, csrfToken, parse: parseSettingsView, ...(signal ? { signal } : {}) }),
  saveSlack: (generation: number, webhookUrl: string, csrfToken: string, signal?: AbortSignal): Promise<SettingsView> =>
    apiRequest('/api/settings/integrations/slack', { method: 'PUT', body: { generation, webhookUrl }, csrfToken, parse: parseSettingsView, ...(signal ? { signal } : {}) }),
  removeSlack: (generation: number, csrfToken: string, signal?: AbortSignal): Promise<SettingsView> =>
    apiRequest('/api/settings/integrations/slack', { method: 'DELETE', body: { generation }, csrfToken, parse: parseSettingsView, ...(signal ? { signal } : {}) }),
  testSlack: (generation: number, csrfToken: string, signal?: AbortSignal): Promise<SlackTestResult> =>
    apiRequest('/api/settings/integrations/slack/test', { method: 'POST', body: { generation }, csrfToken, timeoutMs: 40_000, parse: parseSlackTestResult, ...(signal ? { signal } : {}) }),
};

// --- Alerts (Task 013, ADR-021) ----------------------------------------------------------------------------------
export const ALERTS_PAGE_SIZE = 25;
export const alertsApi = {
  status: (signal?: AbortSignal): Promise<AlertsStatus> => apiRequest('/api/alerts/status', { parse: parseAlertsStatus, ...(signal ? { signal } : {}) }),
  list: (state: 'active' | 'resolved', before: string | null, signal?: AbortSignal): Promise<IncidentPage> => {
    const query = new URLSearchParams({ state, limit: String(ALERTS_PAGE_SIZE) });
    if (before !== null) {
      if (!UUID_RE.test(before)) throw new ApiError('invalid_request');
      query.set('before', before);
    }
    return apiRequest(`/api/alerts?${query.toString()}`, { parse: parseIncidentPage, ...(signal ? { signal } : {}) });
  },
};

// --- Dashboard (Task 012, ADR-020) -------------------------------------------------------------------------------
export const dashboardApi = {
  get: (signal?: AbortSignal): Promise<DashboardView> => apiRequest('/api/dashboard', { parse: parseDashboard, ...(signal ? { signal } : {}) }),
};

// --- Users (Task 011, ADR-019) -----------------------------------------------------------------------------------
export const USERS_PAGE_SIZE = 100;

export const usersApi = {
  /** One keyset page; `after` is the opaque user-id cursor from the previous page's `nextAfter` (never an email). */
  list: (after: string | null, signal?: AbortSignal): Promise<UserPage> => {
    const query = new URLSearchParams({ limit: String(USERS_PAGE_SIZE) });
    if (after !== null) {
      if (!UUID_RE.test(after)) throw new ApiError('invalid_request');
      query.set('after', after);
    }
    return apiRequest(`/api/users?${query.toString()}`, { parse: parseUserPage, ...(signal ? { signal } : {}) });
  },
  create: (input: { email: string; password: string; role: Role }, csrfToken: string, signal?: AbortSignal): Promise<UserView> =>
    apiRequest('/api/users', { method: 'POST', body: input, csrfToken, parse: parseUserView, ...(signal ? { signal } : {}) }),
  /** The reply must describe the user that was changed. */
  update: (id: string, change: { role?: Role; isActive?: boolean }, csrfToken: string, signal?: AbortSignal): Promise<UserView> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ApiError('invalid_request');
    return apiRequest(`/api/users/${id}`, {
      method: 'PATCH', body: change, csrfToken,
      parse: (v) => { const u = parseUserView(v); if (u.id !== id) throw new ContractError(); return u; },
      ...(signal ? { signal } : {}),
    });
  },
};

export const AUDIT_PAGE_SIZE = 25;

export function fetchAuditPage(beforeId: string | null, signal?: AbortSignal): Promise<AuditPage> {
  const query = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
  if (beforeId !== null) {
    if (!/^[1-9]\d{0,17}$/.test(beforeId)) return Promise.reject(new ApiError('invalid_request'));
    query.set('beforeId', beforeId);
  }
  return apiRequest(`/api/audit?${query.toString()}`, { parse: parseAuditPage, ...(signal ? { signal } : {}) });
}

export type { AuditPage, SessionInfo };

// --- Server registry (Task 007) ------------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const serverPath = (id: string): `/api/${string}` => {
  if (!UUID_RE.test(id)) throw new ApiError('invalid_request');
  return `/api/servers/${id}`;
};

export interface ApplicationFilter {
  serverId: string | null;
  status: ProcessStatus | null;
  cursor: string | null;
  /** Name search (trimmed; empty = none). */
  q?: string | null;
}
export const SEARCH_MAX_LENGTH = 128;

export const applicationsApi = {
  list: (filter: ApplicationFilter, signal?: AbortSignal): Promise<ApplicationPage> => {
    const query = new URLSearchParams({ limit: '50' });
    if (filter.serverId !== null) {
      if (!UUID_RE.test(filter.serverId)) throw new ApiError('invalid_request');
      query.set('serverId', filter.serverId);
    }
    if (filter.status !== null) query.set('status', filter.status);
    const q = filter.q?.trim() ?? '';
    if (q !== '') {
      if (q.length > SEARCH_MAX_LENGTH) throw new ApiError('invalid_request');
      query.set('q', q);
    }
    if (filter.cursor !== null) query.set('cursor', filter.cursor);
    return apiRequest(`/api/applications?${query.toString()}`, { parse: parseApplicationPage, ...(signal ? { signal } : {}) });
  },
  /** The reply must belong to the requested server; anything else is a contract violation (never shown). */
  forServer: (id: string, signal?: AbortSignal): Promise<ServerApplications> =>
    apiRequest(`${serverPath(id)}/applications`, {
      parse: (value) => {
        const result = parseServerApplications(value);
        if (result.serverId !== id) throw new ContractError();
        return result;
      },
      ...(signal ? { signal } : {}),
    }),
};

export const logsApi = {
  targets: (serverId: string, signal?: AbortSignal): Promise<LogTargetsView> =>
    apiRequest(`${serverPath(serverId)}/log-targets`, {
      parse: (v) => { const r = parseLogTargets(v); if (r.serverId !== serverId) throw new ContractError(); return r; },
      ...(signal ? { signal } : {}),
    }),
  /** Starts one bounded read (never retried automatically). */
  create: (serverId: string, targetKey: string, csrfToken: string, signal?: AbortSignal): Promise<{ requestId: string; deadlineAt: string }> =>
    apiRequest(`${serverPath(serverId)}/log-requests`, { method: 'POST', body: { targetKey }, csrfToken, parse: parseLogRequestCreated, ...(signal ? { signal } : {}) }),
  /** The server waits up to 8 s for the result; the client timeout covers that. */
  get: (requestId: string, signal?: AbortSignal): Promise<LogRequestView> => {
    if (!UUID_RE.test(requestId)) throw new ApiError('invalid_request');
    return apiRequest(`/api/log-requests/${requestId}`, {
      timeoutMs: 12_000,
      parse: (v) => { const r = parseLogRequestView(v); if (r.requestId !== requestId) throw new ContractError(); return r; },
      ...(signal ? { signal } : {}),
    });
  },
};

export const controlApi = {
  view: (serverId: string, signal?: AbortSignal): Promise<ControlView> =>
    apiRequest(`${serverPath(serverId)}/control`, {
      parse: (v) => { const r = parseControlView(v); if (r.serverId !== serverId) throw new ContractError(); return r; },
      ...(signal ? { signal } : {}),
    }),
  commands: (serverId: string, signal?: AbortSignal): Promise<CommandView[]> =>
    apiRequest(`${serverPath(serverId)}/control-commands?limit=10`, {
      parse: (v) => { const r = parseCommandList(v); if (r.some((c) => c.serverId !== serverId)) throw new ContractError(); return r; },
      ...(signal ? { signal } : {}),
    }),
  /** Recent commands of ONE allowlist target of this server (filtered by the API before its limit). */
  history: (serverId: string, targetKey: string, signal?: AbortSignal): Promise<CommandView[]> => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetKey)) throw new ApiError('invalid_request');
    return apiRequest(`${serverPath(serverId)}/control-commands?limit=10&targetKey=${targetKey}`, {
      parse: (v) => {
        const r = parseCommandList(v);
        if (r.some((c) => c.serverId !== serverId || c.targetKey !== targetKey)) throw new ContractError();
        return r;
      },
      ...(signal ? { signal } : {}),
    });
  },
  command: (id: string, signal?: AbortSignal): Promise<CommandView> => {
    if (!UUID_RE.test(id)) throw new ApiError('invalid_request');
    return apiRequest(`/api/control-commands/${id}`, {
      parse: (v) => { const r = parseCommandView(v); if (r.id !== id) throw new ContractError(); return r; },
      ...(signal ? { signal } : {}),
    });
  },
  /** Never retried automatically: the caller reuses the same idempotency key only on an explicit user retry. */
  create: (serverId: string, body: { targetKey: string; action: ControlAction; idempotencyKey: string }, csrfToken: string, signal?: AbortSignal): Promise<CommandView> =>
    apiRequest(`${serverPath(serverId)}/control-commands`, {
      method: 'POST', body, csrfToken,
      parse: (v) => { const r = parseCommandView(v); if (r.serverId !== serverId) throw new ContractError(); return r; },
      ...(signal ? { signal } : {}),
    }),
};

export const serversApi = {
  list: (signal?: AbortSignal): Promise<ServerPage> =>
    apiRequest('/api/servers?limit=100', { parse: parseServerPage, ...(signal ? { signal } : {}) }),
  get: (id: string, signal?: AbortSignal): Promise<ServerDetail> =>
    apiRequest(serverPath(id), { parse: parseServerDetail, ...(signal ? { signal } : {}) }),
  create: (name: string, csrfToken: string, signal?: AbortSignal): Promise<ServerSummary> =>
    apiRequest('/api/servers', { method: 'POST', body: { name }, csrfToken, parse: parseServerSummary, ...(signal ? { signal } : {}) }),
  /** The response carries a one-time secret: callers must not log or persist it. */
  issueCredential: (id: string, csrfToken: string, signal?: AbortSignal): Promise<IssuedCredential> =>
    apiRequest(`${serverPath(id)}/agent-credentials`, { method: 'POST', csrfToken, parse: parseIssuedCredential, ...(signal ? { signal } : {}) }),
  revokeCredential: (id: string, csrfToken: string, signal?: AbortSignal): Promise<{ serverId: string; revoked: boolean }> =>
    apiRequest(`${serverPath(id)}/agent-credentials/revoke`, { method: 'POST', csrfToken, parse: parseRevokeResult, ...(signal ? { signal } : {}) }),
};
