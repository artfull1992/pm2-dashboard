import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Row "Дії" menu shared by the service tables and the user table (menu button pattern, WAI-ARIA APG).
//
// The list is a floating overlay rendered into <body> (portal, position: fixed) next to its trigger: it never changes
// the row height, the table width or the scroll container, and no overflow clips it. It opens downwards, or upwards
// when there is more room above; its height is limited to the visible space (inner scroll). Scroll/resize re-place it;
// when the trigger leaves the viewport (or disappears) the menu closes. One menu is open at a time.
//
// Keyboard: Enter/Space/ArrowDown open on the first item, ArrowUp on the last; ArrowUp/ArrowDown/Home/End move
// between items; Escape closes and returns focus to the trigger; Tab closes and moves on from the trigger. Disabled
// items stay focusable (aria-disabled) but do nothing. Choosing an item closes the menu, focuses the trigger and only
// then runs the item (a dialog opened by it returns focus to the trigger). Opening a menu never sends anything.

export interface MenuItem { key: string; label: string; danger?: boolean; disabled: boolean; onSelect: () => void }

const GAP = 4;
const MARGIN = 8;
let closeOpenMenu: (() => void) | null = null;

export function ActionMenu({ name, items, note, loading = false, onOpen, disabled, label = 'Дії', ariaLabel, subtle = false, iconOnly = false }: {
  name: string;
  /** Visible trigger text (default "Дії"); e.g. "Недоступно" for a row whose menu only explains why. */
  label?: string;
  /** Accessible name of the trigger (default `Дії: <name>`). */
  ariaLabel?: string;
  /** Secondary look for a trigger that only explains (no actions). */
  subtle?: boolean;
  /** A square icon trigger (e.g. «⋯»): `label` is the glyph, `ariaLabel` the name; no chevron. */
  iconOnly?: boolean;
  items: MenuItem[];
  /** Why items are missing or disabled — shown inside the menu. */
  note?: string | null | undefined;
  /** Items are still being loaded (lazy menus): the menu shows a loading line instead of an empty list. */
  loading?: boolean;
  /** Called on every opening (lazy menus load or revalidate their items here). */
  onOpen?: () => void;
  /** Explicit trigger state; by default the trigger is usable when at least one item is (or items are lazy). */
  disabled?: boolean;
}) {
  const triggerDisabled = disabled ?? (!onOpen && items.every((i) => i.disabled));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focusOnReady = useRef<'first' | 'last' | null>(null);
  const id = useId();
  const noteId = useId();
  const shown = open && !triggerDisabled;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const show = (focus: 'first' | 'last') => {
    closeOpenMenu?.();
    focusOnReady.current = focus;
    setOpen(true);
    onOpen?.();
  };

  // One menu at a time.
  useEffect(() => {
    if (!shown) return undefined;
    const mine = () => { setOpen(false); };
    closeOpenMenu = mine;
    return () => { if (closeOpenMenu === mine) closeOpenMenu = null; };
  }, [shown]);

  const menuItems = () => Array.from(popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Focus the first/last usable item once the items are there (lazy menus: after loading). Polling refreshes of an
  // open menu never move focus again.
  useEffect(() => {
    if (!shown || !focusOnReady.current || loading) return;
    const all = menuItems();
    const enabled = all.filter((el) => el.getAttribute('aria-disabled') !== 'true');
    const pool = enabled.length > 0 ? enabled : all;
    const target = focusOnReady.current === 'last' ? pool.at(-1) : pool[0];
    focusOnReady.current = null;
    (target ?? popup.current)?.focus();
  });

  // Placement next to the trigger, inside the viewport.
  useLayoutEffect(() => {
    if (!shown) return undefined;
    let frame = 0;
    const place = () => {
      const t = trigger.current;
      const p = popup.current;
      if (!t || !p) return;
      if (!t.isConnected) { setOpen(false); return; }
      const r = t.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { setOpen(false); return; }
      const natural = p.scrollHeight;
      const below = vh - r.bottom - GAP - MARGIN;
      const above = r.top - GAP - MARGIN;
      const up = natural > below && above > below;
      const height = Math.max(Math.min(natural, up ? above : below), 0);
      const width = p.offsetWidth;
      p.style.maxHeight = `${String(Math.floor(up ? above : below))}px`;
      p.style.top = `${String(Math.round(up ? r.top - GAP - height : r.bottom + GAP))}px`;
      p.style.left = `${String(Math.round(Math.min(Math.max(r.right - width, MARGIN), Math.max(vw - width - MARGIN, MARGIN))))}px`;
      p.dataset.placement = up ? 'top' : 'bottom';
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); };
  });

  // Outside click closes (focus stays where the user clicked).
  useEffect(() => {
    if (!shown) return undefined;
    const outside = (event: PointerEvent) => {
      const t = event.target;
      if (t instanceof Node && (popup.current?.contains(t) || trigger.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); };
  }, [shown]);

  const leaves = (next: EventTarget | null) => !(next instanceof Node) || !(popup.current?.contains(next) || trigger.current?.contains(next));

  const onMenuKey = (event: KeyboardEvent) => {
    const all = menuItems();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { event.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': if (all.length) move(index + 1); else event.preventDefault(); break;
      case 'ArrowUp': if (all.length) move(index < 0 ? -1 : index - 1); else event.preventDefault(); break;
      case 'Home': if (all.length) move(0); break;
      case 'End': if (all.length) move(-1); break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); break;
      // Tab leaves the menu from its trigger: forward to the next control, backward to the trigger itself.
      case 'Tab': if (event.shiftKey) event.preventDefault(); close(true); break;
      default: break;
    }
  };

  return (
    <div className="action-menu">
      <button ref={trigger} type="button" className={`button action-menu__trigger${subtle ? ' action-menu__trigger--subtle' : ''}${iconOnly ? ' icon-button action-menu__trigger--icon' : ''}`} disabled={triggerDisabled}
        aria-label={ariaLabel ?? `Дії: ${name}`} aria-haspopup="menu" aria-expanded={shown} aria-controls={shown ? id : undefined}
        onClick={() => { if (shown) close(false); else show('first'); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp' ? 'last' : 'first'); }
          else if (event.key === 'Escape' && shown) { event.preventDefault(); close(true); }
        }}
        onBlur={(event) => { if (shown && leaves(event.relatedTarget)) setOpen(false); }}>
        {iconOnly ? <span aria-hidden="true">{label}</span> : <>{label} <span aria-hidden="true">⌄</span></>}
      </button>
      {shown ? createPortal(
        <div ref={popup} id={id} className="action-menu__popup" tabIndex={-1} data-placement="bottom"
          onKeyDown={onMenuKey} onBlur={(event) => { if (leaves(event.relatedTarget)) setOpen(false); }}>
          {loading ? <p className="action-menu__note" role="status">Завантаження…</p> : null}
          {!loading && items.length > 0 ? (
            <div role="menu" aria-label={`Дії для ${name}`} aria-describedby={note ? noteId : undefined} className="action-menu__list">
              {items.map((item) => (
                <button key={item.key} type="button" role="menuitem" tabIndex={-1} aria-disabled={item.disabled || undefined}
                  className={`action-menu__item ${item.danger ? 'action-menu__item--danger' : ''}`}
                  onClick={() => { if (item.disabled) return; close(true); item.onSelect(); }}>{item.label}</button>
              ))}
            </div>
          ) : null}
          {!loading && note ? <p id={noteId} className="action-menu__note">{note}</p> : null}
          {!loading && items.length === 0 && !note ? <p className="action-menu__note">Дій немає.</p> : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
