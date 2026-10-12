import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

// Bounded polling for live views (ADR-016): refreshes every `intervalMs` only while the tab is visible, aborts on
// unmount and ignores responses that are older than the latest request (no stale state). 401 ends the session.

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; refreshing: boolean }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'error'; retryAfterSeconds: number | null; data: T | null };

export const POLL_INTERVAL_MS = 15_000;

export function usePolledResource<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs = POLL_INTERVAL_MS) {
  const { sessionExpired } = useAuth();
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const controller = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const fetchNow = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const mine = ++seq.current;
    // Promise.resolve().then: a loader that throws synchronously still becomes a handled rejection.
    Promise.resolve().then(() => load(current.signal)).then(
      (data) => { if (mine === seq.current && !current.signal.aborted) setState({ status: 'ready', data, refreshing: false }); },
      (error: unknown) => {
        if (mine !== seq.current || current.signal.aborted || !(error instanceof ApiError) || error.kind === 'aborted') return;
        if (error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error.kind === 'forbidden') { setState({ status: 'forbidden' }); return; }
        if (error.kind === 'not_found') { setState({ status: 'not_found' }); return; }
        setState((prev) => ({ status: 'error', retryAfterSeconds: error.retryAfterSeconds, data: prev.status === 'ready' ? prev.data : prev.status === 'error' ? prev.data : null }));
      },
    );
  }, [load, sessionExpired]);

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

  return { state, reload: fetchNow };
}
