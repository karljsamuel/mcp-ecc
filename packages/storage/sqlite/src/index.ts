import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { getEncryptionKey, PLACEHOLDER_ENCRYPTION_KEYS, StorageAdapter, User, Account, OAuthClient, AccountCredentials, SyncState, Settings, EmailMessage, MailFolder, CalendarEvent, Calendar, Contact, OAuthStateData } from '@mcp-ecc/core';
import { SCHEMA_MIGRATIONS, MIGRATION_LEDGER_SQL, READ_MIGRATIONS_SQL, RECORD_MIGRATION_SQL, migrationColumns } from '@mcp-ecc/core';
import { decrypt, encrypt, EncryptionError } from './crypto.js';

// A master key that is absent or equal to a well-known placeholder must never be
// used: it would encrypt real credentials under a publicly documented constant.
const PLACEHOLDER_KEYS = PLACEHOLDER_ENCRYPTION_KEYS;

// Additional constructor argument for keys retired by a rotation. Old rows stay
// readable while their generation is still in the keyring.
const PREVIOUS_KEYS_VAR = 'MCP_ENCRYPTION_KEY_PREVIOUS';
// Optional explicit label for the current key. Needed to drop a retired key after
// every row has been rotated onto the current generation.
const GENERATION_VAR = 'MCP_ENCRYPTION_KEY_GENERATION';

function assertUsableMasterKey(key: string | undefined, label: string): string {
  const trimmed = key?.trim();
  if (!trimmed || PLACEHOLDER_KEYS.has(trimmed.toLowerCase())) {
    throw new EncryptionError(
      `Refusing to start: ${label} is missing or is a placeholder. Set MCP_ENCRYPTION_KEY (generate with: openssl rand -hex 32).`,
    );
  }
  return trimmed;
}

/**
 * Retired keys, addressed by the generation they served. Explicit numbering (not
 * array position) is what makes a generation stable: a retired key can be dropped
 * from the configuration once every row has been rotated off it, without
 * renumbering the rows that remain.
 */
export type RetiredKeys = Record<number, string>;

/**
 * Parses `MCP_ENCRYPTION_KEY_PREVIOUS`, a comma/whitespace separated list of
 * `<generation>:<key>` pairs, e.g. "1:9f2c...,2:41ab...". Key material is never
 * echoed back in an error message.
 */
function parseRetiredKeys(raw: string): RetiredKeys {
  const keys: RetiredKeys = {};
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const separator = entries[index].indexOf(':');
    const generation = Number(entries[index].slice(0, separator));
    const key = entries[index].slice(separator + 1);
    if (separator < 1 || !Number.isInteger(generation) || generation < 1 || !key) {
      throw new EncryptionError(`MCP_ENCRYPTION_KEY_PREVIOUS entry ${index + 1} is not a "<generation>:<key>" pair`);
    }
    keys[generation] = assertUsableMasterKey(key, `the retired credential encryption key for generation ${generation}`);
  }
  return keys;
}

/**
 * Builds the generation -> key map. The current key sits at `currentGeneration`,
 * which defaults to one past the highest retired generation; pass it explicitly
 * (or set MCP_ENCRYPTION_KEY_GENERATION) once every row has been rotated so a
 * retired key can be dropped without renumbering the rows it left behind.
 */
function resolveKeyring(encryptionKey?: string, retiredKeys: RetiredKeys = {}, currentGeneration?: number): { keys: Map<number, string>; generation: number } {
  const configured = Object.keys(retiredKeys).length > 0 ? retiredKeys : parseRetiredKeys(process.env[PREVIOUS_KEYS_VAR] || '');
  const keys = new Map<number, string>();
  for (const [generation, key] of Object.entries(configured)) {
    const number = Number(generation);
    if (!Number.isInteger(number) || number < 1) {
      throw new EncryptionError(`Retired encryption key generation '${generation}' is not a positive integer`);
    }
    keys.set(number, assertUsableMasterKey(key, `the retired credential encryption key for generation ${number}`));
  }

  // The current generation is explicit so that a retired key can be dropped once
  // every row has been rotated off it, without renumbering the remaining rows.
  const declared = currentGeneration ?? (process.env[GENERATION_VAR] ? Number(process.env[GENERATION_VAR]) : undefined);
  const generation = declared ?? (keys.size === 0 ? 1 : Math.max(...keys.keys()) + 1);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new EncryptionError(`${GENERATION_VAR} must be a positive integer`);
  }
  if (keys.has(generation)) {
    throw new EncryptionError(`Encryption key generation ${generation} is assigned to both the current key and a retired key`);
  }
  keys.set(generation, assertUsableMasterKey(encryptionKey ?? getEncryptionKey(), 'the credential encryption key'));
  return { keys, generation };
}

export class SQLiteStorage implements StorageAdapter {
  private db: DatabaseSync;
  private keys: Map<number, string>;
  private generation: number;

  constructor(dbPath: string, encryptionKey?: string, retiredKeys: RetiredKeys = {}, currentGeneration?: number) {
    const keyring = resolveKeyring(encryptionKey, retiredKeys, currentGeneration);
    this.keys = keyring.keys;
    this.generation = keyring.generation;
    this.db = new DatabaseSync(dbPath);
    try {
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** The key generation every new write uses. */
  get encryptionKeyGeneration(): number {
    return this.generation;
  }

  /** The generations this process can read; anything else is a hard error. */
  get readableKeyGenerations(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  private keyForGeneration(generation: number): string {
    const key = this.keys.get(generation);
    if (!key) {
      throw new EncryptionError(
        `No encryption key is configured for generation ${generation}; readable generations are [${this.readableKeyGenerations.join(', ')}]. ` +
        `Add it to MCP_ENCRYPTION_KEY_PREVIOUS as "${generation}:<key>" so this row stays readable.`,
      );
    }
    return key;
  }

  private currentMasterKey(): string {
    return this.keyForGeneration(this.encryptionKeyGeneration);
  }

  private encryptFor(text: string, ownerId: string): string {
    return encrypt(text, this.currentMasterKey(), ownerId);
  }

  /** Decrypts a blob for one owner, wrapping the reason into a record-naming error. */
  private decryptOrThrow(ciphertext: string, ownerId: string, generation: number, record: string): string {
    try {
      return decrypt(ciphertext, this.keyForGeneration(generation), ownerId);
    } catch (error) {
      throw new EncryptionError(
        `${record} could not be decrypted (owner '${ownerId}', key generation ${generation}). ` +
        `Refusing to return a blank value that a later save would overwrite.`,
        { cause: error },
      );
    }
  }

  /** For nullable secret columns: null/'' means "no secret stored", not a failure. */
  private decryptOptional(ciphertext: string | null | undefined, ownerId: string, generation: number | null | undefined, record: string): string | null {
    if (ciphertext === null || ciphertext === undefined || ciphertext === '') return null;
    return this.decryptOrThrow(ciphertext, ownerId, generation ?? 1, record);
  }

  /** For NOT NULL secret columns: a missing or empty value is corruption, not "no secret". */
  private decryptRequired(ciphertext: string | null | undefined, ownerId: string, generation: number | null | undefined, record: string): string {
    if (ciphertext === null || ciphertext === undefined || ciphertext === '') {
      throw new EncryptionError(`${record} is missing or empty, but the column is NOT NULL: this row is corrupt.`);
    }
    return this.decryptOrThrow(ciphertext, ownerId, generation ?? 1, record);
  }

  /** Synchronous for constructor compatibility; safe to call again at startup. */
  initSchema(): void {
    this.db.exec(MIGRATION_LEDGER_SQL);
    for (const migration of SCHEMA_MIGRATIONS) {
      // Lock before reading the ledger so concurrent SQLite startups serialize.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const applied = this.db.prepare(READ_MIGRATIONS_SQL).all() as { version: number }[];
        if (!applied.some(row => row.version === migration.version)) {
          // Add columns first, then run statements (some statements may depend on new columns)
          for (const column of migrationColumns(migration, 'sqlite')) {
            this.ensureColumn(column.table, column.name, column.definition);
          }
          for (const sql of migration.statements?.('sqlite') || []) this.db.exec(sql);
          this.db.prepare(RECORD_MIGRATION_SQL).run(migration.version, migration.name, Date.now());
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(`SQLite schema migration ${migration.version} (${migration.name}) failed`, { cause: error });
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(existing => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // --- Key rotation ---

  /**
   * Re-encrypts every credential still held at an older key generation using the
   * current one, in batches of `batchSize`. Interruptible and re-runnable:
   * already-current rows are skipped and each rewrite is guarded so a concurrent
   * writer is never clobbered. Both generations stay readable throughout, so a
   * changeover needs no downtime. Returns the number of values rewritten.
   */
  rotateEncryptionKeys(batchSize = 100): number {
    const target = this.encryptionKeyGeneration;
    const columns = [
      { table: 'accounts', owner: 'ownerId', cipher: 'credentials', generation: 'encryptionKeyGeneration', record: 'accounts.credentials' },
      { table: 'oauth_clients', owner: 'ownerId', cipher: 'clientSecret', generation: 'encryptionKeyGeneration', record: 'oauth_clients.clientSecret' },
      { table: 'users', owner: 'id', cipher: 'mcpApiKey', generation: 'encryptionKeyGeneration', record: 'users.mcpApiKey' },
    ];
    let rotated = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const column of columns) {
        for (;;) {
          const rows = this.db.prepare(
            `SELECT id AS id, ${column.owner} AS owner, ${column.cipher} AS cipher, ${column.generation} AS generation
             FROM ${column.table} WHERE ${column.generation} < ? ORDER BY id LIMIT ?`,
          ).all(target, batchSize) as any[];
          if (rows.length === 0) break;
          let progressed = 0;
          for (const row of rows) {
            if (!row.cipher) {
              this.db.prepare(`UPDATE ${column.table} SET ${column.generation} = ? WHERE id = ?`).run(target, row.id);
              progressed += 1;
              continue;
            }
            const generation = row.generation ?? 1;
            const plaintext = this.decryptOrThrow(row.cipher, row.owner, generation, `${column.record} for '${row.id}' during rotation`);
            const result = this.db.prepare(
              `UPDATE ${column.table} SET ${column.cipher} = ?, ${column.generation} = ? WHERE id = ? AND ${column.cipher} = ?`,
            ).run(encrypt(plaintext, this.currentMasterKey(), row.owner), target, row.id, row.cipher);
            if (Number(result.changes) > 0) { rotated += 1; progressed += 1; }
          }
          // A batch where nothing moved means a concurrent writer owns these rows:
          // stop instead of spinning forever.
          if (progressed === 0) break;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rotated;
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
    const encCreds = this.encryptFor(JSON.stringify(account.credentials || {}), account.ownerId);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO accounts (id, ownerId, provider, name, slug, email, status, credentials, encryptionKeyGeneration, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      this.encryptionKeyGeneration,
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
    const plaintext = this.decryptRequired(row.credentials, row.ownerId, row.encryptionKeyGeneration, `accounts.credentials for account '${row.id}'`);
    let credentials: AccountCredentials;
    try {
      credentials = JSON.parse(plaintext);
    } catch (error) {
      throw new EncryptionError(`accounts.credentials for account '${row.id}' decrypted but is not valid JSON`, { cause: error });
    }
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
    const encSecret = this.encryptFor(client.clientSecret, client.ownerId);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_clients (id, ownerId, provider, label, clientId, clientSecret, scopes, tenantId, accountsServer, clientPlatform, clientType, enabled, encryptionKeyGeneration, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      client.clientPlatform || null,
      client.clientType || null,
      client.enabled ? 1 : 0,
      this.encryptionKeyGeneration,
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
    const clientSecret = this.decryptRequired(row.clientSecret, row.ownerId, row.encryptionKeyGeneration, `oauth_clients.clientSecret for client '${row.id}'`);
    let scopes: string[] = [];
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      // scopes is stored as plaintext JSON; a malformed value is not a secret loss.
    }
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
      clientPlatform: row.clientPlatform || undefined,
      clientType: row.clientType || undefined,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // --- Users ---
  private hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey, 'utf8').digest('hex');
  }

  async saveUser(user: User): Promise<void> {
    const apiKeyHash = user.mcpApiKey ? this.hashApiKey(user.mcpApiKey) : null;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users (id, username, displayName, passwordHash, role, mcpApiKey, apiKeyHash, encryptionKeyGeneration, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.username,
      user.displayName,
      user.passwordHash,
      user.role,
      user.mcpApiKey ? this.encryptFor(user.mcpApiKey, user.id) : null,
      apiKeyHash,
      this.encryptionKeyGeneration,
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
      const apiKeyHash = createHash('sha256').update(apiKey, 'utf8').digest('hex');
      const stmt = this.db.prepare('SELECT * FROM users WHERE apiKeyHash = ?');
      const row: any = stmt.get(apiKeyHash);
      if (!row) return null;
      // The hash locates exactly one candidate. A hash match whose stored secret
      // cannot be decrypted is corruption: it throws (naming the user) rather than
      // being silently skipped as an "invalid key".
      const stored = this.decryptOptional(row.mcpApiKey, row.id, row.encryptionKeyGeneration, `users.mcpApiKey for user '${row.id}'`);
      if (stored !== null && stored === apiKey) return this.mapUser(row);
      return null;
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
      mcpApiKey: this.decryptOptional(row.mcpApiKey, row.id, row.encryptionKeyGeneration, `users.mcpApiKey for user '${row.id}'`) ?? '',
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
    if (!row) return { updatedAt: Date.now() };
    // The master key never comes from storage — only from MCP_ENCRYPTION_KEY.
    // Drop it defensively if a legacy row still carries one.
    const { encryptionKey: _discarded, ...rest } = JSON.parse(row.data);
    return rest;
  }

  async saveSettings(settings: Settings): Promise<void> {
    // Strip the master key: it must never be persisted beside the data it protects.
    const { encryptionKey: _discarded, ...persisted } = settings;
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (?, ?)');
    stmt.run('global', JSON.stringify({ ...persisted, updatedAt: Date.now() }));
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
