export type ProviderName = 'google' | 'microsoft' | 'zoho' | 'imap' | 'smtp' | 'caldav' | 'carddav';
export type AccountStatus = 'active' | 'error' | 'disabled';
export type Health = 'unknown' | 'healthy' | 'unhealthy';
export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt?: string;
}

export interface Account {
  id: string;
  provider: ProviderName;
  name?: string;
  slug: string;
  email: string;
  displayName?: string;
  status: AccountStatus;
  health?: Health;
  authenticated?: boolean;
  lastSyncAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OAuthClient {
  id: string;
  provider: ProviderName;
  label: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  tenantId?: string;
  accountsServer?: string;
}

export interface AccountCreateInput {
  name: string;
  provider: ProviderName;
  slug: string;
  email: string;
  config?: Record<string, unknown>;
  oauthClientId?: string;
  // Inline OAuth client creation (used when no saved client matches)
  client?: {
    label?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    tenantId?: string;
    accountsServer?: string;
  };
}

export interface ApiError {
  error?: string;
  message?: string;
  [key: string]: unknown;
}