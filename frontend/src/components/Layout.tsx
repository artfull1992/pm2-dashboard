import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import type { Permission, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Icon, type IconName } from './icons';
import { RailTooltip } from './RailTooltip';
import { RAIL_QUERY, useMediaQuery } from './useMediaQuery';

export const ROLE_LABELS: Record<Role, string> = { admin: 'Адміністратор', operator: 'Оператор', viewer: 'Спостерігач' };

interface NavItem { to: string; label: string; icon: IconName; permission?: Permission }
interface NavGroup { title: string; items: readonly NavItem[] }

// Sections a user may not open are not shown; a group without visible items is not shown either. The API enforces
// every permission independently — hiding is only about not offering what would be refused.
//
// Widths (design reference 1.0, APP-15): ≥ 1280 px a 184 px column with icons and labels; 601–1279 px a compact
// 68 px rail with icons only — every link keeps its text as the accessible name and shows it as a tooltip on hover and
// keyboard focus (RailTooltip, an overlay outside the rail's own scroll: a full menu scrolls in a short window instead of
// losing its last links, the account link or «Вийти»); ≤ 600 px a top bar with the «Меню» button.
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: 'Моніторинг',
    items: [
      { to: '/', label: 'Огляд', icon: 'overview' },
      { to: '/servers', label: 'Сервери', icon: 'servers', permission: 'monitoring:read' },
      { to: '/applications', label: 'Застосунки', icon: 'applications', permission: 'monitoring:read' },
      { to: '/alerts', label: 'Сповіщення', icon: 'alerts', permission: 'monitoring:read' },
    ],
  },
  {
    title: 'Адміністрування',
    items: [
      { to: '/users', label: 'Користувачі', icon: 'users', permission: 'users:manage' },
      { to: '/audit', label: 'Журнал аудиту', icon: 'audit', permission: 'audit:read' },
      { to: '/settings', label: 'Налаштування', icon: 'settings', permission: 'alerts:manage' },
    ],
  },
];

export function Layout() {
  const { state, can, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const navId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const rail = useMediaQuery(RAIL_QUERY);

  // Mobile menu: Escape closes it and returns focus to the toggle. A closed menu is display:none, so none of its
  // links stay in the Tab order.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); toggle.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  if (state.status !== 'authenticated') return null;
  const { user } = state.session;
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((item) => item.permission === undefined || can(item.permission)) }))
    .filter((g) => g.items.length > 0);

  const onLogout = async () => {
    setLogoutState('pending');
    const { ok } = await logout();
    if (!ok) setLogoutState('failed');
  };
  const close = () => { setMenuOpen(false); };

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Перейти до вмісту</a>
      <header className="topbar">
        <span className="brand">Node Control</span>
        <button ref={toggle} type="button" className="button button--ghost menu-toggle" aria-expanded={menuOpen} aria-controls={navId}
          onClick={() => { setMenuOpen((open) => !open); }}>
          Меню
        </button>
      </header>
      <aside ref={sidebar} id={navId} className={`sidebar${menuOpen ? ' sidebar--open' : ''}`}>
        <div className="sidebar__brand brand"><span className="brand__full">Node Control</span><abbr className="brand__short" title="Node Control">NC</abbr></div>
        <nav aria-label="Основна навігація">
          {groups.map((group, index) => (
            <div key={group.title} className="nav-group">
              <p className="nav-group__title" id={`${navId}-g${String(index)}`}>{group.title}</p>
              <ul className="nav" aria-labelledby={`${navId}-g${String(index)}`}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.to === '/'} onClick={close}
                      className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`} data-tip={item.label}>
                      <Icon name={item.icon} />
                      <span className="nav__label">{item.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="profile" role="group" aria-label="Обліковий запис користувача">
          <p className="profile__email" title={user.email}>{user.email}</p>
          <p className="profile__role">{ROLE_LABELS[user.role]}</p>
          <div className="profile__actions">
            <NavLink to="/account" onClick={close} className={({ isActive }) => `profile__link${isActive ? ' nav__link--active' : ''}`} data-tip="Обліковий запис">
              <Icon name="account" /><span className="nav__label">Обліковий запис</span>
            </NavLink>
            <button type="button" className="button button--small profile__logout" onClick={() => { void onLogout(); }} disabled={logoutState === 'pending'}
              data-tip={logoutState === 'pending' ? 'Вихід…' : 'Вийти'}>
              <Icon name="logout" /><span className="nav__label">{logoutState === 'pending' ? 'Вихід…' : 'Вийти'}</span>
            </button>
          </div>
          {logoutState === 'failed' ? <p className="account__error" role="alert">Не вдалося вийти: сервіс недоступний. Спробуйте ще раз.</p> : null}
        </div>
      </aside>
      <RailTooltip container={sidebar} active={rail} />
      <main className="content" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
