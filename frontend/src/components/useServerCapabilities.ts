import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, controlApi, logsApi } from '../api/client';
import type { ControlView, LogTargetsView } from '../api/types';
import { useAuth } from '../auth/AuthContext';

// Control/log capabilities of the servers of a multi-server list, loaded lazily — only when a row menu of that
// server is opened — instead of polling every server (or every row). Per server: at most one request pair in flight
// (concurrent openings share it), answers are reused for MAX_AGE_MS, and only servers of the rows on screen are
// kept (others are dropped and their requests aborted). Bound to the session that started each load; the server
// stays the final authority for every action.

export const CAPABILITIES_MAX_AGE_MS = 10_000;

export interface ServerCapabilities {
  serverId: string;
  control: ControlView | null;
  logs: LogTargetsView | null;
  /** A load failed for a transient reason (network, timeout, 5xx): the menu says so instead of guessing. */
  failed: boolean;
}

export type CapabilityEntry = { status: 'loading' } | { status: 'ready'; caps: ServerCapabilities };

const TRANSIENT: readonly ApiError['kind'][] = ['network', 'timeout', 'unavailable', 'unexpected', 'rate_limited'];

export function useServerCapabilities({ canControl, canLogs }: { canControl: boolean; canLogs: boolean }) {
  const { sessionExpired, bindSession } = useAuth();
  const [entries, setEntries] = useState<ReadonlyMap<string, CapabilityEntry>>(() => new Map());
  const cache = useRef(new Map<string, { caps: ServerCapabilities; at: number }>());
  const inflight = useRef(new Map<string, { controller: AbortController; promise: Promise<ServerCapabilities | null> }>());

  const publish = useCallback(() => {
    const next = new Map<string, CapabilityEntry>();
    for (const [id, c] of cache.current) next.set(id, { status: 'ready', caps: c.caps });
    for (const id of inflight.current.keys()) if (!next.has(id)) next.set(id, { status: 'loading' });
    setEntries(next);
  }, []);

  /** Capabilities of one server: cached (younger than MAX_AGE, unless `fresh`), the running load, or a new load. */
  const ensure = useCallback((serverId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<ServerCapabilities | null> => {
    const running = inflight.current.get(serverId);
    if (running) return running.promise;
    const cached = cache.current.get(serverId);
    if (!fresh && cached && Date.now() - cached.at < CAPABILITIES_MAX_AGE_MS) return Promise.resolve(cached.caps);
    const binding = bindSession();
    const controller = new AbortController();
    let expired = false;
    let failed = false;
    const settle = <T>(load: Promise<T>): Promise<T | null> => load.catch((e: unknown) => {
      if (e instanceof ApiError && e.kind === 'unauthorized') expired = true;
      else if (!(e instanceof ApiError) || TRANSIENT.includes(e.kind)) failed = true;
      return null;
    });
    const promise = Promise.all([
      canControl ? settle(controlApi.view(serverId, controller.signal)) : Promise.resolve(null),
      canLogs ? settle(logsApi.targets(serverId, controller.signal)) : Promise.resolve(null),
    ]).then(([control, logs]) => {
      if (inflight.current.get(serverId)?.controller === controller) inflight.current.delete(serverId);
      if (controller.signal.aborted || !binding.current()) return null;
      if (expired) { sessionExpired(); return null; }
      const caps: ServerCapabilities = { serverId, control, logs, failed: failed && !controller.signal.aborted };
      cache.current.set(serverId, { caps, at: Date.now() });
      publish();
      return caps;
    });
    inflight.current.set(serverId, { controller, promise });
    publish();
    return promise;
  }, [bindSession, canControl, canLogs, publish, sessionExpired]);

  /** The next opening of this server's menu loads again (after a command changed its processes). */
  const invalidate = useCallback((serverId: string) => { cache.current.delete(serverId); }, []);

  /** Keeps only the servers of the rows on screen; requests for the others are aborted. */
  const retain = useCallback((serverIds: readonly string[]) => {
    const keep = new Set(serverIds);
    let changed = false;
    for (const id of [...cache.current.keys()]) if (!keep.has(id)) { cache.current.delete(id); changed = true; }
    for (const [id, run] of [...inflight.current]) if (!keep.has(id)) { run.controller.abort(); inflight.current.delete(id); changed = true; }
    if (changed) publish();
  }, [publish]);

  useEffect(() => {
    const running = inflight.current;
    return () => { for (const run of running.values()) run.controller.abort(); running.clear(); };
  }, []);

  return { entries, ensure, invalidate, retain };
}
