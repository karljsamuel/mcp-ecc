import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  accountsApi,
  infoApi,
  isAuthenticatedAccount,
  oauthClientsApi,
  PROVIDER_LABELS,
  STATUS_LABELS,
  type ServerInfo,
} from '../api';
import type { Account, AccountCreateInput, AccountStatus, OAuthClient, ProviderName } from '../types';
import {
  Alert,
  HealthBadge,
  Modal,
  ProviderBadge,
  Spinner,
} from '../components/ui';
import type { ToastPush } from './toast';

const PROVIDERS: ProviderName[] = ['google', 'microsoft', 'zoho', 'imap', 'caldav', 'carddav'];
const isOAuthProvider = (p: ProviderName) => ['google', 'microsoft', 'zoho'].includes(p);

function KeyIcon({ authenticated }: { authenticated: boolean }) {
  return (
    <svg
      className={`h-5 w-5 ${authenticated ? 'text-emerald-500' : 'text-red-400'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
      />
    </svg>
  );
}

export function Accounts({ push }: { push: ToastPush }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [oauthClients, setOauthClients] = useState<OAuthClient[]>([]);

  const load = useCallback(async () => {
    try {
      const [acc, clients] = await Promise.all([
        accountsApi.list(),
        oauthClientsApi.list().catch(() => ({ clients: [] as OAuthClient[] })),
      ]);
      setAccounts(acc.accounts);
      setOauthClients(clients.clients);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const editAccount = useMemo(
    () => accounts?.find((a) => a.id === editId) ?? null,
    [accounts, editId],
  );

  const handleCreated = () => {
    setCreating(false);
    void load();
  };

  const refreshAccount = async (id: string) => {
    try {
      const { account } = await accountsApi.get(id);
      setAccounts((prev) => prev?.map((a) => (a.id === id ? account : a)) ?? prev);
    } catch {
      await load();
    }
  };

  if (error && !accounts) {
    return (
      <div className="mx-auto max-w-2xl">
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Accounts</h1>
          <p className="text-sm text-slate-500">Email, calendar, and contacts accounts</p>
        </div>
        <button onClick={() => setCreating(true)} className="btn-primary">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add account
        </button>
      </div>

      {!accounts ? (
        <Spinner label="Loading accounts…" />
      ) : accounts.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-500">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
              />
            </svg>
          </div>
          <p className="font-medium text-slate-700">No accounts yet</p>
          <p className="mt-1 text-sm text-slate-500">Connect your first email account to get started.</p>
          <button onClick={() => setCreating(true)} className="btn-primary mt-4">
            Add account
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((acc) => {
            const authenticated = isAuthenticatedAccount(acc);
            return (
              <button
                key={acc.id}
                onClick={() => setEditId(acc.id)}
                className="card group p-5 text-left transition hover:border-indigo-300 hover:shadow-md"
              >
                <div className="mb-3 flex items-start justify-between">
                  <ProviderBadge provider={acc.provider} />
                  <KeyIcon authenticated={authenticated} />
                </div>
                <div className="truncate text-base font-semibold text-slate-900">
                  {acc.name || acc.email}
                </div>
                <div className="truncate text-sm text-slate-500">{acc.email || '\u00a0'}</div>
                <div className="mt-1 truncate font-mono text-xs text-slate-400">
                  slug: {acc.slug}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <HealthBadge health={acc.health ?? 'unknown'} />
                  <span className="text-xs font-medium text-indigo-600 opacity-0 transition group-hover:opacity-100">
                    Edit →
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <CreateAccountModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={handleCreated}
        push={push}
        oauthClients={oauthClients}
      />

      {editAccount && (
        <AccountDetailModal
          account={editAccount}
          oauthClients={oauthClients}
          onClose={() => setEditId(null)}
          onUpdated={() => void refreshAccount(editAccount.id)}
          onDeleted={() => {
            setEditId(null);
            void load();
          }}
          push={push}
        />
      )}
    </div>
  );
}

/* ------------------------------ create modal ------------------------- */

function CreateAccountModal({
  open,
  onClose,
  onCreated,
  push,
  oauthClients,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  push: ToastPush;
  oauthClients: OAuthClient[];
}) {
  const [provider, setProvider] = useState<ProviderName>('google');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OAuth credential selection/creation state
  const providerClients = useMemo(() => oauthClients.filter((c) => c.provider === provider), [oauthClients, provider]);
  // Default: use a saved client if one exists, else enter new credentials.
  const [useSavedClient, setUseSavedClient] = useState(true);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [accountsServer, setAccountsServer] = useState('');
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    infoApi.fetch().then(setServerInfo).catch(() => setServerInfo(null));
  }, []);

  // When the provider changes, if it has no saved clients, force "new credentials".
  useEffect(() => {
    if (providerClients.length === 0) setUseSavedClient(false);
    else setUseSavedClient(true);
    setSelectedClientId('');
  }, [provider, providerClients]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let payload: AccountCreateInput = { provider, name, slug, email };
      if (isOAuthProvider(provider)) {
        if (useSavedClient) {
          if (!selectedClientId) throw new Error('Select an OAuth client or switch to entering new credentials');
          payload.oauthClientId = selectedClientId;
        } else {
          if (!clientId.trim()) throw new Error('Client ID is required for a new OAuth client');
          payload.client = {
            label: label.trim() || `${name} client`,
            clientId: clientId.trim(),
            clientSecret: clientSecret.trim(),
            scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
            tenantId: tenantId.trim() || undefined,
            accountsServer: accountsServer.trim() || undefined,
          };
        }
      }
      await accountsApi.create(payload);
      push(`Account "${name || email}" created`, 'success');
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add account">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <div>
          <label className="label">Provider</label>
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as ProviderName)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work email" required />
        </div>
        <div>
          <label className="label">Slug</label>
          <input
            className="input"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="work"
            required
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </div>

        {isOAuthProvider(provider) && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-700">OAuth client</div>

            {serverInfo && (
              <div className="rounded bg-white px-3 py-2 text-xs text-slate-600">
                <span className="font-medium text-slate-700">Redirect URI:</span>{' '}
                <code className="break-all font-mono text-indigo-700">{serverInfo.oauthRedirectUri}</code>
                <div className="text-slate-500">
                  Register this URL in the provider&apos;s OAuth console (Google / Azure / Zoho).
                </div>
              </div>
            )}

            {providerClients.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  checked={useSavedClient}
                  onChange={() => setUseSavedClient(true)}
                  className="accent-indigo-600"
                />
                Use a saved client
              </label>
            )}
            {useSavedClient && providerClients.length > 0 ? (
              <select
                className="input"
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
              >
                <option value="">Select a client…</option>
                {providerClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.clientId})
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                {providerClients.length > 0 && (
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="radio"
                      checked={!useSavedClient}
                      onChange={() => setUseSavedClient(false)}
                      className="accent-indigo-600"
                    />
                    Enter new client credentials
                  </label>
                )}
                <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Client label (e.g. Personal)" />
                <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" required={!useSavedClient} />
                <input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret" />
                <input
                  className="input"
                  value={scopes}
                  onChange={(e) => setScopes(e.target.value)}
                  placeholder="Scopes (comma-separated, optional — defaults apply)"
                />
                {provider === 'microsoft' && (
                  <input className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="Tenant ID (optional)" />
                )}
                {provider === 'zoho' && (
                  <input
                    className="input"
                    value={accountsServer}
                    onChange={(e) => setAccountsServer(e.target.value)}
                    placeholder="Accounts server, e.g. accounts.zoho.eu (optional)"
                  />
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary">
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ detail modal -------------------------- */

function AccountDetailModal({
  account,
  oauthClients,
  onClose,
  onUpdated,
  onDeleted,
  push,
}: {
  account: Account;
  oauthClients: OAuthClient[];
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
  push: ToastPush;
}) {
  const [name, setName] = useState(account.name ?? '');
  const [slug, setSlug] = useState(account.slug);
  const [displayName, setDisplayName] = useState(account.displayName ?? '');
  const [status, setStatus] = useState<AccountStatus>(account.status ?? 'active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [reauthClientId, setReauthClientId] = useState<string>('');

  const authenticated = isAuthenticatedAccount(account);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await accountsApi.update(account.id, {
        name: name.trim() ? name : undefined,
        slug,
        status,
        ...(displayName !== account.displayName ? { displayName } : {}),
      });
      push('Account updated', 'success');
      onUpdated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await accountsApi.testConnection(account.id);
      setTestResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reauth = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await accountsApi.reauth(account.id, reauthClientId || undefined);
      push(res.message ?? 'Re-auth flow started', 'info');
      if (res.authorizeUrl) {
        window.open(res.authorizeUrl, '_blank', 'noopener');
      }
      onUpdated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await accountsApi.remove(account.id);
      push('Account deleted', 'success');
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Account details" wide>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <ProviderBadge provider={account.provider} />
        <KeyIcon authenticated={authenticated} />
        <HealthBadge health={account.health ?? 'unknown'} />
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium capitalize text-slate-600">
          {STATUS_LABELS[status] ?? status}
        </span>
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Slug</label>
          <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </div>
        <div>
          <label className="label">Display name</label>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as AccountStatus)}>
            {(Object.keys(STATUS_LABELS) as AccountStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-2 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <div className="mb-1 font-medium text-slate-700">
          {account.email || 'No email on file'}
        </div>
        <div className="font-mono text-xs text-slate-400">
          id: {account.id}
          {account.createdAt ? ` · created ${new Date(account.createdAt).toLocaleString()}` : ''}
        </div>
      </div>

      {testResult && (
        <div className="mb-4">
          <Alert tone={testResult.ok ? 'success' : 'error'}>
            <span className="font-medium">{testResult.ok ? 'Connected' : 'Failed'}:</span> {testResult.message}
          </Alert>
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {oauthClients.length > 0 && (
          <select
            className="input !w-auto"
            value={reauthClientId}
            onChange={(e) => setReauthClientId(e.target.value)}
          >
            <option value="">Default OAuth client</option>
            {oauthClients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({PROVIDER_LABELS[c.provider] ?? c.provider})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        <button onClick={() => void save()} disabled={busy} className="btn-primary">
          Save changes
        </button>
        <button onClick={() => void reauth()} disabled={busy} className="btn-secondary">
          Re-authenticate
        </button>
        <button onClick={() => void runTest()} disabled={busy} className="btn-secondary">
          Test connection
        </button>
        <div className="flex-1" />
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Delete this account?</span>
            <button onClick={() => void remove()} disabled={busy} className="btn-danger">
              Confirm delete
            </button>
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="btn-danger">
            Delete
          </button>
        )}
      </div>
    </Modal>
  );
}