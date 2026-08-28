import type {
  Account,
  AccountCredentials,
  SyncState,
  Settings,
  OAuthTokens,
  ProviderName,
  OAuthConfig,
  DeviceCodeResponse,
  EmailMessage,
  MailFolder,
  CalendarEvent,
  Calendar,
  Contact,
  OAuthFlowType,
  OAuthStateData,
} from './types.js';

export interface StorageAdapter {
  // Account management
  getAccount(id: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  saveAccount(account: Account): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  updateAccount(id: string, updates: Partial<Account>): Promise<void>;

  // Credentials (encrypted)
  getCredentials(accountId: string): Promise<AccountCredentials | null>;
  saveCredentials(accountId: string, credentials: AccountCredentials): Promise<void>;
  updateCredentials(accountId: string, updates: Partial<AccountCredentials>): Promise<void>;

  // Sync state
  getSyncState(accountId: string): Promise<SyncState | null>;
  saveSyncState(state: SyncState): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;

  // OAuth state (temporary, for flow)
  saveOAuthState(state: string, data: OAuthStateData): Promise<void>;
  getOAuthState(state: string): Promise<OAuthStateData | null>;
  deleteOAuthState(state: string): Promise<void>;

  // Mail metadata (optional caching)
  saveMailMessages(accountId: string, messages: EmailMessage[]): Promise<void>;
  getMailMessages(accountId: string, folderId: string, limit: number, cursor?: string): Promise<EmailMessage[]>;
  saveMailFolders(accountId: string, folders: MailFolder[]): Promise<void>;
  getMailFolders(accountId: string): Promise<MailFolder[]>;

  // Calendar metadata
  saveCalendarEvents(accountId: string, calendarId: string, events: CalendarEvent[]): Promise<void>;
  getCalendarEvents(accountId: string, calendarId: string, timeMin: number, timeMax: number): Promise<CalendarEvent[]>;
  saveCalendars(accountId: string, calendars: Calendar[]): Promise<void>;
  getCalendars(accountId: string): Promise<Calendar[]>;

  // Contacts metadata
  saveContacts(accountId: string, contacts: Contact[]): Promise<void>;
  getContacts(accountId: string, limit: number, cursor?: string): Promise<Contact[]>;
  searchContacts(accountId: string, query: string, limit: number): Promise<Contact[]>;

  // Health/check
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}