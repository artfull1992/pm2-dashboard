import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, authApi, type SessionInfo } from '../api/client';
import type { Permission } from '../api/types';

// Session state lives ONLY in React memory (ADR-012): no localStorage/sessionStorage/URL. The HttpOnly cookie is
// managed by the browser. Every async result is tied to an "epoch"; logout, expiry and a new session bump it, so
// a response that started earlier (stale me/login) can never restore a session that is already gone.

export type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous'; reason: 'initial' | 'logged_out' | 'expired' | 'password_changed' }
  | { status: 'authenticated'; session: SessionInfo }
  | { status: 'unavailable'; retryAfterSeconds: number | null };

export type LoginOutcome =
  | { ok: true }
  | { ok: false; kind: ApiError['kind']; retryAfterSeconds: number | null };

export interface AuthContextValue {
  state: AuthState;
  /** Re-runs GET /api/auth/me (initial load, "retry" on the unavailable screen). */
  checkSession: () => void;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  logout: () => Promise<{ ok: boolean }>;
  /** Called by pages when any API call returns 401: the session is over, drop private state. */
  sessionExpired: () => void;
  /**
   * Binds an async operation to the current session (auth epoch). `current()` is false once that session ended —
   * logout, expiry or a new login — so a late answer of an earlier session never changes the present one.
   */
  bindSession: () => SessionBinding;
  /** The own password was changed in `binding`'s session: drop private state, back to login. No-op if stale. */
  passwordChanged: (binding: SessionBinding) => void;
  can: (permission: Permission) => boolean;
}

export interface SessionBinding { current: () => boolean }

const AuthContext = createContext<AuthContextValue | null>(null);
const MAX_TIMER_MS = 2 ** 31 - 1;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'checking' });
  const epoch = useRef(0);
  const inflight = useRef(new Set<AbortController>());

  /** Starts a new epoch: aborts every request of the previous one. */
  const nextEpoch = useCallback(() => {
    epoch.current += 1;
    for (const controller of inflight.current) controller.abort();
    inflight.current.clear();
    return epoch.current;
  }, []);

  const track = useCallback(() => {
    const controller = new AbortController();
    inflight.current.add(controller);
    return { controller, done: () => inflight.current.delete(controller) };
  }, []);

  /** Starts GET /me for a new epoch; state changes only in the response callbacks. */
  const startMe = useCallback(() => {
    const mine = nextEpoch();
    const { controller, done } = track();
    authApi.me(controller.signal).then(
      (session) => { if (epoch.current === mine) setState({ status: 'authenticated', session }); },
      (error: unknown) => {
        if (epoch.current !== mine || !(error instanceof ApiError) || error.kind === 'aborted') return;
        if (error.kind === 'unauthorized') setState({ status: 'anonymous', reason: 'initial' });
        else setState({ status: 'unavailable', retryAfterSeconds: error.retryAfterSeconds });
      },
    ).finally(done);
  }, [nextEpoch, track]);

  const checkSession = useCallback(() => {
    setState({ status: 'checking' });
    startMe();
  }, [startMe]);

  const login = useCallback(async (email: string, password: string): Promise<LoginOutcome> => {
    const mine = nextEpoch();
    const { controller, done } = track();
    try {
      const session = await authApi.login(email, password, controller.signal);
      if (epoch.current !== mine) return { ok: false, kind: 'aborted', retryAfterSeconds: null };
      setState({ status: 'authenticated', session });
      return { ok: true };
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('unexpected');
      return { ok: false, kind: apiError.kind, retryAfterSeconds: apiError.retryAfterSeconds };
    } finally {
      done();
    }
  }, [nextEpoch, track]);

  const sessionExpired = useCallback(() => {
    nextEpoch();
    setState({ status: 'anonymous', reason: 'expired' });
  }, [nextEpoch]);

  const bindSession = useCallback((): SessionBinding => {
    const mine = epoch.current;
    return { current: () => epoch.current === mine };
  }, []);

  const passwordChanged = useCallback((binding: SessionBinding) => {
    if (!binding.current()) return;
    nextEpoch();
    setState({ status: 'anonymous', reason: 'password_changed' });
  }, [nextEpoch]);

  const logout = useCallback(async (): Promise<{ ok: boolean }> => {
    if (state.status !== 'authenticated') return { ok: true };
    const { csrfToken } = state.session;
    const mine = epoch.current;
    try {
      await authApi.logout(csrfToken);
    } catch (error) {
      // 401: the server session is already gone — same end state as a successful logout.
      if (!(error instanceof ApiError) || error.kind !== 'unauthorized') return { ok: false };
    }
    if (epoch.current === mine) {
      nextEpoch();
      setState({ status: 'anonymous', reason: 'logged_out' });
    }
    return { ok: true };
  }, [state, nextEpoch]);

  useEffect(() => {
    startMe(); // initial state is already 'checking'
    const pending = inflight.current;
    return () => {
      epoch.current += 1;
      for (const controller of pending) controller.abort();
    };
  }, [startMe]);

  // Absolute session expiry: re-check with the server when it is due (the server stays authoritative).
  useEffect(() => {
    if (state.status !== 'authenticated') return undefined;
    const delay = Math.min(Math.max(Date.parse(state.session.expiresAt) - Date.now(), 0) + 1000, MAX_TIMER_MS);
    const timer = setTimeout(checkSession, delay);
    return () => { clearTimeout(timer); };
  }, [state, checkSession]);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    checkSession,
    login,
    logout,
    sessionExpired,
    bindSession,
    passwordChanged,
    can: (permission) => state.status === 'authenticated' && state.session.permissions.includes(permission),
  }), [state, checkSession, login, logout, sessionExpired, bindSession, passwordChanged]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
