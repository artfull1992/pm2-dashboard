import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Labels of the compact navigation rail (601–1279 px, design reference 1.0 APP-15) as a floating overlay. The rail is
// its own scroll container (a full admin menu does not fit a short window), so a CSS ::after tooltip would be clipped
// by it; this one is rendered into <body> (portal, position: fixed — the same approach as ActionMenu) next to the
// hovered or keyboard-focused control, kept inside the viewport and never over the control itself. It is decorative
// (aria-hidden): every control already carries the same text as its accessible name. Listeners live only while
// `active`; the tooltip goes away when the pointer leaves, on blur and on resize. When the rail scrolls (also when the
// browser scrolls a focused control into view) it follows its control, and goes away once the control leaves the
// rail's visible area.

const GAP = 10;
const MARGIN = 8;

export function RailTooltip({ container, active }: { container: RefObject<HTMLElement | null>; active: boolean }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [tick, setTick] = useState(0);
  const tip = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);
  useEffect(() => { current.current = target; }, [target]);

  useEffect(() => {
    const root = container.current;
    if (!active || !root) return undefined;
    const tipped = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null);
    const onOver = (event: PointerEvent) => { const el = tipped(event.target); if (el && root.contains(el)) setTarget(el); };
    const onOut = (event: PointerEvent) => { if (!tipped(event.relatedTarget)) setTarget(null); };
    // Keyboard focus only (a mouse click also focuses; :focus-visible tells them apart).
    const onFocus = (event: FocusEvent) => { const el = tipped(event.target); if (el?.matches(':focus-visible')) setTarget(el); };
    const onBlur = () => { setTarget(null); };
    const hide = () => { setTarget(null); };
    const onScroll = () => {
      const el = current.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const v = root.getBoundingClientRect();
      if (r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5) setTick((n) => n + 1); // still visible: follow it
      else setTarget(null);
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('focusout', onBlur);
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', hide);
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', onBlur);
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', hide);
      setTarget(null);
    };
  }, [active, container]);

  // Beside the control (right of the rail; left when there is no room), vertically centred, clamped into the viewport.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !target) return;
    const r = target.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const right = r.right + GAP;
    const left = right + width + MARGIN <= vw ? right : Math.max(MARGIN, r.left - GAP - width);
    const top = Math.min(Math.max(r.top + r.height / 2 - height / 2, MARGIN), window.innerHeight - height - MARGIN);
    el.style.left = `${String(Math.round(left))}px`;
    el.style.top = `${String(Math.round(top))}px`;
  }, [target, tick]);

  if (!active || !target) return null;
  return createPortal(<div ref={tip} className="rail-tip" aria-hidden="true">{target.dataset.tip}</div>, document.body);
}
