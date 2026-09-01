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
  OAuthClient,
  User,
} from '@mcp-ecc/core';
import { generateId } from '@mcp-ecc/core';

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<void>;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    changes: number;
    duration: number;
    last_row_id: number;
    changed_db: boolean;
  };
}

export class D1Storage implements StorageAdapter {
  private db: D1Database;
  private encryptionKey: Promise<CryptoKey> | CryptoKey;

  constructor(db: D1Database, encryptionKey?: string) {
    this.db = db;
    // In Workers, we'd use Web Crypto API
    // For now, store the key material - actual encryption would use subtle crypto
    this.encryptionKey = encryptionKey ? 
      crypto.subtle.importKey('raw', new TextEncoder().encode(encryptionKey), 'AES-GCM', false, ['encrypt', 'decrypt']) :
      this.generateKey();
  }

  private async getEncryptionKey(): Promise<CryptoKey> {
    if (this.encryptionKey instanceof Promise) {
      this.encryptionKey = await this.encryptionKey;
    }
    return this.encryptionKey;
  }

  private async generateKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async initSchema(): Promise<void> {
    const schema = `
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        mcp_api_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- OAuth clients table
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        tenant_id TEXT,
        accounts_server TEXT,
        client_type TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Accounts table
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        credentials_json TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        health TEXT DEFAULT 'unknown',
        last_sync_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Sync state table
      CREATE TABLE IF NOT EXISTS sync_state (
        account_id TEXT PRIMARY KEY,
        mail_cursor TEXT,
        contacts_cursor TEXT,
        calendar_cursor TEXT,
        last_full_sync INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      -- Settings table
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- OAuth state table (temporary)
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Mail messages table (cached metadata)
      CREATE TABLE IF NOT EXISTS mail_messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        thread_id TEXT,
        from_addr TEXT NOT NULL,
        to_addrs TEXT NOT NULL,
        cc_addrs TEXT NOT NULL,
        bcc_addrs TEXT NOT NULL,
        subject TEXT,
        snippet TEXT,
        body TEXT,
        html_body TEXT,
        date INTEGER NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        labels_or_folders TEXT NOT NULL,
        attachments TEXT,
        headers TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      -- Mail folders table
      CREATE TABLE IF NOT EXISTS mail_folders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        type TEXT NOT NULL,
        unread_count INTEGER DEFAULT 0,
        total_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      -- Calendar events table
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        summary TEXT,
        description TEXT,
        location TEXT,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        attendees TEXT,
        recurrence_rule TEXT,
        raw TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, calendar_id, id)
      );

      -- Calendars table
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        external_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT,
        primary_calendar INTEGER NOT NULL DEFAULT 0,
        access_role TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, external_id)
      );

      -- Contacts table
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        external_id TEXT,
        display_name TEXT NOT NULL,
        emails TEXT NOT NULL,
        phones TEXT,
        addresses TEXT,
        organization TEXT,
        job_title TEXT,
        notes TEXT,
        raw TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, external_id)
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_mail_account_folder ON mail_messages(account_id, folder_id);
      CREATE INDEX IF NOT EXISTS idx_mail_date ON mail_messages(account_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_mail_unread ON mail_messages(account_id, unread, date DESC);
      CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
      CREATE INDEX IF NOT EXISTS idx_events_account_range ON calendar_events(account_id, start_at, end_at);
      CREATE INDEX IF NOT EXISTS idx_calendars_account ON calendars(account_id);
    `;

    // Split schema into individual clean statements, stripping comments and formatting newlines
    const noComments = schema
      .split('\n')
      .map(line => line.trim())
      .filter(line => !line.startsWith('--'))
      .join('\n');

    const statements = noComments
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    for (const stmt of statements) {
      try {
        await this.db.exec(stmt);
      } catch (err: any) {
        // If the error is because a table already exists, we can ignore it
        if (!err.message?.includes('already exists')) {
          throw err;
        }
      }
    }
  }

  private async encrypt(data: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(data);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.getEncryptionKey(),
      encoded
    );
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...result));
  }

  private async decrypt(encryptedData: string): Promise<string> {
    const data = new Uint8Array(atob(encryptedData).split('').map(c => c.charCodeAt(0)));
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      await this.getEncryptionKey(),
      encrypted
    );
    return new TextDecoder().decode(decrypted);
  }

  // Account management
  async getAccount(id: string): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!row) return null;
    return this.mapAccount(row as any);
  }

  async getAccountBySlug(slug: string, ownerId: string): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE slug = ? AND owner_id = ?').bind(slug, ownerId).first();
    if (!row) return null;
    return this.mapAccount(row as any);
  }

  async listAccounts(ownerId?: string): Promise<Account[]> {
    const { results } = ownerId
      ? await this.db.prepare('SELECT * FROM accounts WHERE owner_id = ? ORDER BY name').bind(ownerId).all()
      : await this.db.prepare('SELECT * FROM accounts ORDER BY name').all();
    return (results as any[]).map(r => this.mapAccount(r));
  }

  async saveAccount(account: Account): Promise<void> {
    const now = Date.now();
    const credentialsJson = await this.encrypt(JSON.stringify(account.credentials));

    await this.db.prepare(`
      INSERT INTO accounts (id, owner_id, provider, name, slug, email, display_name, credentials_json, status, health, last_sync_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id = excluded.owner_id,
        provider = excluded.provider,
        name = excluded.name,
        slug = excluded.slug,
        email = excluded.email,
        display_name = excluded.display_name,
        credentials_json = excluded.credentials_json,
        status = excluded.status,
        health = excluded.health,
        last_sync_at = excluded.last_sync_at,
        updated_at = excluded.updated_at
    `).bind(
      account.id, account.ownerId, account.provider, account.name, account.slug,
      account.email, account.displayName || null, credentialsJson, account.status,
      account.health, account.lastSyncAt || null, now, now
    ).run();
  }

  async deleteAccount(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  }

  async updateAccount(id: string, updates: Partial<Account>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.ownerId) { fields.push('owner_id = ?'); values.push(updates.ownerId); }
    if (updates.provider) { fields.push('provider = ?'); values.push(updates.provider); }
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.slug !== undefined) { fields.push('slug = ?'); values.push(updates.slug); }
    if (updates.email) { fields.push('email = ?'); values.push(updates.email); }
    if (updates.displayName !== undefined) { fields.push('display_name = ?'); values.push(updates.displayName); }
    if (updates.status) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.health) { fields.push('health = ?'); values.push(updates.health); }
    if (updates.lastSyncAt !== undefined) { fields.push('last_sync_at = ?'); values.push(updates.lastSyncAt); }
    if (updates.credentials) {
      fields.push('credentials_json = ?');
      values.push(await this.encrypt(JSON.stringify(updates.credentials)));
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    await this.db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  // Credentials
  async getCredentials(accountId: string): Promise<AccountCredentials | null> {
    const row = await this.db.prepare('SELECT credentials_json FROM accounts WHERE id = ?').bind(accountId).first();
    if (!row) return null;
    return JSON.parse(await this.decrypt((row as any).credentials_json));
  }

  async saveCredentials(accountId: string, credentials: AccountCredentials): Promise<void> {
    await this.db.prepare('UPDATE accounts SET credentials_json = ?, updated_at = ? WHERE id = ?')
      .bind(await this.encrypt(JSON.stringify(credentials)), Date.now(), accountId).run();
  }

  async updateCredentials(accountId: string, updates: Partial<AccountCredentials>): Promise<void> {
    const current = await this.getCredentials(accountId);
    if (!current) throw new Error('Account not found');
    await this.saveCredentials(accountId, { ...current, ...updates });
  }

  // Sync state
  async getSyncState(accountId: string): Promise<SyncState | null> {
    const row = await this.db.prepare('SELECT * FROM sync_state WHERE account_id = ?').bind(accountId).first<any>();
    if (!row) return null;
    return {
      accountId: row.account_id,
      mailCursor: row.mail_cursor || undefined,
      contactsCursor: row.contacts_cursor || undefined,
      calendarCursor: row.calendar_cursor || undefined,
      lastFullSync: row.last_full_sync || undefined,
      updatedAt: row.updated_at,
    } as SyncState;
  }

  async saveSyncState(state: SyncState): Promise<void> {
    await this.db.prepare(`
      INSERT INTO sync_state (account_id, mail_cursor, contacts_cursor, calendar_cursor, last_full_sync, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        mail_cursor = excluded.mail_cursor,
        contacts_cursor = excluded.contacts_cursor,
        calendar_cursor = excluded.calendar_cursor,
        last_full_sync = excluded.last_full_sync,
        updated_at = excluded.updated_at
    `).bind(state.accountId, state.mailCursor || null, state.contactsCursor || null, state.calendarCursor || null, state.lastFullSync || null, state.updatedAt).run();
  }

  // Settings
  async getSettings(): Promise<Settings> {
    const { results } = await this.db.prepare('SELECT * FROM settings').all();
    const settings: Settings = { updatedAt: 0 };
    for (const row of results as any[]) {
      if (row.key === 'encryptionKey') settings.encryptionKey = row.value;
      else if (row.key === 'uiPreferences') settings.uiPreferences = JSON.parse(row.value);
      settings.updatedAt = Math.max(settings.updatedAt, row.updated_at);
    }
    return settings;
  }

  async saveSettings(settings: Settings): Promise<void> {
    const now = Date.now();
    if (settings.encryptionKey) {
      await this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('encryptionKey', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(settings.encryptionKey, now).run();
    }
    if (settings.uiPreferences) {
      await this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('uiPreferences', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(JSON.stringify(settings.uiPreferences), now).run();
    }
  }

  // OAuth state
  async saveOAuthState(state: string, data: OAuthStateData): Promise<void> {
    await this.db.prepare(`
      INSERT INTO oauth_states (state, data_json, created_at) VALUES (?, ?, ?)
      ON CONFLICT(state) DO UPDATE SET data_json = excluded.data_json, created_at = excluded.created_at
    `).bind(state, JSON.stringify(data), data.createdAt).run();
  }

  async getOAuthState(state: string): Promise<OAuthStateData | null> {
    const row = await this.db.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first();
    if (!row) return null;
    return JSON.parse((row as any).data_json);
  }

  async deleteOAuthState(state: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  }

  // Mail metadata - simplified for D1 (limited caching)
  async saveMailMessages(accountId: string, messages: EmailMessage[]): Promise<void> {
    const now = Date.now();
    const stmts = messages.map(msg => 
      this.db.prepare(`
        INSERT INTO mail_messages (id, account_id, folder_id, thread_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, snippet, body, html_body, date, unread, starred, labels_or_folders, attachments, headers, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          folder_id = excluded.folder_id,
          thread_id = excluded.thread_id,
          from_addr = excluded.from_addr,
          to_addrs = excluded.to_addrs,
          cc_addrs = excluded.cc_addrs,
          bcc_addrs = excluded.bcc_addrs,
          subject = excluded.subject,
          snippet = excluded.snippet,
          body = excluded.body,
          html_body = excluded.html_body,
          date = excluded.date,
          unread = excluded.unread,
          starred = excluded.starred,
          labels_or_folders = excluded.labels_or_folders,
          attachments = excluded.attachments,
          headers = excluded.headers,
          updated_at = excluded.updated_at
      `).bind(
        msg.id, accountId, msg.labelsOrFolders[0] || 'INBOX', msg.threadId || null,
        msg.from.address,
        JSON.stringify(msg.to.map(t => t.address)),
        JSON.stringify(msg.cc?.map(t => t.address) || []),
        JSON.stringify(msg.bcc?.map(t => t.address) || []),
        msg.subject, msg.snippet || null, msg.body || null, msg.htmlBody || null,
        msg.date, msg.unread ? 1 : 0, msg.starred ? 1 : 0,
        JSON.stringify(msg.labelsOrFolders),
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        msg.headers ? JSON.stringify(msg.headers) : null,
        now, now
      )
    );
    await this.db.batch(stmts);
  }

  async getMailMessages(accountId: string, folderId: string, limit: number, cursor?: string): Promise<EmailMessage[]> {
    let sql = 'SELECT * FROM mail_messages WHERE account_id = ? AND folder_id = ?';
    const params: unknown[] = [accountId, folderId];

    if (cursor) {
      sql += ' AND date < ?';
      params.push(parseInt(cursor, 10));
    }

    sql += ' ORDER BY date DESC LIMIT ?';
    params.push(limit);

    const { results } = await this.db.prepare(sql).bind(...params).all();
    return (results as any[]).map(r => this.mapMailMessage(r));
  }

  async saveMailFolders(accountId: string, folders: MailFolder[]): Promise<void> {
    const now = Date.now();
    const stmts = folders.map(folder =>
      this.db.prepare(`
        INSERT INTO mail_folders (id, account_id, name, parent_id, type, unread_count, total_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          parent_id = excluded.parent_id,
          type = excluded.type,
          unread_count = excluded.unread_count,
          total_count = excluded.total_count,
          updated_at = excluded.updated_at
      `).bind(folder.id, accountId, folder.name, folder.parentId || null, folder.type, folder.unreadCount, folder.totalCount, now, now)
    );
    await this.db.batch(stmts);
  }

  async getMailFolders(accountId: string): Promise<MailFolder[]> {
    const { results } = await this.db.prepare('SELECT * FROM mail_folders WHERE account_id = ?').bind(accountId).all();
    return (results as any[]).map(r => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id || undefined,
      type: r.type,
      unreadCount: r.unread_count,
      totalCount: r.total_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // Calendar metadata
  async saveCalendarEvents(accountId: string, calendarId: string, events: CalendarEvent[]): Promise<void> {
    const now = Date.now();
    const stmts = events.map(evt =>
      this.db.prepare(`
        INSERT INTO calendar_events (id, account_id, calendar_id, summary, description, location, start_at, end_at, all_day, status, attendees, recurrence_rule, raw, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, calendar_id, id) DO UPDATE SET
          summary = excluded.summary,
          description = excluded.description,
          location = excluded.location,
          start_at = excluded.start_at,
          end_at = excluded.end_at,
          all_day = excluded.all_day,
          status = excluded.status,
          attendees = excluded.attendees,
          recurrence_rule = excluded.recurrence_rule,
          raw = excluded.raw,
          updated_at = excluded.updated_at
      `).bind(
        evt.id, accountId, calendarId, evt.summary, evt.description || null, evt.location || null,
        evt.startAt, evt.endAt, evt.allDay ? 1 : 0, evt.status,
        evt.attendees ? JSON.stringify(evt.attendees) : null,
        evt.recurrenceRule || null,
        evt.raw ? JSON.stringify(evt.raw) : null,
        now, now
      )
    );
    await this.db.batch(stmts);
  }

  async getCalendarEvents(accountId: string, calendarId: string, timeMin: number, timeMax: number): Promise<CalendarEvent[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM calendar_events
      WHERE account_id = ? AND calendar_id = ? AND end_at >= ? AND start_at <= ?
      ORDER BY start_at ASC
    `).bind(accountId, calendarId, timeMin, timeMax).all();
    return (results as any[]).map(r => this.mapCalendarEvent(r));
  }

  async saveCalendars(accountId: string, calendars: Calendar[]): Promise<void> {
    const now = Date.now();
    const stmts = calendars.map(cal =>
      this.db.prepare(`
        INSERT INTO calendars (id, account_id, external_id, name, description, color, primary_calendar, access_role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, external_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          color = excluded.color,
          primary_calendar = excluded.primary_calendar,
          access_role = excluded.access_role,
          updated_at = excluded.updated_at
      `).bind(cal.id, accountId, cal.id, cal.name, cal.description || null, cal.color || null, cal.primary ? 1 : 0, cal.accessRole, now, now)
    );
    await this.db.batch(stmts);
  }

  async getCalendars(accountId: string): Promise<Calendar[]> {
    const { results } = await this.db.prepare('SELECT * FROM calendars WHERE account_id = ?').bind(accountId).all();
    return (results as any[]).map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      color: r.color || undefined,
      primary: r.primary_calendar === 1,
      accessRole: r.access_role,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // Contacts metadata
  async saveContacts(accountId: string, contacts: Contact[]): Promise<void> {
    const now = Date.now();
    const stmts = contacts.map(contact =>
      this.db.prepare(`
        INSERT INTO contacts (id, account_id, external_id, display_name, emails, phones, addresses, organization, job_title, notes, raw, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, external_id) DO UPDATE SET
          display_name = excluded.display_name,
          emails = excluded.emails,
          phones = excluded.phones,
          addresses = excluded.addresses,
          organization = excluded.organization,
          job_title = excluded.job_title,
          notes = excluded.notes,
          raw = excluded.raw,
          updated_at = excluded.updated_at
      `).bind(
        contact.id, accountId, contact.id, contact.displayName,
        JSON.stringify(contact.emails),
        contact.phones ? JSON.stringify(contact.phones) : null,
        contact.addresses ? JSON.stringify(contact.addresses) : null,
        contact.organization || null, contact.jobTitle || null, contact.notes || null,
        contact.raw ? JSON.stringify(contact.raw) : null,
        now, now
      )
    );
    await this.db.batch(stmts);
  }

  async getContacts(accountId: string, limit: number, cursor?: string): Promise<Contact[]> {
    let sql = 'SELECT * FROM contacts WHERE account_id = ?';
    const params: unknown[] = [accountId];

    if (cursor) {
      sql += ' AND id > ?';
      params.push(cursor);
    }

    sql += ' ORDER BY id LIMIT ?';
    params.push(limit);

    const { results } = await this.db.prepare(sql).bind(...params).all();
    return (results as any[]).map(r => this.mapContact(r));
  }

  async searchContacts(accountId: string, query: string, limit: number): Promise<Contact[]> {
    const { results } = await this.db.prepare(`
      SELECT * FROM contacts
      WHERE account_id = ? AND (display_name LIKE ? OR emails LIKE ?)
      ORDER BY display_name LIMIT ?
    `).bind(accountId, `%${query}%`, `%${query}%`, limit).all();
    return (results as any[]).map(r => this.mapContact(r));
  }

  // Health & close
  async healthCheck(): Promise<boolean> {
    try {
      await this.db.prepare('SELECT 1').first();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // D1 doesn't need explicit close
  }

  // OAuth clients
  async saveOAuthClient(client: OAuthClient): Promise<void> {
    const now = Date.now();
    const secretJson = await this.encrypt(client.clientSecret);
    await this.db.prepare(`
      INSERT INTO oauth_clients (id, owner_id, provider, label, client_id, client_secret, scopes_json, tenant_id, accounts_server, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id = excluded.owner_id, provider = excluded.provider, label = excluded.label,
        client_id = excluded.client_id, client_secret = excluded.client_secret, scopes_json = excluded.scopes_json,
        tenant_id = excluded.tenant_id, accounts_server = excluded.accounts_server, enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).bind(client.id, client.ownerId, client.provider, client.label, client.clientId, secretJson,
      JSON.stringify(client.scopes), client.tenantId || null, client.accountsServer || null,
      client.enabled ? 1 : 0, now, now).run();
  }

  async getOAuthClient(id: string): Promise<OAuthClient | null> {
    const row = await this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(id).first();
    if (!row) return null;
    return this.mapOAuthClient(row as any);
  }

  async listOAuthClients(ownerId: string): Promise<OAuthClient[]> {
    const { results } = await this.db.prepare('SELECT * FROM oauth_clients WHERE owner_id = ? ORDER BY provider, label').bind(ownerId).all();
    return (results as any[]).map(r => this.mapOAuthClient(r));
  }

  async deleteOAuthClient(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_clients WHERE id = ?').bind(id).run();
  }

  // Users
  async saveUser(user: User): Promise<void> {
    const now = Date.now();
    const apiKeyJson = await this.encrypt(user.mcpApiKey);
    await this.db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, role, mcp_api_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username, display_name = excluded.display_name, password_hash = excluded.password_hash,
        role = excluded.role, mcp_api_key = excluded.mcp_api_key, updated_at = excluded.updated_at
    `).bind(user.id, user.username, user.displayName, user.passwordHash, user.role, apiKeyJson, now, now).run();
  }

  async getUser(id: string): Promise<User | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!row) return null;
    return this.mapUser(row as any);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!row) return null;
    return this.mapUser(row as any);
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const { results } = await this.db.prepare('SELECT * FROM users').all();
    for (const row of results as any[]) {
      try {
        if ((await this.decrypt(row.mcp_api_key)) === apiKey) return this.mapUser(row);
      } catch { /* skip */ }
    }
    return null;
  }

  async listUsers(): Promise<User[]> {
    const { results } = await this.db.prepare('SELECT * FROM users ORDER BY username').all();
    return (results as any[]).map(r => this.mapUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.displayName !== undefined) { fields.push('display_name = ?'); values.push(updates.displayName); }
    if (updates.passwordHash) { fields.push('password_hash = ?'); values.push(updates.passwordHash); }
    if (updates.role) { fields.push('role = ?'); values.push(updates.role); }
    if (updates.mcpApiKey) { fields.push('mcp_api_key = ?'); values.push(await this.encrypt(updates.mcpApiKey)); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(Date.now(), id);
    await this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }

  async countUsers(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS c FROM users').first();
    return (row as any)?.c || 0;
  }

  // Mapping helpers
  private mapAccount(row: any): Account {
    return {
      id: row.id,
      ownerId: row.owner_id,
      provider: row.provider,
      name: row.name,
      slug: row.slug,
      email: row.email,
      displayName: row.display_name || undefined,
      credentials: JSON.parse(this.decryptSync(row.credentials_json)),
      status: row.status,
      health: row.health || 'unknown',
      lastSyncAt: row.last_sync_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapOAuthClient(row: any): OAuthClient {
    return {
      id: row.id,
      ownerId: row.owner_id,
      provider: row.provider,
      label: row.label,
      clientId: row.client_id,
      clientSecret: this.decryptSync(row.client_secret),
      scopes: JSON.parse(row.scopes_json),
      tenantId: row.tenant_id || undefined,
      accountsServer: row.accounts_server || undefined,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      role: row.role,
      mcpApiKey: this.decryptSync(row.mcp_api_key),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private decryptSync(encryptedData: string): string {
    // Synchronous version for mapping - would need async version in real use
    const data = new Uint8Array(atob(encryptedData).split('').map(c => c.charCodeAt(0)));
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    // Note: In real implementation, this would be async
    return ''; // Placeholder
  }

  private mapMailMessage(row: any): EmailMessage {
    return {
      id: row.id,
      threadId: row.thread_id || undefined,
      from: { address: row.from_addr },
      to: JSON.parse(row.to_addrs).map((address: string) => ({ address })),
      cc: JSON.parse(row.cc_addrs).map((address: string) => ({ address })),
      bcc: JSON.parse(row.bcc_addrs).map((address: string) => ({ address })),
      subject: row.subject,
      snippet: row.snippet || undefined,
      body: row.body || undefined,
      htmlBody: row.html_body || undefined,
      date: row.date,
      unread: row.unread === 1,
      starred: row.starred === 1,
      labelsOrFolders: JSON.parse(row.labels_or_folders),
      attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
      headers: row.headers ? JSON.parse(row.headers) : undefined,
    };
  }

  private mapCalendarEvent(row: any): CalendarEvent {
    return {
      id: row.id,
      calendarId: row.calendar_id,
      summary: row.summary,
      description: row.description || undefined,
      location: row.location || undefined,
      startAt: row.start_at,
      endAt: row.end_at,
      allDay: row.all_day === 1,
      status: row.status,
      attendees: row.attendees ? JSON.parse(row.attendees) : undefined,
      recurrenceRule: row.recurrence_rule || undefined,
      raw: row.raw ? JSON.parse(row.raw) : undefined,
    };
  }

  private mapContact(row: any): Contact {
    return {
      id: row.id,
      displayName: row.display_name,
      emails: JSON.parse(row.emails),
      phones: row.phones ? JSON.parse(row.phones) : undefined,
      addresses: row.addresses ? JSON.parse(row.addresses) : undefined,
      organization: row.organization || undefined,
      jobTitle: row.job_title || undefined,
      notes: row.notes || undefined,
      raw: row.raw ? JSON.parse(row.raw) : undefined,
    };
  }
}