import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  accountsApi,
  infoApi,
  isAuthenticatedAccount,
  oauthClientsApi,
  PROVIDER_LABELS,
  STATUS_LABELS,
  type ServerInfo,
} from '../api';
import type { Account, AccountCreateInput, AccountStatus, MailSettingsInput, OAuthClient, ProviderName } from '../types';
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
/** Providers that authenticate with an app password rather than an OAuth flow. */
const isPasswordProvider = (p: ProviderName) => ['imap', 'smtp', 'caldav', 'carddav'].includes(p);
/** Providers whose settings are IMAP/SMTP hosts and ports. */
const isMailProvider = (p: ProviderName) => ['imap', 'smtp'].includes(p);

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

type MailSettings = MailSettingsInput;

/**
 * Mail server settings for an account.
 *
 * The API never returns the app password, so on an existing account this field starts
 * empty and a blank value means "keep the stored password" — the placeholder says so
 * explicitly, so an empty box is not read as a request to clear the secret.
 */
function MailSettingsFields({
  provider,
  value,
  onChange,
  passwordRequired,
}: {
  provider: ProviderName;
  value: MailSettings;
  onChange: (next: MailSettings) => void;
  passwordRequired: boolean;
}) {
  const set = (patch: Partial<MailSettings>) => onChange({ ...value, ...patch });
  const asPort = (raw: string, fallback: number) => {
    if (raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="text-sm font-semibold text-slate-700">Mail server</div>

      <div>
        <label className="label">App password</label>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={value.appPassword ?? ''}
          onChange={(e) => set({ appPassword: e.target.value })}
          placeholder={passwordRequired ? 'App password' : 'Leave blank to keep the stored password'}
          required={passwordRequired}
        />
        <p className="mt-1 text-xs text-slate-500">
          Stored encrypted and never sent back to this page.
        </p>
      </div>

      {isMailProvider(provider) ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="label">IMAP host</label>
              <input
                className="input"
                value={value.imapHost ?? ''}
                onChange={(e) => set({ imapHost: e.target.value })}
                placeholder="imap.gmail.com"
              />
            </div>
            <div>
              <label className="label">IMAP port</label>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={value.imapPort ?? DEFAULT_IMAP_PORT}
                onChange={(e) => set({ imapPort: asPort(e.target.value, DEFAULT_IMAP_PORT) })}
              />
            </div>
            <div>
              <label className="label">SMTP host</label>
              <input
                className="input"
                value={value.smtpHost ?? ''}
                onChange={(e) => set({ smtpHost: e.target.value })}
                placeholder="smtp.gmail.com"
              />
            </div>
            <div>
              <label className="label">SMTP port</label>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={value.smtpPort ?? DEFAULT_SMTP_PORT}
                onChange={(e) => set({ smtpPort: asPort(e.target.value, DEFAULT_SMTP_PORT) })}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="accent-indigo-600"
              checked={value.imapTls !== false}
              onChange={(e) => set({ imapTls: e.target.checked })}
            />
            Use TLS for IMAP
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="accent-indigo-600"
              checked={value.smtpSecure !== false}
              onChange={(e) => set({ smtpSecure: e.target.checked })}
            />
            Use TLS for SMTP
          </label>

          <div>
            <label className="label">Username</label>
            <input
              className="input"
              value={value.username ?? ''}
              onChange={(e) => set({ username: e.target.value })}
              placeholder="Defaults to the account email"
            />
            <p className="mt-1 text-xs text-slate-500">
              Leave blank unless your mail provider gives you a separate login name.
            </p>
          </div>
        </>
      ) : (
        <div>
          <label className="label">{provider === 'carddav' ? 'CardDAV URL' : 'CalDAV URL'}</label>
          <input
            className="input"
            value={(provider === 'carddav' ? value.carddavUrl : value.caldavUrl) ?? ''}
            onChange={(e) =>
              set(provider === 'carddav' ? { carddavUrl: e.target.value } : { caldavUrl: e.target.value })
            }
            placeholder="https://example.com/.well-known/dav"
            required
          />
        </div>
      )}
    </div>
  );
}

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
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') === 'success') {
      push('OAuth completed successfully', 'success');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('oauth') === 'error') {
      push(params.get('message') || 'OAuth completion failed', 'error');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [load, push]);

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
  const [mail, setMail] = useState<MailSettings>({});
  const [deviceFlow, setDeviceFlow] = useState<{
    userCode?: string;
    verificationUri?: string;
    state?: string;
    interval?: number;
  } | null>(null);
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

  useEffect(() => {
    setUseSavedClient(true);
    setSelectedClientId('');
  }, [provider]);

  // A device flow belongs to one attempt, and this modal stays mounted between openings
  // (only its `open` prop changes). Without this, a finished or abandoned flow would
  // resurface as a dead code with no form behind it the next time Add account is clicked.
  useEffect(() => {
    if (open) {
      setDeviceFlow(null);
      setError(null);
    }
  }, [open]);

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
      } else if (isPasswordProvider(provider)) {
        // Without a secret these providers can never authenticate, so the server
        // rejects the request outright — fail here first with a clearer message.
        const appPassword = mail.appPassword?.trim();
        if (!appPassword) throw new Error('An app password is required for this provider');
        payload.appPassword = appPassword;

        if (isMailProvider(provider)) {
          payload.imapHost = mail.imapHost?.trim() || undefined;
          payload.imapPort = mail.imapPort ?? DEFAULT_IMAP_PORT;
          payload.imapTls = mail.imapTls !== false;
          payload.smtpHost = mail.smtpHost?.trim() || undefined;
          payload.smtpPort = mail.smtpPort ?? DEFAULT_SMTP_PORT;
          payload.smtpSecure = mail.smtpSecure !== false;
          payload.username = mail.username?.trim() || undefined;
        } else {
          const key = provider === 'carddav' ? 'carddavUrl' : 'caldavUrl';
          const url = (provider === 'carddav' ? mail.carddavUrl : mail.caldavUrl)?.trim();
          if (!url) throw new Error(`${provider === 'carddav' ? 'CardDAV' : 'CalDAV'} URL is required`);
          payload.config = { [key]: url };
        }
      }
      const result = await accountsApi.create(payload);
      if (result.flowType === 'device_code') {
        // A device flow needs the user to approve in another tab and then be exchanged
        // server-side, so keep this modal open and let the panel drive it to completion.
        setDeviceFlow({
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          state: result.state,
          interval: result.interval,
        });
        return;
      }
      if (result.authorizeUrl) {
        window.open(result.authorizeUrl, '_blank', 'noopener');
        push(result.message ?? 'Account created. Complete authorisation in the new tab.', 'info');
      } else {
        push(`Account "${name || email}" created`, 'success');
      }
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add account">
      {deviceFlow ? (
        <>
          <p className="mb-3 text-sm text-slate-600">
            The account has been created and is waiting for approval. This panel updates as soon
            as you approve it — you can close it and approve later.
          </p>
          <DeviceAuthPanel
            userCode={deviceFlow.userCode}
            verificationUri={deviceFlow.verificationUri}
            state={deviceFlow.state}
            intervalSeconds={deviceFlow.interval}
            onComplete={() => {
              push(`Account "${name || email}" created`, 'success');
              onCreated();
            }}
            onFailed={(message) => setError(message)}
          />
          {error && (
            <div className="mb-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
          <div className="flex justify-end pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Close</button>
          </div>
        </>
      ) : (
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

            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="clientMode"
                  checked={useSavedClient}
                  onChange={() => setUseSavedClient(true)}
                  className="accent-indigo-600"
                />
                Use existing client
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="clientMode"
                  checked={!useSavedClient}
                  onChange={() => setUseSavedClient(false)}
                  className="accent-indigo-600"
                />
                Enter new credentials
              </label>
            </div>

            {useSavedClient ? (
              <select
                className="input"
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                required={useSavedClient}
              >
                <option value="">Select an existing client…</option>
                {providerClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.clientId})
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
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

        {isPasswordProvider(provider) && (
          <MailSettingsFields provider={provider} value={mail} onChange={setMail} passwordRequired />
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary">
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}

/* --------------------------- device authorisation --------------------- */

/** How long to keep polling before treating the code as expired (codes last ~15 min). */
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Completes a device-authorisation flow in the browser.
 *
 * The token exchange happens server-side, so this only drives the cadence: it polls
 * once per interval and shows what the user has to do. It stays on screen until the
 * flow completes, expires, or fails — a device flow cannot be finished by opening a
 * tab and walking away, which is why the code has to be readable here.
 */
function DeviceAuthPanel({
  userCode,
  verificationUri,
  state,
  intervalSeconds,
  onComplete,
  onFailed,
}: {
  userCode?: string;
  verificationUri?: string;
  state?: string;
  intervalSeconds?: number;
  onComplete: () => void;
  onFailed: (message: string) => void;
}) {
  const [status, setStatus] = useState<'waiting' | 'expired' | 'error'>('waiting');
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Kept in refs so the polling effect does not restart when a parent re-renders.
  // Synced in an effect rather than during render, which is the supported approach.
  const complete = useRef(onComplete);
  const failed = useRef(onFailed);
  useEffect(() => {
    complete.current = onComplete;
    failed.current = onFailed;
  });

  const intervalMs = Math.max(5, intervalSeconds ?? 5) * 1000;

  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + DEVICE_AUTH_TIMEOUT_MS;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setStatus('expired');
        setMessage('The code expired before it was approved. Start again to get a new one.');
        return;
      }
      try {
        const result = await accountsApi.pollDeviceAuth(state);
        if (cancelled) return;
        if (result.status === 'complete') {
          complete.current();
          return;
        }
        if (result.status === 'pending') {
          timer = setTimeout(() => void poll(), intervalMs);
          return;
        }
        if (result.status === 'error' && result.retryable) {
          // A dropped request, not a refusal from the provider: the user may already have
          // approved, so keep polling to the deadline instead of abandoning the flow.
          setMessage(result.message ?? null);
          timer = setTimeout(() => void poll(), intervalMs);
          return;
        }
        setStatus(result.status === 'expired' ? 'expired' : 'error');
        setMessage(result.message ?? null);
        if (result.status === 'error') failed.current(result.message ?? 'Authorisation failed');
      } catch (err) {
        if (cancelled) return;
        // A dropped poll is not fatal: keep trying until the deadline.
        setMessage((err as Error).message);
        timer = setTimeout(() => void poll(), intervalMs);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state, intervalMs]);

  return (
    <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
      <div className="text-sm font-semibold text-indigo-900">Approve this sign-in</div>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-indigo-900">
        <li>
          Open{' '}
          {verificationUri ? (
            <a className="font-medium underline" href={verificationUri} target="_blank" rel="noreferrer">
              {verificationUri}
            </a>
          ) : (
            'the verification page'
          )}
        </li>
        <li>Enter this code:</li>
      </ol>

      <div className="mt-2 flex items-center gap-3">
        <code className="rounded bg-white px-3 py-2 font-mono text-lg font-bold tracking-widest text-indigo-700">
          {userCode || '—'}
        </code>
        {userCode && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              // Clipboard access can be refused (unfocused document, permissions). The code
              // is on screen either way, so the rejection needs no louder handling.
              void navigator.clipboard
                ?.writeText(userCode)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch(() => {});
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </button>
        )}
      </div>

      <div className="mt-3 text-sm">
        {status === 'waiting' && !message && (
          <span className="text-indigo-800">Waiting for approval…</span>
        )}
        {status === 'waiting' && message && <span className="text-amber-700">{message}</span>}
        {status === 'expired' && (
          <span className="text-amber-700">{message ?? 'The code expired.'}</span>
        )}
        {status === 'error' && (
          <span className="text-red-700">Authorisation failed{message ? `: ${message}` : '.'}</span>
        )}
      </div>
    </div>
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
  // Seeded from the account's non-secret settings. The app password is deliberately
  // absent — the server never returns it — so the field starts empty on every open.
  const [mail, setMail] = useState<MailSettings>({ ...(account.mailConfig ?? {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [reauthClientId, setReauthClientId] = useState<string>('');
  const [reauthFlow, setReauthFlow] = useState<{ verificationUri?: string; userCode?: string; message?: string; state?: string; interval?: number; device?: boolean } | null>(null);

  const authenticated = isAuthenticatedAccount(account);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof accountsApi.update>[1] = {
        name: name.trim() ? name : undefined,
        slug,
        status,
        ...(displayName !== account.displayName ? { displayName } : {}),
      };

      if (isPasswordProvider(account.provider)) {
        // Blank means "keep the stored password", so only send a non-empty one.
        const appPassword = mail.appPassword?.trim();
        if (appPassword) patch.appPassword = appPassword;

        if (isMailProvider(account.provider)) {
          patch.username = mail.username?.trim() ?? '';
          patch.imapHost = mail.imapHost?.trim() || undefined;
          patch.imapPort = mail.imapPort ?? DEFAULT_IMAP_PORT;
          patch.imapTls = mail.imapTls !== false;
          patch.smtpHost = mail.smtpHost?.trim() || undefined;
          patch.smtpPort = mail.smtpPort ?? DEFAULT_SMTP_PORT;
          patch.smtpSecure = mail.smtpSecure !== false;
        } else {
          const url = (account.provider === 'carddav' ? mail.carddavUrl : mail.caldavUrl)?.trim();
          if (url) {
            patch.config = { [account.provider === 'carddav' ? 'carddavUrl' : 'caldavUrl']: url };
          }
        }
      }

      await accountsApi.update(account.id, patch);
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
      if (res.flowType === 'device_code') {
        // The panel below completes this flow; opening a tab would only show the code.
        setReauthFlow({
          userCode: res.userCode,
          verificationUri: res.verificationUri,
          state: res.state,
          interval: res.interval,
          device: true,
        });
        push('Enter the code shown to re-authenticate', 'info');
        return;
      }
      setReauthFlow({ verificationUri: res.verificationUri || res.authorizeUrl, userCode: res.userCode, message: res.message });
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

      {reauthFlow && (
        <div className="mb-4">
          {reauthFlow.device ? (
            <DeviceAuthPanel
              userCode={reauthFlow.userCode}
              verificationUri={reauthFlow.verificationUri}
              state={reauthFlow.state}
              intervalSeconds={reauthFlow.interval}
              onComplete={() => {
                push('Re-authentication completed', 'success');
                setReauthFlow(null);
                onUpdated();
              }}
              onFailed={(message) => setError(message)}
            />
          ) : (
            <Alert tone="info">
              <div>{reauthFlow.message || 'Complete reauthentication.'}</div>
              {reauthFlow.verificationUri && <div className="mt-2"><a className="font-medium underline" href={reauthFlow.verificationUri} target="_blank" rel="noreferrer">Open authorisation page</a></div>}
              {reauthFlow.userCode && <div className="mt-2 font-mono font-bold">Code: {reauthFlow.userCode}</div>}
            </Alert>
          )}
        </div>
      )}

      {isPasswordProvider(account.provider) && (
        <div className="mb-5">
          <MailSettingsFields provider={account.provider} value={mail} onChange={setMail} passwordRequired={false} />
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