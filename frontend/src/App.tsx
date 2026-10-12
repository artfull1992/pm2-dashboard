import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { RequireAuth, RequirePermission } from './auth/guards';
import { Layout } from './components/Layout';
import { AuditPage } from './pages/AuditPage';
import { LoginPage } from './pages/LoginPage';
import { ApplicationsPage, DashboardPage, NotFoundPage, ServersPage } from './pages/SimplePages';

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
        <Route path="applications" element={<RequirePermission permission="monitoring:read"><ApplicationsPage /></RequirePermission>} />
        <Route path="audit" element={<RequirePermission permission="audit:read"><AuditPage /></RequirePermission>} />
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
