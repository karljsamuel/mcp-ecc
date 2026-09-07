import { useCallback, useEffect, useState } from 'react';
import { oauthClientsApi, PROVIDER_LABELS } from '../api';
import type { ClientPlatform, OAuthClient, ProviderName } from '../types';

type ToastFn = (text: string, tone?: 'info' | 'success' | 'error') => void;

const PROVIDERS: ProviderName[] = ['google', 'microsoft', 'zoho'];

const PLATFORM_LABELS: Record<ClientPlatform, string> = {
  desktop: 'Desktop / Installed App (public client)',
  web: 'Web Application (confidential client)',
  limited_input: 'Device Flow / Limited Input (public client)',
};

interface ClientForm {
  provider: ProviderName;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  tenantId: string;
  accountsServer: string;
  clientPlatform: ClientPlatform;
}

const EMPTY_FORM: ClientForm = {
  provider: 'google',
  label: '',
  clientId: '',
  clientSecret: '',
  scopes: '',
  tenantId: '',
  accountsServer: '',
  clientPlatform: 'desktop',
};

function platformToType(p: ClientPlatform): 'public' | 'confidential' {
  return p === 'web' ? 'confidential' : 'public';
}

export function OAuthClients({ push }: { push: ToastFn }) {
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<OAuthClient | null>(null);
  const [form, setForm] = useState<ClientForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { clients: list } = await oauthClientsApi.list();
      setClients(list);
    } catch (e: any) {
      push(e.message || 'Failed to load OAuth clients', 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (c: OAuthClient) => {
    setEditing(c);
    setForm({
      provider: c.provider,
      label: c.label,
      clientId: c.clientId,
      clientSecret: c.clientSecret || '',
      scopes: (c.scopes || []).join(' '),
      tenantId: c.tenantId || '',
      accountsServer: c.accountsServer || '',
      clientPlatform: c.clientPlatform || 'desktop',
    });
    setShowForm(true);
  };

  const submit = async () => {
    if (!form.label.trim() || !form.clientId.trim()) {
      push('Label and Client ID are required', 'error');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        provider: form.provider,
        label: form.label.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(),
        scopes: form.scopes.split(/\s+/).filter(Boolean),
        tenantId: form.tenantId.trim() || undefined,
        accountsServer: form.accountsServer.trim() || undefined,
        clientPlatform: form.clientPlatform,
        clientType: platformToType(form.clientPlatform),
      };
      if (editing) {
        await oauthClientsApi.update(editing.id, payload);
        push('OAuth client updated', 'success');
      } else {
        await oauthClientsApi.create(payload);
        push('OAuth client created', 'success');
      }
      setShowForm(false);
      void load();
    } catch (e: any) {
      push(e.message || 'Failed to save OAuth client', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: OAuthClient) => {
    if (!window.confirm(`Delete OAuth client "${c.label}"?`)) return;
    try {
      await oauthClientsApi.remove(c.id);
      push('OAuth client deleted', 'success');
      void load();
    } catch (e: any) {
      push(e.message || 'Failed to delete OAuth client', 'error');
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">OAuth Clients</h1>
          <p className="text-sm text-slate-500">
            Manage your provider OAuth credentials. A client can have multiple platform variants (desktop, web,
            limited-input) under the same label.
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          Add OAuth Client
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : clients.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          No OAuth clients yet. Add your Google / Microsoft / Zoho client credentials to get started.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Client ID</th>
                <th className="px-4 py-3">Platform</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Scopes</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {clients.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">{PROVIDER_LABELS[c.provider] ?? c.provider}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{c.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.clientId}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">
                      {c.clientPlatform || 'desktop'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{c.clientType || 'public'}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-xs text-slate-400">
                    {(c.scopes || []).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(c)} className="btn-secondary !px-2.5 !py-1 text-xs">
                      Edit
                    </button>{' '}
                    <button
                      onClick={() => void remove(c)}
                      className="btn-danger !px-2.5 !py-1 text-xs"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="card w-full max-w-lg p-6">
            <h2 className="mb-4 text-lg font-bold text-slate-900">
              {editing ? 'Edit OAuth Client' : 'Add OAuth Client'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="label">Provider</label>
                <select
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderName })}
                  className="input"
                  disabled={!!editing}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABELS[p]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label">Client Label</label>
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  className="input"
                  placeholder="e.g. My Org Client"
                />
              </div>

              <div>
                <label className="label">Client ID</label>
                <input
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                  className="input"
                  placeholder="OAuth client ID"
                />
              </div>

              <div>
                <label className="label">Client Secret</label>
                <input
                  value={form.clientSecret}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                  className="input"
                  placeholder={editing ? 'Leave blank to keep current' : 'OAuth client secret'}
                  type="password"
                />
              </div>

              <div>
                <label className="label">Platform</label>
                <select
                  value={form.clientPlatform}
                  onChange={(e) => setForm({ ...form, clientPlatform: e.target.value as ClientPlatform })}
                  className="input"
                >
                  {(Object.keys(PLATFORM_LABELS) as ClientPlatform[]).map((p) => (
                    <option key={p} value={p}>
                      {PLATFORM_LABELS[p]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-400">
                  Type is auto-derived: web → confidential, desktop/limited_input → public.
                </p>
              </div>

              {form.provider === 'microsoft' && (
                <div>
                  <label className="label">Tenant ID (Microsoft)</label>
                  <input
                    value={form.tenantId}
                    onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                    className="input"
                    placeholder="common, organizations, or directory ID"
                  />
                </div>
              )}

              {form.provider === 'zoho' && (
                <div>
                  <label className="label">Zoho region server</label>
                  <input
                    value={form.accountsServer}
                    onChange={(e) => setForm({ ...form, accountsServer: e.target.value })}
                    className="input"
                    placeholder="accounts.zoho.com"
                  />
                </div>
              )}

              <div>
                <label className="label">Scopes (space-separated)</label>
                <textarea
                  value={form.scopes}
                  onChange={(e) => setForm({ ...form, scopes: e.target.value })}
                  className="input min-h-[70px] font-mono text-xs"
                  placeholder="https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="btn-secondary">
                Cancel
              </button>
              <button onClick={() => void submit()} disabled={busy} className="btn-primary">
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}