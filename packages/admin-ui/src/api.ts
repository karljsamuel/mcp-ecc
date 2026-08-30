import type {
  Account,
  AccountCreateInput,
  AccountStatus,
  Health,
  OAuthClient,
  ProviderName,
  Role,
  User,
} from './types';

/**
 * Central API client for the management API.
 *
 * Authentication is cookie-based (session cookie set by the server), so nothing
 * sensitive is stored on the client. On any 401 the caller is redirected to
 * /login by the auth layer (see AuthContext).
 */

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export class ApiRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    unauthorizedHandler?.();
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object') {
        const err = body as { error?: string; message?: string };
        message = err.error ?? err.message ?? message;
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiRequestError(message, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ------------------------------- auth -------------------------------- */

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export interface LoginResult {
  user: AuthUser;
}

export const authApi = {
  login: (username: string, password: string) =>
    send<LoginResult>('/api/auth/login', 'POST', { username, password }),
  logout: () => send<{ success?: boolean }>('/api/auth/logout', 'POST'),
  me: () => get<{ user: AuthUser }>('/api/auth/me'),
  bootstrap: (username: string, password: string, displayName: string) =>
    send<LoginResult>('/api/auth/bootstrap', 'POST', { username, password, displayName }),
};

/* ------------------------------ accounts ----------------------------- */

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

export interface ReauthResult {
  authorizeUrl?: string;
  state?: string;
  message?: string;
}

export const accountsApi = {
  list: () => get<{ accounts: Account[] }>('/api/accounts'),
  get: (id: string) => get<{ account: Account }>(`/api/accounts/${id}`),
  create: (input: AccountCreateInput) =>
    send<{ account?: Account; authorizeUrl?: string; state?: string }>('/api/accounts', 'POST', input),
  remove: (id: string) => send<{ success: boolean }>(`/api/accounts/${id}`, 'DELETE'),
  update: (
    id: string,
    patch: Partial<Pick<Account, 'name' | 'slug' | 'displayName' | 'status' | 'health'>>,
  ) => send<{ account: Account }>(`/api/accounts/${id}`, 'PATCH', patch),
  reauth: (id: string, oauthClientId?: string) =>
    send<ReauthResult>(`/api/accounts/${id}/reauth`, 'POST', oauthClientId ? { oauthClientId } : {}),
  testConnection: (id: string) =>
    send<TestConnectionResult>(`/api/accounts/${id}/test-connection`, 'POST', {}),
};

/* ------------------------------ oauth clients ------------------------ */

export interface OAuthClientInput {
  provider: ProviderName;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  tenantId?: string;
  accountsServer?: string;
}

export const oauthClientsApi = {
  list: () => get<{ clients: OAuthClient[] }>('/api/oauth-clients'),
  create: (input: OAuthClientInput) =>
    send<{ client: OAuthClient }>('/api/oauth-clients', 'POST', input),
  remove: (id: string) => send<{ success: boolean }>(`/api/oauth-clients/${id}`, 'DELETE'),
};

/* -------------------------------- users ------------------------------ */

export const usersApi = {
  list: () => get<{ users: User[] }>('/api/users'),
  create: (input: { username: string; password: string; displayName: string; role: Role }) =>
    send<{ user: User }>('/api/users', 'POST', input),
  remove: (id: string) => send<{ success: boolean }>(`/api/users/${id}`, 'DELETE'),
  update: (id: string, patch: { displayName?: string; role?: Role }) =>
    send<{ user: User }>(`/api/users/${id}`, 'PATCH', patch),
  resetPassword: (id: string, password: string) =>
    send<{ success: boolean }>(`/api/users/${id}/reset-password`, 'POST', { password }),
};

/* ------------------------------- settings ----------------------------- */

export interface Settings {
  id?: string;
  username?: string;
  displayName?: string;
  role?: Role;
  mcpApiKey?: string;
}

export const settingsApi = {
  me: () => get<{ settings: Settings }>('/api/settings/me'),
  update: (patch: { displayName?: string; currentPassword?: string; newPassword?: string }) =>
    send<{ settings: Settings }>('/api/settings/me', 'PATCH', patch),
  rotateApiKey: () => send<{ settings: Settings; mcpApiKey?: string }>('/api/settings/me/rotate-apikey', 'POST', {}),
};

/* ------------------------------ helpers ------------------------------ */

export function isAuthenticatedAccount(a: Account): boolean {
  if (typeof a.authenticated === 'boolean') return a.authenticated;
  return a.status === 'active' && a.health !== 'unhealthy';
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  zoho: 'Zoho',
  imap: 'IMAP',
  smtp: 'SMTP',
  caldav: 'CalDAV',
  carddav: 'CardDAV',
};

export const STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  error: 'Error',
  disabled: 'Disabled',
};

export const HEALTH_LABELS: Record<Health, string> = {
  unknown: 'Unknown',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
};