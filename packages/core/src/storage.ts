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
  OAuthClient,
  User,
} from './types.js';

export interface StorageAdapter {
  // Account management
  getAccount(id: string): Promise<Account | null>;
  listAccounts(ownerId?: string): Promise<Account[]>;
  saveAccount(account: Account): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  updateAccount(id: string, updates: Partial<Account>): Promise<void>;
  getAccountBySlug(slug: string, ownerId: string): Promise<Account | null>;

  // OAuth clients (per-user, multiple per provider)
  saveOAuthClient(client: OAuthClient): Promise<void>;
  getOAuthClient(id: string): Promise<OAuthClient | null>;
  listOAuthClients(ownerId: string): Promise<OAuthClient[]>;
  deleteOAuthClient(id: string): Promise<void>;

  // Users
  saveUser(user: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  getUserByApiKey(apiKey: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  updateUser(id: string, updates: Partial<User>): Promise<void>;
  deleteUser(id: string): Promise<void>;
  countUsers(): Promise<number>;

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