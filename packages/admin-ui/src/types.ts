export type ProviderName = 'google' | 'microsoft' | 'zoho' | 'imap' | 'smtp' | 'caldav' | 'carddav';
export type AccountStatus = 'active' | 'error' | 'disabled';
export type Health = 'unknown' | 'healthy' | 'unhealthy';
export type Role = 'admin' | 'user';
export type ClientPlatform = 'desktop' | 'web' | 'limited_input';

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
  /** Non-secret IMAP/SMTP settings. Never contains the app password. */
  mailConfig?: MailConfig;
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
  clientPlatform?: ClientPlatform;
  clientType?: 'public' | 'confidential';
  enabled?: boolean;
}

export interface OAuthClientInput {
  provider: ProviderName;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  tenantId?: string;
  accountsServer?: string;
  clientPlatform?: ClientPlatform;
  clientType?: 'public' | 'confidential';
}

/** Non-secret IMAP/SMTP settings as returned by the API. */
export interface MailConfig {
  username?: string;
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  /** CalDAV/CardDAV endpoint, returned so the edit form can show the stored URL. */
  caldavUrl?: string;
  carddavUrl?: string;
}

/**
 * Mail settings sent to the API. `appPassword` is never returned by the server, so on
 * an update a blank value means "keep the stored password".
 */
export interface MailSettingsInput {
  username?: string;
  appPassword?: string;
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  /** CalDAV/CardDAV endpoint. Required for those providers. */
  caldavUrl?: string;
  carddavUrl?: string;
  /** Free-form provider config, merged into the stored config server-side. */
  config?: Record<string, unknown>;
}

export interface AccountCreateInput extends MailSettingsInput {
  name: string;
  provider: ProviderName;
  slug: string;
  email: string;
  displayName?: string;
  config?: Record<string, unknown>;
  oauthClientId?: string;
  client?: {
    label?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    tenantId?: string;
    accountsServer?: string;
    clientPlatform?: ClientPlatform;
    clientType?: 'public' | 'confidential';
  };
}

export interface ApiError {
  error?: string;
  message?: string;
  [key: string]: unknown;
}