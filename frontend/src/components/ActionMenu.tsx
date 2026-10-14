import { useEffect, useId, useRef, useState } from 'react';

// Row "Дії" menu shared by the service table and the user table: a disclosure button with a group of actions;
// Escape / outside click / focus leaving closes it, focus returns to the trigger.

export interface MenuItem { key: string; label: string; danger?: boolean; disabled: boolean; onSelect: () => void }

export function ActionMenu({ name, items }: { name: string; items: MenuItem[] }) {
  // The trigger is usable as long as at least one item is; each item carries its own availability.
  const disabled = items.every((i) => i.disabled);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return (
    <div className="action-menu" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} type="button" className="button action-menu__trigger" disabled={disabled}
        aria-label={`Дії: ${name}`} aria-expanded={open && !disabled} aria-controls={id}
        onClick={() => { setOpen(!open); }}>Дії <span aria-hidden="true">⌄</span></button>
      {open && !disabled ? <div id={id} className="action-menu__list" role="group" aria-label={`Дії для ${name}`}>
        {items.map((item) => <button key={item.key} type="button" disabled={item.disabled}
          className={`action-menu__item ${item.danger ? 'action-menu__item--danger' : ''}`}
          onClick={() => { trigger.current?.focus(); setOpen(false); item.onSelect(); }}>{item.label}</button>)}
      </div> : null}
    </div>
  );
}

