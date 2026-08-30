import { useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastContainer, type ToastMsg, type ToastTone } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Bootstrap } from './pages/Bootstrap';
import { Accounts } from './pages/Accounts';
import { Users } from './pages/Users';
import { Settings } from './pages/Settings';

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = (text: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  return { toasts, push, dismiss };
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (user.role !== 'admin') return <Navigate to="/accounts" replace />;
  return children;
}

function Gate({ children }: { children: JSX.Element }) {
  // Determine whether this instance needs first-run bootstrap. If unauthenticated
  // on a fresh install, auth/me returns 401; the login page then checks whether
  // an admin exists (bootstrap available) versus needs the bootstrap screen.
  return children;
}

function Router() {
  const { toasts, push, dismiss } = useToasts();

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login push={push} />} />
        <Route path="/bootstrap" element={<Bootstrap push={push} />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <Routes>
                  <Route path="accounts" element={<Accounts push={push} />} />
                  <Route path="accounts/:id" element={<Accounts push={push} />} />
                  <Route
                    path="users"
                    element={
                      <RequireAdmin>
                        <Users push={push} />
                      </RequireAdmin>
                    }
                  />
                  <Route path="settings" element={<Settings push={push} />} />
                  <Route path="*" element={<Navigate to="/accounts" replace />} />
                </Routes>
              </Layout>
            </RequireAuth>
          }
        />
      </Routes>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <Gate>
        <Router />
      </Gate>
    </AuthProvider>
  );
}

export default App;