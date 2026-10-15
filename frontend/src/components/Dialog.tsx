import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Accessible modal (no native <dialog> dependency): role=dialog, aria-modal, labelled; rendered into <body> while the
// application root (#root) is `inert`, so the background is neither clickable nor focusable nor read by assistive
// technology. Focus moves inside on open and returns to the previously focused element on close; Tab stays inside.
// Escape closes only when `dismissible` (callers pass false while a request is pending). Opening or closing a dialog
// never sends anything.

let openDialogs = 0;
const appRoot = () => document.getElementById('root');

export function Dialog({ title, children, onClose, actions, className, dismissible = true }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  className?: string;
  dismissible?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Latest props for the key handler without re-running the mount effect (that would move focus again).
  const latest = useRef({ onClose, dismissible });
  useEffect(() => { latest.current = { onClose, dismissible }; });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialogs += 1;
    appRoot()?.setAttribute('inert', '');
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? [])
      .filter((el) => !el.closest('[hidden]'))
      // Document order, independent of how the selector list is evaluated.
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (latest.current.dismissible) latest.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openDialogs -= 1;
      if (openDialogs === 0) appRoot()?.removeAttribute('inert');
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="dialog-backdrop">
      <div className={`dialog ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel}>
        <h2 id={titleId} className="dialog__title">{title}</h2>
        <div className="dialog__body">{children}</div>
        {actions ? <div className="dialog__actions">{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Create/edit form in a dialog. The form is labelled by the dialog title. While `pending` nothing closes it.
 * Closing with unsaved input (`dirty`) first asks to discard — input is never lost silently. The form stays
 * mounted during that question, so "back" returns to exactly what was typed.
 */
export function FormDialog({ title, submitLabel, pendingLabel, pending, dirty, onSubmit, onClose, children }: {
  title: string;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  dirty: boolean;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [discard, setDiscard] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const request = useCallback(() => {
    if (pending) return;
    if (dirty) { setDiscard(true); return; }
    onClose();
  }, [pending, dirty, onClose]);
  useEffect(() => { if (discard) backRef.current?.focus(); }, [discard]);

  return (
    <Dialog title={title} onClose={request} dismissible={!pending}>
      <form className="form-grid" aria-label={title} noValidate onSubmit={onSubmit}>
        <div className="form-grid" hidden={discard ? true : undefined}>{children}</div>
        {discard ? (
          <>
            <p className="notice notice--warning" role="alert">Введені дані не збережено. Закрити форму й втратити їх?</p>
            <div className="form-actions">
              <button ref={backRef} type="button" className="button" onClick={() => { setDiscard(false); }}>Повернутися до форми</button>
              <button type="button" className="button button--danger" onClick={onClose}>Закрити без збереження</button>
            </div>
          </>
        ) : (
          <div className="form-actions">
            <button type="button" className="button" onClick={request} disabled={pending}>Скасувати</button>
            <button type="submit" className="button button--primary" disabled={pending}>{pending ? pendingLabel : submitLabel}</button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
