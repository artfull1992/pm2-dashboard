import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { RequireAuth, RequirePermission } from './auth/guards';
import { Layout } from './components/Layout';
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

/** Remounts the private area per session, so no component state of one session survives into another. */
function PrivateArea() {
  const { state } = useAuth();
  const key = state.status === 'authenticated' ? `${state.session.user.id}:${state.session.expiresAt}` : 'none';
  return (
    <RequireAuth>
      <Layout key={key} />
    </RequireAuth>
  );
}

export function AppRoutes() {
  return (
    <Routes>
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
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
