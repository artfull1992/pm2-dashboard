import { cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { resetThemeForTests } from '../src/theme';

// The theme bootstrap of index.html (public/theme-init.js) — the one implementation of the theme logic — is loaded
// into jsdom exactly as the browser runs it before React.
export const THEME_INIT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/theme-init.js'), 'utf8');
window.eval(THEME_INIT);

// jsdom has no layout and no matchMedia: a minimal stub answers `(min-width: Npx)` / `(max-width: Npx)` against a
// test-controlled width (default: a 1440 px desktop). Tests change it with `setViewportWidth` (support.tsx).
const viewport = { width: 1440 };
const listeners = new Set<() => void>();
const evaluate = (query: string) => {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query);
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  return (!min || viewport.width >= Number(min[1])) && (!max || viewport.width <= Number(max[1]));
};
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() { return evaluate(query); },
    media: query,
    onchange: null,
    addEventListener: (_type: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
    addListener: (fn: () => void) => { listeners.add(fn); },
    removeListener: (fn: () => void) => { listeners.delete(fn); },
    dispatchEvent: () => false,
  }),
});
(globalThis as { __setViewportWidth?: (w: number) => void }).__setViewportWidth = (width: number) => {
  viewport.width = width;
  for (const fn of [...listeners]) fn();
};

// jsdom has no layout, so no Element.scrollIntoView (every browser has it): a no-op; tests may replace it to observe calls.
if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = function scrollIntoView() { /* no layout */ };

afterEach(() => {
  cleanup();
  viewport.width = 1440;
  try { window.localStorage.clear(); } catch { /* storage may be stubbed by a test */ }
  document.documentElement.removeAttribute('data-theme');
  resetThemeForTests();
});
