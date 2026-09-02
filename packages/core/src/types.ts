export type ProviderName = 'google' | 'microsoft' | 'zoho' | 'imap' | 'smtp' | 'caldav' | 'carddav';

export interface AccountConfig {
  // Provider-specific configuration
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  caldavUrl?: string;
  carddavUrl?: string;
  accountsServer?: string; // Zoho region
  tenantId?: string; // Microsoft
  [key: string]: unknown;
}

export interface AccountCredentials {
  // OAuth credentials
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number; // Unix ms
  // Reference to the stored OAuth client used for this account
  oauthClientId?: string;
  // App password for IMAP/SMTP
  appPassword?: string;
  // Provider-specific config
  config?: AccountConfig;
  // Tenant ID for Microsoft
  tenantId?: string;
  // Public client (mobile/desktop) — must not send a client secret on refresh
  isPublicClient?: boolean;
}

export interface Account {
  id: string; // UUID
  ownerId: string; // owning user id
  provider: ProviderName;
  name: string; // human-readable, may contain spaces/special chars
  slug: string; // URL-safe unique key ([a-z0-9-_]), used in MCP resource URIs
  email: string;
  displayName?: string;
  credentials: AccountCredentials;
  status: 'active' | 'error' | 'disabled';
  health: 'unknown' | 'healthy' | 'unhealthy';
  lastSyncAt?: number;
  createdAt: number;
  updatedAt: number;
}

// An OAuth application / client the user registers with a provider.
// Multiple clients per provider are allowed (personal, org-A, org-B).
// client_secret is encrypted at rest. Stored per-account (NOT in .env).
export interface OAuthClient {
  id: string; // UUID
  ownerId: string; // owning user id
  provider: ProviderName;
  label: string; // e.g. "Personal", "KCET Org"
  clientId: string;
  clientSecret: string; // encrypted
  scopes: string[];
  tenantId?: string; // Microsoft
  accountsServer?: string; // Zoho region
  // 'public' = Desktop / Non-browser / Installed app (no client secret on refresh)
  // 'confidential' = Web app / server-side (client secret required)
  clientType?: 'public' | 'confidential';
  clientPlatform?: 'desktop' | 'web' | 'limited_input';
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// Application user. Users self-manage their own accounts. Admin manages users.
export interface User {
  id: string; // UUID
  username: string; // unique, immutable
  displayName: string;
  passwordHash: string; // argon2
  role: 'admin' | 'user';
  mcpApiKey: string; // encrypted; scopes /mcp to this user's accounts
  createdAt: number;
  updatedAt: number;
}

export interface EmailMessage {
  id: string;
  threadId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  snippet?: string;
  body?: string; // Plain text
  htmlBody?: string;
  date: number; // Unix ms
  unread: boolean;
  starred: boolean;
  labelsOrFolders: string[];
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  data?: Buffer | string; // Base64 or buffer
}

export interface MailFolder {
  id: string;
  name: string;
  parentId?: string;
  type: 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'spam' | 'custom';
  unreadCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: number; // Unix ms
  endAt: number; // Unix ms
  allDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees?: EmailAddress[];
  recurrenceRule?: string; // RRULE
  raw?: Record<string, unknown>;
}

export interface Calendar {
  id: string;
  name: string;
  description?: string;
  color?: string;
  primary: boolean;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  createdAt: number;
  updatedAt: number;
}

export interface Contact {
  id: string;
  displayName: string;
  emails: ContactEmail[];
  phones?: ContactPhone[];
  addresses?: ContactAddress[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
  raw?: Record<string, unknown>;
}

export interface ContactEmail {
  email: string;
  type?: 'home' | 'work' | 'other';
  primary?: boolean;
}

export interface ContactPhone {
  number: string;
  type?: 'mobile' | 'home' | 'work' | 'other';
}

export interface ContactAddress {
  formatted?: string;
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  type?: 'home' | 'work' | 'other';
}

// Provider interfaces
export interface IMailProvider {
  listFolders(): Promise<MailFolder[]>;
  listMessages(folderId: string, options?: ListMessagesOptions): Promise<EmailMessage[]>;
  getMessage(messageId: string): Promise<EmailMessage>;
  sendMessage(message: SendMessageInput): Promise<EmailMessage>;
  searchMessages(query: string, options?: SearchOptions): Promise<EmailMessage[]>;
  moveMessage(messageId: string, folderId: string): Promise<void>;
  setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void>;
  deleteMessage(messageId: string, permanent?: boolean): Promise<void>;
}

export interface ListMessagesOptions {
  limit?: number;
  cursor?: string;
  query?: string;
  unreadOnly?: boolean;
}

export interface SearchOptions {
  limit?: number;
  cursor?: string;
}

export interface SendMessageInput {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface ICalendarProvider {
  listCalendars(): Promise<Calendar[]>;
  listEvents(calendarId: string, options?: ListEventsOptions): Promise<CalendarEvent[]>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;
  createEvent(calendarId: string, event: CreateEventInput): Promise<CalendarEvent>;
  updateEvent(calendarId: string, eventId: string, patches: UpdateEventInput): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<FreeBusyResult[]>;
}

export interface ListEventsOptions {
  timeMin?: number;
  timeMax?: number;
  limit?: number;
  cursor?: string;
  query?: string;
}

export interface CreateEventInput {
  summary: string;
  startAt: number;
  endAt: number;
  description?: string;
  location?: string;
  attendees?: EmailAddress[];
  allDay?: boolean;
  recurrenceRule?: string;
}

export interface UpdateEventInput {
  summary?: string;
  startAt?: number;
  endAt?: number;
  description?: string;
  location?: string;
  attendees?: EmailAddress[];
  status?: 'confirmed' | 'tentative' | 'cancelled';
  allDay?: boolean;
}

export interface FreeBusyResult {
  calendarId: string;
  busy: Array<{ start: number; end: number }>;
}

export interface IContactsProvider {
  listContacts(options?: ListContactsOptions): Promise<Contact[]>;
  getContact(contactId: string): Promise<Contact>;
  createContact(contact: CreateContactInput): Promise<Contact>;
  updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact>;
  deleteContact(contactId: string): Promise<void>;
  searchContacts(query: string, options?: SearchOptions): Promise<Contact[]>;
}

export interface ListContactsOptions {
  limit?: number;
  cursor?: string;
}

export interface CreateContactInput {
  displayName: string;
  emails: ContactEmail[];
  phones?: ContactPhone[];
  addresses?: ContactAddress[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
}

export interface UpdateContactInput {
  displayName?: string;
  emails?: ContactEmail[];
  phones?: ContactPhone[];
  addresses?: ContactAddress[];
  organization?: string;
  jobTitle?: string;
  notes?: string;
}

// Sync state
export interface SyncState {
  accountId: string;
  mailCursor?: string;
  contactsCursor?: string;
  calendarCursor?: string;
  lastFullSync?: number;
  updatedAt: number;
}

// Settings
export interface Settings {
  encryptionKey?: string; // Base64 encoded
  uiPreferences?: Record<string, unknown>;
  updatedAt: number;
}

// OAuth
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  idToken?: string;
  tokenType?: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type OAuthFlowType = 'authorization_code' | 'device_code' | 'refresh';

export interface OAuthConfig {
  provider: ProviderName;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  tenantId?: string;
  accountsServer?: string;
}

export interface OAuthStateData {
  provider: ProviderName;
  flowType: OAuthFlowType;
  codeVerifier: string;
  redirectUri?: string;
  clientId: string;
  clientSecret?: string;
  tenantId?: string;
  accountsServer?: string;
  createdAt: number;
}

// Errors
export class McpEccError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = 'McpEccError';
  }
}

export class AuthError extends McpEccError {
  constructor(message: string, details?: unknown) {
    super(message, 'AUTH_ERROR', 401, details);
    this.name = 'AuthError';
  }
}

export class ProviderError extends McpEccError {
  constructor(message: string, public provider: ProviderName, details?: unknown) {
    super(message, 'PROVIDER_ERROR', 502, details);
    this.name = 'ProviderError';
  }
}

export class NotFoundError extends McpEccError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}