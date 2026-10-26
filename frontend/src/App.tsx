import { useState } from 'react';
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider, useRoutes } from 'react-router';
import { AuthProvider, sessionIdentity, useAuth } from './auth/AuthContext';
import { RequireAuth, RequirePermission } from './auth/guards';
import { Layout } from './components/Layout';
import { AccessRoute } from './pages/AccessPage';
import { AccountPage } from './pages/AccountPage';
import { AlertsPage } from './pages/AlertsPage';
import { AuditPage } from './pages/AuditPage';
import { LoginPage } from './pages/LoginPage';
import { ServerDetailPage } from './pages/ServerDetailPage';
import { ServersPage } from './pages/ServersPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { DashboardPage } from './pages/DashboardPage';
import { NotFoundPage } from './pages/SimplePages';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';

/**
 * Remounts the private area per session, so no component state of one session survives into another — also a new
 * session of the same user (the identity includes the per-session CSRF token; it is a React key, never rendered).
 */
function PrivateArea() {
  const { state } = useAuth();
  const key = state.status === 'authenticated' ? sessionIdentity(state.session) : 'none';
  return (
    <RequireAuth>
      <Layout key={key} />
    </RequireAuth>
  );
}

/**
 * The route tree. The application runs it in a data router (createBrowserRouter): the access page (ACL, ADR-035)
 * guards unsaved changes with useBlocker, which exists only there. `AppRoutes` renders the same tree in any router
 * (tests that drive a MemoryRouter directly).
 */
export const appRoutes = createRoutesFromElements(
  <>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<PrivateArea />}>
      <Route index element={<DashboardPage />} />
      <Route path="servers" element={<RequirePermission permission="monitoring:read"><ServersPage /></RequirePermission>} />
      <Route path="servers/:id" element={<RequirePermission permission="monitoring:read"><ServerDetailPage /></RequirePermission>} />
      <Route path="applications" element={<RequirePermission permission="monitoring:read"><ApplicationsPage /></RequirePermission>} />
      <Route path="alerts" element={<RequirePermission permission="monitoring:read"><AlertsPage /></RequirePermission>} />
      <Route path="settings" element={<Navigate to="/settings/integrations" replace />} />
      <Route path="settings/:tab" element={<RequirePermission permission="alerts:manage"><SettingsPage /></RequirePermission>} />
      <Route path="audit" element={<RequirePermission permission="audit:read"><AuditPage /></RequirePermission>} />
      <Route path="users" element={<RequirePermission permission="users:manage"><UsersPage /></RequirePermission>} />
      <Route path="users/:id/access" element={<RequirePermission permission="users:manage"><AccessRoute /></RequirePermission>} />
      <Route path="account" element={<AccountPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </>,
);

export function AppRoutes() {
  return useRoutes(appRoutes);
}

export function App() {
  // One router per mounted application (created on first render, not at import time).
  const [router] = useState(() => createBrowserRouter(appRoutes));
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
