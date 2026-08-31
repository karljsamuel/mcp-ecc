import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { settingsApi } from '../api';
import { Alert, CopyButton, Spinner } from '../components/ui';
import type { ToastPush } from './toast';

type SettingsData = {
  id?: string;
  username?: string;
  displayName?: string;
  role?: string;
  mcpApiKey?: string;
};

export function Settings({ push }: { push: ToastPush }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = typeof window !== 'undefined' ? `${window.location.origin}/mcp` : '/mcp';

  const [displayName, setDisplayName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [rotating, setRotating] = useState(false);

  // Change password modal state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await settingsApi.me();
      const settings = res.settings;
      const mcpApiKey = res.mcpApiKey ?? settings?.mcpApiKey;
      setData({ ...settings, mcpApiKey });
      setDisplayName(settings.displayName ?? '');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSavingProfile(true);
    try {
      const { settings } = await settingsApi.update({ displayName });
      setData((prev) => ({ ...prev, ...settings }));
      push('Profile updated', 'success');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    setChangingPassword(true);
    try {
      await settingsApi.update({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordModal(false);
      push('Password changed successfully', 'success');
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setChangingPassword(false);
    }
  };

  const rotate = async () => {
    setError(null);
    setRotating(true);
    try {
      const res = await settingsApi.rotateApiKey();
      const key = res.mcpApiKey ?? res.settings?.mcpApiKey;
      setData((prev) => ({ ...prev, ...res.settings, mcpApiKey: key }));
      push('MCP API key rotated', 'success');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRotating(false);
    }
  };

  if (!data) {
    return error ? (
      <div className="mx-auto max-w-2xl">
        <Alert tone="error">{error}</Alert>
      </div>
    ) : (
      <Spinner label="Loading settings…" />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">Manage your profile and MCP API credentials</p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {/* Profile */}
      <div className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Profile</h2>
          <button
            type="button"
            onClick={() => {
              setPasswordError(null);
              setCurrentPassword('');
              setNewPassword('');
              setConfirmPassword('');
              setShowPasswordModal(true);
            }}
            className="btn-secondary text-xs"
          >
            Change password
          </button>
        </div>
        <form onSubmit={saveProfile} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input className="input bg-slate-50 text-slate-500" value={data.username ?? ''} disabled readOnly />
          </div>
          <div>
            <label className="label">Display name</label>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={savingProfile} className="btn-primary">
              {savingProfile ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>

      {/* Change Password Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-bold text-slate-900">Change Password</h3>
            {passwordError && <div className="mb-4"><Alert tone="error">{passwordError}</Alert></div>}
            <form onSubmit={changePassword} className="space-y-4">
              <div>
                <label className="label">Current password</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="label">New password</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>
              <div>
                <label className="label">Confirm new password</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="btn-secondary"
                  disabled={changingPassword}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={changingPassword}>
                  {changingPassword ? 'Updating…' : 'Update password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MCP API key + connection */}
      <div className="card p-6">
        <h2 className="mb-1 text-base font-semibold text-slate-900">MCP connection</h2>
        <p className="mb-4 text-sm text-slate-500">
          Connect an AI agent to your mcp-ecc server using your personal API key. The key is scoped to <em>your</em> accounts only.
        </p>

        {data.mcpApiKey ? (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <code className="flex-1 truncate font-mono text-sm text-slate-700">{data.mcpApiKey}</code>
            <CopyButton value={data.mcpApiKey} />
          </div>
        ) : (
          <p className="mb-4 text-sm text-slate-400">This account has no MCP API key yet.</p>
        )}

        <div className="space-y-4">
          <div>
            <div className="label">Endpoint</div>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <code className="flex-1 truncate font-mono text-sm text-slate-700">{endpoint}</code>
              <CopyButton value={endpoint} />
            </div>
          </div>

          <div>
            <div className="label">Client configuration</div>
            <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-900 p-3 font-mono text-xs leading-relaxed text-emerald-300">
{`{
  "mcpServers": {
    "mcp-ecc": {
      "type": "http",
      "url": ${JSON.stringify(endpoint)},
      "headers": {
        "Authorization": "Bearer ${data.mcpApiKey ?? '<your-api-key>'}"
      }
    }
  }
}`}
            </pre>
          </div>

          <div className="text-sm text-slate-600">
            For a guided, agent-readable setup, see the{' '}
            <a href="/setup/skill.md" target="_blank" rel="noreferrer" className="font-medium text-indigo-600 hover:text-indigo-700">
              SKILL.md runbook
            </a>{' '}
            ({' '}
            <a href="/setup/llms.txt" target="_blank" rel="noreferrer" className="text-slate-500 hover:text-indigo-600">
              llms.txt
            </a>
            ).
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button onClick={() => void rotate()} disabled={rotating} className="btn-secondary">
            {rotating ? 'Rotating…' : 'Regenerate key'}
          </button>
        </div>
      </div>
    </div>
  );
}