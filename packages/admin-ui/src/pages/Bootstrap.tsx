import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api';
import { useAuth } from '../context/AuthContext';
import { Alert } from '../components/ui';
import type { ToastPush } from './toast';

/**
 * First-run admin creation. Shown when the management API is fresh and no
 * administrator exists yet (call POST /api/auth/bootstrap).
 */
export function Bootstrap({ push }: { push: ToastPush }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await authApi.bootstrap(username, password, displayName || username);
      await refresh();
      push('Administrator account created', 'success');
      navigate('/accounts', { replace: true });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Failed to create admin';
      if (/already|exists|taken/i.test(msg)) {
        setError('An administrator account already exists. Please sign in on the login screen.');
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="card w-full max-w-md p-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Create Administrator</h1>
          <p className="mt-1 text-sm text-slate-500">
            No user accounts exist yet. Create the first administrator to secure this instance.
          </p>
        </div>

        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="b-username">Username</label>
            <input
              id="b-username"
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="b-display">Display name</label>
            <input
              id="b-display"
              className="input"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Admin"
            />
          </div>
          <div>
            <label className="label" htmlFor="b-password">Password</label>
            <input
              id="b-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            <p className="mt-1 text-xs text-slate-400">At least 8 characters.</p>
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create admin'}
          </button>
        </form>

        <button
          onClick={() => navigate('/login')}
          className="mt-4 w-full text-center text-sm text-slate-500 hover:text-slate-700"
        >
          Already have an account? Sign in
        </button>
      </div>
    </div>
  );
}