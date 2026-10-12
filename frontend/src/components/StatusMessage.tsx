import type { ReactNode } from 'react';

export function formatRetry(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  if (seconds < 60) return ` Спробуйте через ${String(seconds)} с.`;
  return ` Спробуйте через ${String(Math.ceil(seconds / 60))} хв.`;
}

export function LoadingState({ label = 'Завантаження…' }: { label?: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      <h2 className="state__title">{title}</h2>
      {children ? <p className="state__text">{children}</p> : null}
    </div>
  );
}

export function ErrorState({ title, children, onRetry }: { title: string; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{title}</h2>
      {children ? <p className="state__text">{children}</p> : null}
      {onRetry ? <button type="button" className="button" onClick={onRetry}>Спробувати ще раз</button> : null}
    </div>
  );
}
