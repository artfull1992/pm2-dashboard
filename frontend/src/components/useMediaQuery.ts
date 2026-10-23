import { useSyncExternalStore } from 'react';

// Live result of a CSS media query (layout decisions that CSS alone cannot make, e.g. split view vs separate views).
// Without matchMedia (non-browser environments) the query counts as not matching.

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => { list.removeEventListener('change', onChange); };
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/** Applications: list and details side by side from this width; below it they are separate views. */
export const SPLIT_VIEW_QUERY = '(min-width: 1280px)';
