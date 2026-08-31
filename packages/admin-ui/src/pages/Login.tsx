import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Alert } from '../components/ui';
import type { ToastPush } from './toast';

export function Login({ push }: { push: ToastPush }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login, refresh, needsBootstrap } = useAuth();
  const navigate = useNavigate();

  // A fresh install has no admin account: send the user to create one
  // instead of showing a blank login (which would be unusable).
  useEffect(() => {
    if (needsBootstrap) navigate('/bootstrap', { replace: true });
  }, [needsBootstrap, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      await refresh();
      push('Signed in successfully', 'success');
      navigate('/accounts', { replace: true });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Login failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="card w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white">
            Me
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">mcp-ecc Admin</h1>
            <p className="text-sm text-slate-500">Sign in to manage your accounts</p>
          </div>
        </div>

        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-slate-500">
          {needsBootstrap && (
            <span>
              No admin account found.{' '}
              <Link to="/bootstrap" className="font-medium text-indigo-600 hover:text-indigo-700">
                Create the first admin account
              </Link>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}