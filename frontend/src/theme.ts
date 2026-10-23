import { useSyncExternalStore } from 'react';

// React side of the theme preference. The logic (allowed values, storage key, how a choice is applied) lives only in
// public/theme-init.js, which runs before the first paint and exposes `window.ncTheme`; this module keeps the current
// choice as a small store shared by every switcher (sidebar, rail, mobile menu, login) and follows other tabs through
// the storage event. If storage is unavailable the choice still applies to this tab (kept in memory).

export type ThemePreference = 'system' | 'light' | 'dark';

interface ThemeCore {
  KEY: string;
  values: ThemePreference[];
  valid: (v: unknown) => v is ThemePreference;
  read: () => ThemePreference;
  apply: (pref: ThemePreference) => void;
  save: (pref: ThemePreference) => boolean;
}

declare global {
  interface Window { ncTheme?: ThemeCore }
}

export const THEME_LABELS: Record<ThemePreference, string> = { light: 'Світла', dark: 'Темна', system: 'Як у системі' };
export const THEME_ORDER: ThemePreference[] = ['light', 'dark', 'system'];

const core = (): ThemeCore | undefined => window.ncTheme;
// Read lazily: the bootstrap script is guaranteed to have run before the first render, not before module evaluation.
let current: ThemePreference | null = null;
const get = (): ThemePreference => (current ??= core()?.read() ?? 'system');
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

function onStorage(event: StorageEvent) {
  const c = core();
  if (!c || (event.key !== c.KEY && event.key !== null)) return;
  current = c.read();
  c.apply(current);
  notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** Applies and (when possible) stores the choice; every switcher updates. */
export function setThemePreference(pref: ThemePreference) {
  const c = core();
  if (!c?.valid(pref)) return;
  current = pref;
  c.save(pref);
  c.apply(pref);
  notify();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, get, () => 'system');
}

/** Test hook: re-read the stored choice (e.g. after the bootstrap script was loaded again). */
export function resetThemeForTests() { current = null; notify(); }
