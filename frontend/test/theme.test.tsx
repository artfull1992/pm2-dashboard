import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetThemeForTests } from '../src/theme';
import { THEME_INIT } from './setup';
import { installFetch, json, renderApp, session } from './support';

// Theme preference (light / dark / system): one logic (public/theme-init.js, loaded before React exactly as in the
// browser), stored only in this browser, synchronised between tabs, safe with broken or missing storage, and a
// switcher for every role and on the login page.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const root = () => document.documentElement;
function backend(role: 'admin' | 'operator' | 'viewer' | null) {
  installFetch((req) => {
    if (req.url === '/api/auth/me') return role ? json(200, session(role)) : json(401, {});
    if (req.url.startsWith('/api/dashboard')) return json(503, {});
    return json(404, {});
  });
}
const trigger = () => screen.findByRole('button', { name: /^Тема оформлення: / });
async function choose(label: 'Світла' | 'Темна' | 'Як у системі') {
  const user = userEvent.setup();
  await user.click(await trigger());
  await user.click(await screen.findByRole('menuitemradio', { name: label }));
}
/** Runs the bootstrap again, as a reload of the page would. */
function reload() { window.eval(THEME_INIT); resetThemeForTests(); }

describe('theme bootstrap (before React)', () => {
  it('default is «Як у системі»: no data-theme, the OS decides', () => {
    reload();
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(window.ncTheme?.read()).toBe('system');
  });

  it('a stored explicit choice is applied synchronously, without React', () => {
    window.localStorage.setItem('nc-theme', 'dark');
    reload();
    expect(root().getAttribute('data-theme')).toBe('dark');
    window.localStorage.setItem('nc-theme', 'light');
    reload();
    expect(root().getAttribute('data-theme')).toBe('light');
  });

  it('an unknown stored value falls back to the system theme', () => {
    window.localStorage.setItem('nc-theme', '<script>');
    reload();
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(window.ncTheme?.read()).toBe('system');
  });

  it('unavailable storage: reading falls back to system, saving reports false and does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => { reload(); }).not.toThrow();
    expect(window.ncTheme?.read()).toBe('system');
    expect(window.ncTheme?.save('dark')).toBe(false);
  });
});

describe('theme switcher', () => {
  it.each(['admin', 'operator', 'viewer'] as const)('%s: available in the navigation; the choice applies, is stored and survives a reload', async (role) => {
    backend(role);
    renderApp('/');
    expect((await trigger()).getAttribute('aria-label')).toBe('Тема оформлення: Як у системі');
    await choose('Темна');
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('nc-theme')).toBe('dark');
    await waitFor(async () => { expect((await trigger()).getAttribute('aria-label')).toBe('Тема оформлення: Темна'); });
    reload();
    expect(root().getAttribute('data-theme')).toBe('dark');
    await choose('Як у системі');
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('nc-theme')).toBeNull();
  });

  it('login page: the same switcher before signing in', async () => {
    backend(null);
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: 'Node Control' })).toBeTruthy();
    await choose('Світла');
    expect(root().getAttribute('data-theme')).toBe('light');
  });

  it('the menu is a radio group: the current choice is checked', async () => {
    backend('viewer');
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await trigger());
    const menu = await screen.findByRole('menu', { name: 'Тема оформлення' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => [i.textContent, i.getAttribute('aria-checked')]))
      .toEqual([['Світла', 'false'], ['Темна', 'false'], ['Як у системі', 'true']]);
  });

  it('another tab changes the theme (storage event): this tab follows', async () => {
    backend('viewer');
    renderApp('/');
    await trigger();
    window.localStorage.setItem('nc-theme', 'light');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'nc-theme', newValue: 'light' })); });
    expect(root().getAttribute('data-theme')).toBe('light');
    expect((await trigger()).getAttribute('aria-label')).toBe('Тема оформлення: Світла');
    window.localStorage.removeItem('nc-theme');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'nc-theme', newValue: null })); });
    expect(root().hasAttribute('data-theme')).toBe(false);
  });

  it('without storage the choice still works in this tab', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    backend('viewer');
    renderApp('/');
    await choose('Темна');
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect((await trigger()).getAttribute('aria-label')).toBe('Тема оформлення: Темна');
  });
});
