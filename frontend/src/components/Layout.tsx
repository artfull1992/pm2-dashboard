import { useId, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import type { Permission, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export const ROLE_LABELS: Record<Role, string> = { admin: 'Адміністратор', operator: 'Оператор', viewer: 'Спостерігач' };

interface NavItem { to: string; label: string; permission?: Permission }

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Огляд' },
  { to: '/servers', label: 'Сервери', permission: 'monitoring:read' },
  { to: '/applications', label: 'Застосунки', permission: 'monitoring:read' },
  { to: '/audit', label: 'Журнал аудиту', permission: 'audit:read' },
  { to: '/users', label: 'Користувачі', permission: 'users:manage' },
  { to: '/account', label: 'Обліковий запис' },
];

export function Layout() {
  const { state, can, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const navId = useId();

  if (state.status !== 'authenticated') return null;
  const { user } = state.session;
  const items = NAV_ITEMS.filter((item) => item.permission === undefined || can(item.permission));

  const onLogout = async () => {
    setLogoutState('pending');
    const { ok } = await logout();
    if (!ok) setLogoutState('failed');
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Перейти до вмісту</a>
      <header className="topbar">
        <span className="brand">GOIT Node Control</span>
        <button
          type="button"
          className="button button--ghost menu-toggle"
          aria-expanded={menuOpen}
          aria-controls={navId}
          onClick={() => { setMenuOpen((open) => !open); }}
        >
          Меню
        </button>
      </header>
      <aside className={`sidebar${menuOpen ? ' sidebar--open' : ''}`}>
        <nav id={navId} aria-label="Основна навігація">
          <ul className="nav">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
                  onClick={() => { setMenuOpen(false); }}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="account" aria-label="Обліковий запис">
          <p className="account__email">{user.email}</p>
          <p className="account__role">{ROLE_LABELS[user.role]}</p>
          <button type="button" className="button button--secondary" onClick={() => { void onLogout(); }} disabled={logoutState === 'pending'}>
            {logoutState === 'pending' ? 'Вихід…' : 'Вийти'}
          </button>
          {logoutState === 'failed' ? <p className="account__error" role="alert">Не вдалося вийти: сервіс недоступний. Спробуйте ще раз.</p> : null}
        </div>
      </aside>
      <main className="content" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
