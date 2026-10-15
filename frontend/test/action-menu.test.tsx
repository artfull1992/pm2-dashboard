import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ActionMenu, type MenuItem } from '../src/components/ActionMenu';

// Floating row menu (menu button pattern): overlay outside the table, keyboard semantics, one open menu.

const item = (key: string, over: Partial<MenuItem> = {}): MenuItem => ({ key, label: key, disabled: false, onSelect: vi.fn(), ...over });

function Table({ items, rows = ['one', 'two'], note }: { items: MenuItem[]; rows?: string[]; note?: string }) {
  return (
    <>
      <div className="table-wrap" data-testid="wrap" style={{ overflow: 'auto' }}>
        <table><tbody>
          {rows.map((r) => <tr key={r}><th>{r}</th><td><ActionMenu name={r} items={items} note={note} /></td><td><button type="button">after {r}</button></td></tr>)}
        </tbody></table>
      </div>
      <button type="button">outside</button>
    </>
  );
}

const trigger = (name = 'one') => screen.getByRole('button', { name: `Дії: ${name}` });

describe('ActionMenu', () => {
  it('renders the menu as an overlay in <body>, outside the table; aria wiring of trigger and menu', async () => {
    const user = userEvent.setup();
    render(<Table items={[item('a'), item('b')]} note="Пояснення" />);
    const t = trigger();
    expect(t.getAttribute('aria-haspopup')).toBe('menu');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-controls')).toBeNull();
    await user.click(t);
    const menu = screen.getByRole('menu', { name: 'Дії для one' });
    expect(screen.getByTestId('wrap').contains(menu)).toBe(false);
    const popup = document.getElementById(t.getAttribute('aria-controls') ?? '');
    expect(popup?.parentElement).toBe(document.body);
    expect(popup?.contains(menu)).toBe(true);
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(menu.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Пояснення');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['a', 'b']);
  });

  it('keyboard: Enter opens on the first item; arrows wrap; Home/End; Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    render(<Table items={[item('a'), item('b'), item('c')]} />);
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement?.textContent).toBe('a');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('b');
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('c');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('a');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('c');
    await user.keyboard('{Home}');
    expect(document.activeElement?.textContent).toBe('a');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('c');
    await user.keyboard('{Escape}');
    await user.keyboard(' ');
    expect(document.activeElement?.textContent).toBe('a');
  });

  it('Tab closes the menu and moves on from the trigger; Shift+Tab returns to the trigger', async () => {
    const user = userEvent.setup();
    render(<Table items={[item('a')]} />);
    await user.click(trigger());
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement?.textContent).toBe('after one');
    await user.click(trigger());
    await user.tab({ shift: true });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('choosing an item closes the menu, focuses the trigger, then runs the item; disabled items are focusable but inert', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const run = item('run', { onSelect: () => { order.push(document.activeElement === trigger() ? 'trigger-focused' : 'elsewhere'); } });
    const off = item('off', { disabled: true });
    render(<Table items={[off, run]} />);
    await user.click(trigger());
    expect(document.activeElement?.textContent).toBe('run'); // the first usable item
    const disabled = screen.getByRole('menuitem', { name: 'off' });
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(disabled);
    await user.keyboard('{Enter}');
    expect(off.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'run' }));
    expect(order).toEqual(['trigger-focused']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('second trigger click and an outside click close it; only one menu is open at a time', async () => {
    const user = userEvent.setup();
    render(<Table items={[item('a')]} />);
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(trigger('one'));
    trigger('two').focus();
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('Дії для two');
    expect(trigger('one').getAttribute('aria-expanded')).toBe('false');
  });

  it('a re-render with the same items (polling) keeps it open and keeps focus; a removed row leaves no overlay', async () => {
    const user = userEvent.setup();
    const set: { rows: (rows: string[]) => void; items: (items: MenuItem[]) => void } = { rows: () => undefined, items: () => undefined };
    function Live() {
      const [rows, r] = useState(['one', 'two']);
      const [items, i] = useState([item('a'), item('b')]);
      useEffect(() => { set.rows = r; set.items = i; }, [r, i]);
      return <Table items={items} rows={rows} />;
    }
    render(<Live />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}');
    const focused = document.activeElement;
    act(() => { set.items([item('a'), item('b')]); });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(focused);
    act(() => { set.items([item('a', { disabled: true }), item('b', { disabled: true })]); });
    expect(screen.queryByRole('menu')).toBeNull(); // nothing usable any more: the menu closes
    act(() => { set.items([item('a'), item('b')]); });
    await user.click(trigger());
    act(() => { set.rows(['two']); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('.action-menu__popup')).toBeNull();
  });

  it('lazy menu: shows loading, then focuses the first item once loaded; onOpen runs on every opening', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const lazy: { finish: () => void } = { finish: () => undefined };
    function Lazy() {
      const [items, setItems] = useState<MenuItem[] | null>(null);
      useEffect(() => { lazy.finish = () => { setItems([item('x'), item('y')]); }; }, []);
      return <ActionMenu name="lazy" items={items ?? []} loading={items === null} onOpen={onOpen} />;
    }
    render(<Lazy />);
    expect(trigger('lazy')).toHaveProperty('disabled', false);
    await user.click(trigger('lazy'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Завантаження…');
    act(() => { lazy.finish(); });
    expect(document.activeElement?.textContent).toBe('x');
    await user.keyboard('{Escape}');
    await user.click(trigger('lazy'));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('places the overlay inside the viewport: below the trigger, upwards near the bottom edge, clamped at the right edge', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 400 });
    const rect = (top: number, left: number) => vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { top, bottom: top + 32, left, right: left + 60, width: 60, height: 32, x: left, y: top, toJSON: () => ({}) });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180);
    try {
      render(<Table items={[item('a')]} rows={['one']} />);
      rect(100, 300);
      await user.click(trigger());
      let popup = document.querySelector<HTMLElement>('.action-menu__popup');
      expect(popup?.dataset.placement).toBe('bottom');
      expect(popup?.style.top).toBe('136px');
      expect(popup?.style.left).toBe('180px'); // right-aligned with the trigger
      await user.keyboard('{Escape}');
      rect(540, 360);
      await user.click(trigger());
      popup = document.querySelector<HTMLElement>('.action-menu__popup');
      expect(popup?.dataset.placement).toBe('top');
      expect(popup?.style.top).toBe('416px');
      expect(Number.parseInt(popup?.style.left ?? '0', 10) + 180).toBeLessThanOrEqual(400 - 8);
      await user.keyboard('{Escape}');
      rect(700, 300); // the trigger scrolled out of view: the menu does not open detached from it
      await user.click(trigger());
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
