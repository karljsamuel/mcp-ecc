import { DatabaseSync } from 'node:sqlite';
import { StorageAdapter, User, Account, OAuthClient, AccountCredentials, SyncState, Settings, EmailMessage, MailFolder, CalendarEvent, Calendar, Contact, OAuthStateData } from '@mcp-ecc/core';
import CryptoJS from 'crypto-js';

export class SQLiteStorage implements StorageAdapter {
  private db: DatabaseSync;
  private encryptionKey: string;

  constructor(dbPath: string, encryptionKey = 'default-secret-key') {
    this.encryptionKey = encryptionKey;
    this.db = new DatabaseSync(dbPath);
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        displayName TEXT NOT NULL,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL,
        mcpApiKey TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT,
        slug TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL,
        credentials TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(ownerId, slug)
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        clientId TEXT NOT NULL,
        clientSecret TEXT NOT NULL,
        scopes TEXT NOT NULL,
        tenantId TEXT,
        accountsServer TEXT,
        clientType TEXT,
        enabled INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_states (
        accountId TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
    // Migration for existing databases created before clientType existed
    const cols = this.db.prepare(`PRAGMA table_info(oauth_clients)`).all() as any[];
    if (!cols.some((c: any) => c.name === 'clientType')) {
      this.db.exec(`ALTER TABLE oauth_clients ADD COLUMN clientType TEXT`);
    }
  }

  private encrypt(text: string): string {
    return CryptoJS.AES.encrypt(text, this.encryptionKey).toString();
  }

  private decrypt(ciphertext: string): string {
    const bytes = CryptoJS.AES.decrypt(ciphertext, this.encryptionKey);
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  // --- Account management ---
  async getAccount(id: string): Promise<Account | null> {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE id = ?');
    const row: any = stmt.get(id);
    return row ? this.mapAccount(row) : null;
  }

  async listAccounts(ownerId?: string): Promise<Account[]> {
    if (ownerId) {
      const stmt = this.db.prepare('SELECT * FROM accounts WHERE ownerId = ? ORDER BY createdAt DESC');
      const rows = stmt.all(ownerId) as any[];
      return rows.map(r => this.mapAccount(r));
    }
    const stmt = this.db.prepare('SELECT * FROM accounts ORDER BY createdAt DESC');
    const rows = stmt.all() as any[];
    return rows.map(r => this.mapAccount(r));
  }

  async getAccountBySlug(slug: string, ownerId: string): Promise<Account | null> {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE slug = ? AND ownerId = ?');
    const row: any = stmt.get(slug, ownerId);
    return row ? this.mapAccount(row) : null;
  }

  async saveAccount(account: Account): Promise<void> {
    const encCreds = this.encrypt(JSON.stringify(account.credentials || {}));
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO accounts (id, ownerId, provider, name, slug, email, status, credentials, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      account.id,
      account.ownerId,
      account.provider,
      account.name || null,
      account.slug,
      account.email,
      account.status,
      encCreds,
      account.createdAt,
      account.updatedAt
    );
  }

  async deleteAccount(id: string): Promise<void> {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM sync_states WHERE accountId = ?').run(id);
  }

  async updateAccount(id: string, updates: Partial<Account>): Promise<void> {
    const acc = await this.getAccount(id);
    if (!acc) throw new Error('Account not found');
    const merged = { ...acc, ...updates, updatedAt: Date.now() };
    await this.saveAccount(merged);
  }

  private mapAccount(row: any): Account {
    let credentials: AccountCredentials = {};
    try {
      credentials = JSON.parse(this.decrypt(row.credentials));
    } catch {}
    return {
      id: row.id,
      ownerId: row.ownerId,
      provider: row.provider,
      name: row.name || undefined,
      slug: row.slug,
      email: row.email,
      status: row.status,
      health: 'unknown',
      credentials,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // --- OAuth clients ---
  async saveOAuthClient(client: OAuthClient): Promise<void> {
    const encSecret = this.encrypt(client.clientSecret);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_clients (id, ownerId, provider, label, clientId, clientSecret, scopes, tenantId, accountsServer, clientType, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      client.id,
      client.ownerId,
      client.provider,
      client.label,
      client.clientId,
      encSecret,
      JSON.stringify(client.scopes),
      client.tenantId || null,
      client.accountsServer || null,
      client.clientType || null,
      client.enabled ? 1 : 0,
      client.createdAt,
      client.updatedAt
    );
  }

  async getOAuthClient(id: string): Promise<OAuthClient | null> {
    const stmt = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?');
    const row: any = stmt.get(id);
    return row ? this.mapOAuthClient(row) : null;
  }

  async listOAuthClients(ownerId: string): Promise<OAuthClient[]> {
    const stmt = this.db.prepare('SELECT * FROM oauth_clients WHERE ownerId = ? ORDER BY createdAt DESC');
    const rows = stmt.all(ownerId) as any[];
    return rows.map(r => this.mapOAuthClient(r));
  }

  async deleteOAuthClient(id: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_clients WHERE id = ?').run(id);
  }

  private mapOAuthClient(row: any): OAuthClient {
    let clientSecret = '';
    try {
      clientSecret = this.decrypt(row.clientSecret);
    } catch {}
    let scopes: string[] = [];
    try {
      scopes = JSON.parse(row.scopes);
    } catch {}
    return {
      id: row.id,
      ownerId: row.ownerId,
      provider: row.provider,
      label: row.label,
      clientId: row.clientId,
      clientSecret,
      scopes,
      tenantId: row.tenantId || undefined,
      accountsServer: row.accountsServer || undefined,
      clientType: row.clientType || undefined,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // --- Users ---
  async saveUser(user: User): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users (id, username, displayName, passwordHash, role, mcpApiKey, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.username,
      user.displayName,
      user.passwordHash,
      user.role,
      user.mcpApiKey || null,
      user.createdAt,
      user.updatedAt
    );
  }

  async getUser(id: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    const row: any = stmt.get(id);
    return row ? this.mapUser(row) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    const row: any = stmt.get(username);
    return row ? this.mapUser(row) : null;
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE mcpApiKey = ?');
    const row: any = stmt.get(apiKey);
    return row ? this.mapUser(row) : null;
  }

  async listUsers(): Promise<User[]> {
    const stmt = this.db.prepare('SELECT * FROM users ORDER BY createdAt ASC');
    const rows = stmt.all() as any[];
    return rows.map(r => this.mapUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<void> {
    const user = await this.getUser(id);
    if (!user) throw new Error('User not found');
    const merged = { ...user, ...updates, updatedAt: Date.now() };
    await this.saveUser(merged);
  }

  async deleteUser(id: string): Promise<void> {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM accounts WHERE ownerId = ?').run(id);
    this.db.prepare('DELETE FROM oauth_clients WHERE ownerId = ?').run(id);
  }

  async countUsers(): Promise<number> {
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM users');
    const row: any = stmt.get();
    return row.cnt;
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      passwordHash: row.passwordHash,
      role: row.role,
      mcpApiKey: row.mcpApiKey || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // --- Credentials ---
  async getCredentials(accountId: string): Promise<AccountCredentials | null> {
    const acc = await this.getAccount(accountId);
    return acc ? acc.credentials || null : null;
  }

  async saveCredentials(accountId: string, credentials: AccountCredentials): Promise<void> {
    await this.updateCredentials(accountId, credentials);
  }

  async updateCredentials(accountId: string, updates: Partial<AccountCredentials>): Promise<void> {
    const acc = await this.getAccount(accountId);
    if (!acc) throw new Error('Account not found');
    acc.credentials = { ...acc.credentials, ...updates };
    acc.updatedAt = Date.now();
    await this.saveAccount(acc);
  }

  // --- Sync state ---
  async getSyncState(accountId: string): Promise<SyncState | null> {
    const stmt = this.db.prepare('SELECT data FROM sync_states WHERE accountId = ?');
    const row: any = stmt.get(accountId);
    return row ? JSON.parse(row.data) : null;
  }

  async saveSyncState(state: SyncState): Promise<void> {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO sync_states (accountId, data) VALUES (?, ?)');
    stmt.run(state.accountId, JSON.stringify(state));
  }

  // --- Settings ---
  async getSettings(): Promise<Settings> {
    const stmt = this.db.prepare('SELECT data FROM settings WHERE id = ?');
    const row: any = stmt.get('global');
    return row ? JSON.parse(row.data) : { updatedAt: Date.now() };
  }

  async saveSettings(settings: Settings): Promise<void> {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (?, ?)');
    stmt.run('global', JSON.stringify({ ...settings, updatedAt: Date.now() }));
  }

  // --- OAuth state ---
  async saveOAuthState(state: string, data: OAuthStateData): Promise<void> {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO oauth_states (state, data) VALUES (?, ?)');
    stmt.run(state, JSON.stringify(data));
  }

  async getOAuthState(state: string): Promise<OAuthStateData | null> {
    const stmt = this.db.prepare('SELECT data FROM oauth_states WHERE state = ?');
    const row: any = stmt.get(state);
    return row ? JSON.parse(row.data) : null;
  }

  async deleteOAuthState(state: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  }

  // --- Mail metadata ---
  async saveMailMessages(accountId: string, messages: EmailMessage[]): Promise<void> {}
  async getMailMessages(accountId: string, folderId: string, limit: number, cursor?: string): Promise<EmailMessage[]> { return []; }
  async saveMailFolders(accountId: string, folders: MailFolder[]): Promise<void> {}
  async getMailFolders(accountId: string): Promise<MailFolder[]> { return []; }

  // --- Calendar metadata ---
  async saveCalendarEvents(accountId: string, calendarId: string, events: CalendarEvent[]): Promise<void> {}
  async getCalendarEvents(accountId: string, calendarId: string, timeMin: number, timeMax: number): Promise<CalendarEvent[]> { return []; }
  async saveCalendars(accountId: string, calendars: Calendar[]): Promise<void> {}
  async getCalendars(accountId: string): Promise<Calendar[]> { return []; }

  // --- Contacts metadata ---
  async saveContacts(accountId: string, contacts: Contact[]): Promise<void> {}
  async getContacts(accountId: string, limit: number, cursor?: string): Promise<Contact[]> { return []; }
  async searchContacts(accountId: string, query: string, limit: number): Promise<Contact[]> { return []; }

  // --- Health/check ---
  async healthCheck(): Promise<boolean> {
    try {
      const stmt = this.db.prepare('SELECT 1');
      stmt.get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
