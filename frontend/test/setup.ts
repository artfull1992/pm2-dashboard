import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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

afterEach(() => {
  cleanup();
  viewport.width = 1440;
});
