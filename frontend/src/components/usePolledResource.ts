import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

// Bounded polling for live views (ADR-015): refreshes every `intervalMs` only while the tab is visible, aborts on
// unmount and ignores responses that are older than the latest request (no stale state). 401 ends the session.
//
// State is bound to `resourceKey` (e.g. the server id): data of another key is never returned — after a key change
// the hook reports `loading` in the very same render, and a failed load of the new key never falls back to the old
// key's data. Last known data survives an error only for a refresh of the same key.

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; refreshing: boolean }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'error'; retryAfterSeconds: number | null; data: T | null };

export const POLL_INTERVAL_MS = 15_000;

const LOADING = { status: 'loading' } as const;

export function usePolledResource<T>(load: (signal: AbortSignal) => Promise<T>, resourceKey: string, intervalMs = POLL_INTERVAL_MS) {
  const { sessionExpired } = useAuth();
  const [owned, setOwned] = useState<{ key: string; state: ResourceState<T> }>({ key: resourceKey, state: LOADING });
  const controller = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const fetchNow = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const mine = ++seq.current;
    const set = (state: ResourceState<T>) => { setOwned({ key: resourceKey, state }); };
    // Promise.resolve().then: a loader that throws synchronously still becomes a handled rejection.
    Promise.resolve().then(() => load(current.signal)).then(
      (data) => { if (mine === seq.current && !current.signal.aborted) set({ status: 'ready', data, refreshing: false }); },
      (error: unknown) => {
        if (mine !== seq.current || current.signal.aborted || !(error instanceof ApiError) || error.kind === 'aborted') return;
        if (error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error.kind === 'forbidden') { set({ status: 'forbidden' }); return; }
        if (error.kind === 'not_found') { set({ status: 'not_found' }); return; }
        setOwned((prev) => {
          const last = prev.key !== resourceKey ? null : prev.state.status === 'ready' || prev.state.status === 'error' ? prev.state.data : null;
          return { key: resourceKey, state: { status: 'error', retryAfterSeconds: error.retryAfterSeconds, data: last } };
        });
      },
    );
  }, [load, resourceKey, sessionExpired]);

  useEffect(() => {
    fetchNow();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') fetchNow(); }, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchNow(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      seq.current += 1;
      controller.current?.abort();
    };
  }, [fetchNow, intervalMs]);

  const state: ResourceState<T> = owned.key === resourceKey ? owned.state : LOADING;
  return { state, reload: fetchNow };
}
