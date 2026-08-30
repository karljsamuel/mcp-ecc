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

  const [displayName, setDisplayName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { settings } = await settingsApi.me();
      setData(settings);
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
      const patch: { displayName?: string; currentPassword?: string; newPassword?: string } = {
        displayName,
      };
      if (newPassword) {
        if (!currentPassword) {
          throw new Error('Current password is required to change your password.');
        }
        patch.currentPassword = currentPassword;
        patch.newPassword = newPassword;
      }
      const { settings } = await settingsApi.update(patch);
      setData((prev) => ({ ...prev, ...settings }));
      setCurrentPassword('');
      setNewPassword('');
      push('Settings saved', 'success');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const rotate = async () => {
    setError(null);
    setRotating(true);
    try {
      const res = await settingsApi.rotateApiKey();
      const key = res.mcpApiKey ?? res.settings?.mcpApiKey;
      if (key !== undefined) {
        setData((prev) => ({ ...prev, ...res.settings, mcpApiKey: key }));
      } else {
        setData((prev) => ({ ...prev, ...res.settings }));
      }
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
      <form onSubmit={saveProfile} className="card p-6">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Profile</h2>
        <div className="space-y-4">
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Current password</label>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Required to change password"
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
                placeholder="Leave blank to keep current"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={savingProfile} className="btn-primary">
              {savingProfile ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>

      {/* MCP API key */}
      <div className="card p-6">
        <h2 className="mb-1 text-base font-semibold text-slate-900">MCP API key</h2>
        <p className="mb-4 text-sm text-slate-500">
          Use this key when configuring the mcp-ecc MCP client. You can rotate it at any time.
        </p>
        {data.mcpApiKey ? (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <code className="flex-1 truncate font-mono text-sm text-slate-700">{data.mcpApiKey}</code>
            <CopyButton value={data.mcpApiKey} />
          </div>
        ) : (
          <p className="text-sm text-slate-400">This account has no MCP API key yet.</p>
        )}
        <div className="mt-4 flex justify-end">
          <button onClick={() => void rotate()} disabled={rotating} className="btn-secondary">
            {rotating ? 'Rotating…' : 'Regenerate key'}
          </button>
        </div>
      </div>
    </div>
  );
}