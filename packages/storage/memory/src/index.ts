import type {
  StorageAdapter,
  Account,
  AccountCredentials,
  SyncState,
  Settings,
  EmailMessage,
  MailFolder,
  CalendarEvent,
  Calendar,
  Contact,
  OAuthStateData,
} from '@mcp-ecc/core';

export class MemoryStorage implements StorageAdapter {
  private accounts = new Map<string, Account>();
  private credentials = new Map<string, AccountCredentials>();
  private syncStates = new Map<string, SyncState>();
  private settings: Settings = { updatedAt: 0 };
  private oauthStates = new Map<string, OAuthStateData>();
  private mailMessages = new Map<string, EmailMessage[]>(); // accountId -> messages
  private mailFolders = new Map<string, MailFolder[]>(); // accountId -> folders
  private calendarEvents = new Map<string, CalendarEvent[]>(); // accountId:calendarId -> events
  private calendars = new Map<string, Calendar[]>(); // accountId -> calendars
  private contacts = new Map<string, Contact[]>(); // accountId -> contacts

  // Account management
  async getAccount(id: string): Promise<Account | null> {
    return this.accounts.get(id) || null;
  }

  async listAccounts(): Promise<Account[]> {
    return Array.from(this.accounts.values());
  }

  async saveAccount(account: Account): Promise<void> {
    this.accounts.set(account.id, { ...account });
  }

  async deleteAccount(id: string): Promise<void> {
    this.accounts.delete(id);
    this.credentials.delete(id);
    this.syncStates.delete(id);
    this.mailMessages.delete(id);
    this.mailFolders.delete(id);
    this.calendarEvents.delete(id);
    this.calendars.delete(id);
    this.contacts.delete(id);
  }

  async updateAccount(id: string, updates: Partial<Account>): Promise<void> {
    const existing = this.accounts.get(id);
    if (!existing) throw new Error('Account not found');
    this.accounts.set(id, { ...existing, ...updates });
  }

  // Credentials
  async getCredentials(accountId: string): Promise<AccountCredentials | null> {
    return this.credentials.get(accountId) || null;
  }

  async saveCredentials(accountId: string, creds: AccountCredentials): Promise<void> {
    this.credentials.set(accountId, { ...creds });
  }

  async updateCredentials(accountId: string, updates: Partial<AccountCredentials>): Promise<void> {
    const existing = this.credentials.get(accountId);
    if (!existing) throw new Error('Account not found');
    this.credentials.set(accountId, { ...existing, ...updates });
  }

  // Sync state
  async getSyncState(accountId: string): Promise<SyncState | null> {
    return this.syncStates.get(accountId) || null;
  }

  async saveSyncState(state: SyncState): Promise<void> {
    this.syncStates.set(state.accountId, { ...state });
  }

  // Settings
  async getSettings(): Promise<Settings> {
    return { ...this.settings };
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.settings = { ...settings };
  }

  // OAuth state
  async saveOAuthState(state: string, data: OAuthStateData): Promise<void> {
    this.oauthStates.set(state, { ...data });
  }

  async getOAuthState(state: string): Promise<OAuthStateData | null> {
    return this.oauthStates.get(state) || null;
  }

  async deleteOAuthState(state: string): Promise<void> {
    this.oauthStates.delete(state);
  }

  // Mail metadata
  async saveMailMessages(accountId: string, messages: EmailMessage[]): Promise<void> {
    this.mailMessages.set(accountId, messages.map(m => ({ ...m })));
  }

  async getMailMessages(accountId: string, folderId: string, limit: number, cursor?: string): Promise<EmailMessage[]> {
    const messages = this.mailMessages.get(accountId) || [];
    let filtered = messages.filter(m => m.labelsOrFolders.includes(folderId));
    
    if (cursor) {
      const cursorTime = parseInt(cursor, 10);
      filtered = filtered.filter(m => m.date < cursorTime);
    }

    filtered.sort((a, b) => b.date - a.date);
    return filtered.slice(0, limit).map(m => ({ ...m }));
  }

  async saveMailFolders(accountId: string, folders: MailFolder[]): Promise<void> {
    this.mailFolders.set(accountId, folders.map(f => ({ ...f })));
  }

  async getMailFolders(accountId: string): Promise<MailFolder[]> {
    return (this.mailFolders.get(accountId) || []).map(f => ({ ...f }));
  }

  // Calendar metadata
  async saveCalendarEvents(accountId: string, calendarId: string, events: CalendarEvent[]): Promise<void> {
    const key = `${accountId}:${calendarId}`;
    this.calendarEvents.set(key, events.map(e => ({ ...e })));
  }

  async getCalendarEvents(accountId: string, calendarId: string, timeMin: number, timeMax: number): Promise<CalendarEvent[]> {
    const key = `${accountId}:${calendarId}`;
    const events = this.calendarEvents.get(key) || [];
    return events
      .filter(e => e.endAt >= timeMin && e.startAt <= timeMax)
      .sort((a, b) => a.startAt - b.startAt)
      .map(e => ({ ...e }));
  }

  async saveCalendars(accountId: string, calendarsList: Calendar[]): Promise<void> {
    this.calendars.set(accountId, calendarsList.map(c => ({ ...c })));
  }

  async getCalendars(accountId: string): Promise<Calendar[]> {
    return (this.calendars.get(accountId) || []).map(c => ({ ...c }));
  }

  // Contacts metadata
  async saveContacts(accountId: string, contactsList: Contact[]): Promise<void> {
    this.contacts.set(accountId, contactsList.map(c => ({ ...c })));
  }

  async getContacts(accountId: string, limit: number, cursor?: string): Promise<Contact[]> {
    const contactsList = this.contacts.get(accountId) || [];
    let filtered = contactsList;
    
    if (cursor) {
      filtered = filtered.filter(c => c.id > cursor);
    }

    return filtered.slice(0, limit).map(c => ({ ...c }));
  }

  async searchContacts(accountId: string, query: string, limit: number): Promise<Contact[]> {
    const contactsList = this.contacts.get(accountId) || [];
    const lowerQuery = query.toLowerCase();
    return contactsList
      .filter(c => 
        c.displayName.toLowerCase().includes(lowerQuery) ||
        c.emails.some(e => e.email.toLowerCase().includes(lowerQuery))
      )
      .slice(0, limit)
      .map(c => ({ ...c }));
  }

  // Health & close
  async healthCheck(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No-op for memory storage
  }

  // Test helpers
  clear(): void {
    this.accounts.clear();
    this.credentials.clear();
    this.syncStates.clear();
    this.settings = { updatedAt: 0 };
    this.oauthStates.clear();
    this.mailMessages.clear();
    this.mailFolders.clear();
    this.calendarEvents.clear();
    this.calendars.clear();
    this.contacts.clear();
  }
}