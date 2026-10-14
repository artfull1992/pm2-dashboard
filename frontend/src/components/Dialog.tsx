import { type ReactNode, useEffect, useId, useRef } from 'react';

// Accessible modal (no native <dialog> dependency): role=dialog, aria-modal, labelled, focus moved inside on open
// and restored on close, Escape closes, Tab stays inside.

export function Dialog({ title, children, onClose, actions, className }: { title: string; children: ReactNode; onClose: () => void; actions: ReactNode; className?: string }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])') ?? []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);

  return (
    <div className="dialog-backdrop">
      <div className={`dialog ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel}>
        <h2 id={titleId} className="dialog__title">{title}</h2>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
