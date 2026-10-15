import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import type { Permission, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export const ROLE_LABELS: Record<Role, string> = { admin: 'Адміністратор', operator: 'Оператор', viewer: 'Спостерігач' };

interface NavItem { to: string; label: string; permission?: Permission }
interface NavGroup { title: string; items: readonly NavItem[] }

// Sections a user may not open are not shown; a group without visible items is not shown either. The API enforces
// every permission independently — hiding is only about not offering what would be refused.
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: 'Моніторинг',
    items: [
      { to: '/', label: 'Огляд' },
      { to: '/servers', label: 'Сервери', permission: 'monitoring:read' },
      { to: '/applications', label: 'Застосунки', permission: 'monitoring:read' },
      { to: '/alerts', label: 'Сповіщення', permission: 'monitoring:read' },
    ],
  },
  {
    title: 'Адміністрування',
    items: [
      { to: '/users', label: 'Користувачі', permission: 'users:manage' },
      { to: '/audit', label: 'Журнал аудиту', permission: 'audit:read' },
      { to: '/settings', label: 'Налаштування', permission: 'alerts:manage' },
    ],
  },
];

export function Layout() {
  const { state, can, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const navId = useId();
  const toggle = useRef<HTMLButtonElement>(null);

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
      <aside id={navId} className={`sidebar${menuOpen ? ' sidebar--open' : ''}`}>
        <div className="sidebar__brand brand">Node Control</div>
        <nav aria-label="Основна навігація">
          {groups.map((group, index) => (
            <div key={group.title} className="nav-group">
              <p className="nav-group__title" id={`${navId}-g${String(index)}`}>{group.title}</p>
              <ul className="nav" aria-labelledby={`${navId}-g${String(index)}`}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.to === '/'} onClick={close}
                      className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="profile" role="group" aria-label="Обліковий запис користувача">
          <p className="profile__email">{user.email}</p>
          <p className="profile__role">{ROLE_LABELS[user.role]}</p>
          <div className="profile__actions">
            <NavLink to="/account" onClick={close} className={({ isActive }) => `profile__link${isActive ? ' nav__link--active' : ''}`}>Обліковий запис</NavLink>
            <button type="button" className="button button--small" onClick={() => { void onLogout(); }} disabled={logoutState === 'pending'}>
              {logoutState === 'pending' ? 'Вихід…' : 'Вийти'}
            </button>
          </div>
          {logoutState === 'failed' ? <p className="account__error" role="alert">Не вдалося вийти: сервіс недоступний. Спробуйте ще раз.</p> : null}
        </div>
      </aside>
      <main className="content" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
