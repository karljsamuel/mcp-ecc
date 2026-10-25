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
import { generateId, getEncryptionKey } from '@mcp-ecc/core';
import { SCHEMA_MIGRATIONS, MIGRATION_LEDGER_SQL, READ_MIGRATIONS_SQL, RECORD_MIGRATION_SQL, migrationColumns } from '@mcp-ecc/core';
import { decrypt, encrypt, EncryptionError } from './crypto.js';

// A master key that is absent or equal to a well-known placeholder must never be
// used: it would encrypt real credentials under a publicly documented constant.
const PLACEHOLDER_KEYS = new Set(['default-secret-key']);

// Constructor argument / environment fallback for keys retired by a rotation.
// Old rows stay readable while their generation is still in the keyring.
const PREVIOUS_KEYS_VAR = 'MCP_ENCRYPTION_KEY_PREVIOUS';
// Optional explicit label for the current key. Needed to drop a retired key after
// every row has been rotated onto the current generation.
const GENERATION_VAR = 'MCP_ENCRYPTION_KEY_GENERATION';
const encoder = new TextEncoder();

function assertUsableMasterKey(key: string | undefined, label: string): string {
  const trimmed = key?.trim();
  if (!trimmed || PLACEHOLDER_KEYS.has(trimmed)) {
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

/** Hex SHA-256, identical to the SQLite adapter's createHash('sha256') output. */
async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

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

export class CloudflareD1Database implements D1Database {
  private accountId: string;
  private databaseId: string;
  private apiToken: string;

  constructor(accountId: string, databaseId: string, apiToken: string) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
  }

  prepare(query: string): D1PreparedStatement {
    return new CloudflareD1PreparedStatement(this, query);
  }

  async exec(query: string): Promise<void> {
    await this.runQuery(query, []);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    // Cloudflare's public D1 query endpoint accepts one query object, not
    // the Workers runtime's batch array payload. Execute sequentially.
    const results: D1Result[] = [];
    for (const stmt of statements) {
      results.push(await this.runQuery(
        (stmt as CloudflareD1PreparedStatement).getQuery(),
        (stmt as CloudflareD1PreparedStatement).getParams(),
      ));
    }
    return results;
  }

  async runQuery(sql: string, params: unknown[]): Promise<D1Result> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cloudflare D1 Query Error (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    if (!data.success) {
      throw new Error(`Cloudflare D1 Query Failed: ${JSON.stringify(data.errors)}`);
    }

    const res = data.result[0];
    return {
      results: res.results || [],
      success: res.success,
      meta: res.meta || { changes: 0, duration: 0, last_row_id: 0, changed_db: false },
    };
  }

  async runBatch(payloads: { sql: string; params: unknown[] }[]): Promise<D1Result[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payloads),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cloudflare D1 Batch Error (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    if (!data.success) {
      throw new Error(`Cloudflare D1 Batch Failed: ${JSON.stringify(data.errors)}`);
    }

    return data.result.map((res: any) => ({
      results: res.results || [],
      success: res.success,
      meta: res.meta || { changes: 0, duration: 0, last_row_id: 0, changed_db: false },
    }));
  }
}

class CloudflareD1PreparedStatement implements D1PreparedStatement {
  private db: CloudflareD1Database;
  private sql: string;
  private params: unknown[] = [];

  constructor(db: CloudflareD1Database, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  getQuery(): string {
    return this.sql;
  }

  getParams(): unknown[] {
    return this.params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    const stmt = new CloudflareD1PreparedStatement(this.db, this.sql);
    stmt.params = values;
    return stmt;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const res = await this.db.runQuery(this.sql, this.params);
    if (!res.results || res.results.length === 0) {
      return null;
    }
    const row = res.results[0] as any;
    if (colName) {
      return row[colName] ?? null;
    }
    return row as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const res = await this.db.runQuery(this.sql, this.params);
    return res as D1Result<T>;
  }

  async run(): Promise<D1Result> {
    return this.db.runQuery(this.sql, this.params);
  }
}

export class D1Storage implements StorageAdapter {
  private db: D1Database;
  private keys: Map<number, string>;
  private generation: number;
  private schemaInitialization?: Promise<void>;

  constructor(db: D1Database, encryptionKey?: string, retiredKeys: RetiredKeys = {}, currentGeneration?: number) {
    const keyring = resolveKeyring(encryptionKey, retiredKeys, currentGeneration);
    this.keys = keyring.keys;
    this.generation = keyring.generation;
    this.db = db;
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

  async initSchema(): Promise<void> {
    if (!this.schemaInitialization) {
      this.schemaInitialization = this.initSchemaInternal().catch(error => {
        this.schemaInitialization = undefined;
        throw error;
      });
    }
    return this.schemaInitialization;
  }

  private async initSchemaInternal(): Promise<void> {
    await this.schemaQuery(MIGRATION_LEDGER_SQL);
    const applied = (await this.schemaQuery<{ version: number }>(READ_MIGRATIONS_SQL, [], true)).results;
    for (const migration of SCHEMA_MIGRATIONS) {
      if (applied.some(row => row.version === migration.version)) continue;
      try {
        // Add columns first, then run statements (some statements may depend on new columns)
        for (const column of migrationColumns(migration, 'd1')) {
          await this.ensureColumn(column.table, column.name, column.definition);
        }
        for (const sql of migration.statements?.('d1') || []) await this.schemaQuery(sql);
        // D1/HTTP does not support interactive transactions. All operations are
        // additive and retryable; never mark a partially completed version applied.
        await this.schemaQuery(RECORD_MIGRATION_SQL, [migration.version, migration.name, Date.now()]);
      } catch (error) {
        throw new Error(`D1 schema migration ${migration.version} (${migration.name}) failed`, { cause: error });
      }
    }
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const columns = (await this.schemaQuery<{ name: string }>(`PRAGMA table_info(${table})`, [], true)).results;
    if (!columns.some(existing => existing.name === column)) {
      await this.schemaQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private async schemaQuery<T = unknown>(sql: string, params: unknown[] = [], read = false): Promise<D1Result<T>> {
    const statement = this.db.prepare(sql).bind(...params);
    const result = read ? await statement.all<T>() : await statement.run();
    if (!result.success) throw new Error('D1 schema query returned success=false');
    return result as D1Result<T>;
  }

  private async encrypt(data: string, ownerId: string): Promise<string> {
    return encrypt(data, this.currentMasterKey(), ownerId);
  }

  /** Decrypts a blob for one owner, wrapping the reason into a record-naming error. */
  private async decryptOrThrow(ciphertext: string, ownerId: string, generation: number, record: string): Promise<string> {
    try {
      return await decrypt(ciphertext, this.keyForGeneration(generation), ownerId);
    } catch (error) {
      throw new EncryptionError(
        `${record} could not be decrypted (owner '${ownerId}', key generation ${generation}). ` +
        `Refusing to return a blank value that a later save would overwrite.`,
        { cause: error },
      );
    }
  }

  /** For nullable secret columns: null/'' means "no secret stored", not a failure. */
  private async decryptOptional(ciphertext: string | null | undefined, ownerId: string, generation: number | null | undefined, record: string): Promise<string | null> {
    if (ciphertext === null || ciphertext === undefined || ciphertext === '') return null;
    return this.decryptOrThrow(ciphertext, ownerId, generation ?? 1, record);
  }

  /** For NOT NULL secret columns: a missing or empty value is corruption, not "no secret". */
  private async decryptRequired(ciphertext: string | null | undefined, ownerId: string, generation: number | null | undefined, record: string): Promise<string> {
    if (ciphertext === null || ciphertext === undefined || ciphertext === '') {
      throw new EncryptionError(`${record} is missing or empty, but the column is NOT NULL: this row is corrupt.`);
    }
    return this.decryptOrThrow(ciphertext, ownerId, generation ?? 1, record);
  }

  /**
   * The owner of an account is never passed to getCredentials/saveCredentials by
   * the StorageAdapter interface, so read it from the row itself.
   */
  private async requireOwnerId(accountId: string): Promise<string> {
    const row = await this.db.prepare('SELECT owner_id FROM accounts WHERE id = ?').bind(accountId).first<any>();
    if (!row) throw new Error(`Account not found: ${accountId}`);
    return row.owner_id;
  }

  /**
   * Re-encrypts every credential still held at an older key generation using the
   * current one, in batches of `batchSize`. Interruptible and re-runnable:
   * already-current rows are skipped and each rewrite is guarded so a concurrent
   * writer is never clobbered. Both generations stay readable throughout, so a
   * changeover needs no downtime. Returns the number of values rewritten.
   */
  async rotateEncryptionKeys(batchSize = 100): Promise<number> {
    const target = this.encryptionKeyGeneration;
    const columns = [
      { table: 'accounts', owner: 'owner_id', cipher: 'credentials_json', generation: 'encryption_key_generation', record: 'accounts.credentials' },
      { table: 'oauth_clients', owner: 'owner_id', cipher: 'client_secret', generation: 'encryption_key_generation', record: 'oauth_clients.clientSecret' },
      { table: 'users', owner: 'id', cipher: 'mcp_api_key', generation: 'encryption_key_generation', record: 'users.mcpApiKey' },
    ];
    let rotated = 0;
    for (const column of columns) {
      for (;;) {
        const { results } = await this.db.prepare(
          `SELECT id AS id, ${column.owner} AS owner, ${column.cipher} AS cipher, ${column.generation} AS generation
           FROM ${column.table} WHERE ${column.generation} < ? ORDER BY id LIMIT ?`,
        ).bind(target, batchSize).all<any>();
        if (!results || results.length === 0) break;
        let progressed = 0;
        for (const row of results) {
          if (!row.cipher) {
            const cleared = await this.db.prepare(`UPDATE ${column.table} SET ${column.generation} = ? WHERE id = ?`).bind(target, row.id).run();
            if (cleared.success) progressed += 1;
            continue;
          }
          const generation = row.generation ?? 1;
          const plaintext = await this.decryptOrThrow(row.cipher, row.owner, generation, `${column.record} for '${row.id}' during rotation`);
          const result = await this.db.prepare(
            `UPDATE ${column.table} SET ${column.cipher} = ?, ${column.generation} = ? WHERE id = ? AND ${column.cipher} = ?`,
          ).bind(await encrypt(plaintext, this.currentMasterKey(), row.owner), target, row.id, row.cipher).run();
          if (result.success && (result.meta?.changes ?? 0) > 0) { rotated += 1; progressed += 1; }
        }
        // A batch where nothing moved means a concurrent writer owns these rows:
        // stop instead of spinning forever.
        if (progressed === 0) break;
      }
    }
    return rotated;
  }

  // Account management
  async getAccount(id: string): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!row) return null;
    return await this.mapAccount(row as any);
  }

  async getAccountBySlug(slug: string, ownerId: string): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE slug = ? AND owner_id = ?').bind(slug, ownerId).first();
    if (!row) return null;
    return await this.mapAccount(row as any);
  }

  async listAccounts(ownerId?: string): Promise<Account[]> {
    const { results } = ownerId
      ? await this.db.prepare('SELECT * FROM accounts WHERE owner_id = ? ORDER BY name').bind(ownerId).all()
      : await this.db.prepare('SELECT * FROM accounts ORDER BY name').all();
    return Promise.all((results as any[]).map(r => this.mapAccount(r)));
  }

  async saveAccount(account: Account): Promise<void> {
    const now = Date.now();
    const credentialsJson = await this.encrypt(JSON.stringify(account.credentials), account.ownerId);

    await this.db.prepare(`
      INSERT INTO accounts (id, owner_id, provider, name, slug, email, display_name, credentials_json, encryption_key_generation, status, health, last_sync_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id = excluded.owner_id,
        provider = excluded.provider,
        name = excluded.name,
        slug = excluded.slug,
        email = excluded.email,
        display_name = excluded.display_name,
        credentials_json = excluded.credentials_json,
        encryption_key_generation = excluded.encryption_key_generation,
        status = excluded.status,
        health = excluded.health,
        last_sync_at = excluded.last_sync_at,
        updated_at = excluded.updated_at
    `).bind(
      account.id, account.ownerId, account.provider, account.name, account.slug,
      account.email, account.displayName || null, credentialsJson, this.encryptionKeyGeneration,
      account.status, account.health, account.lastSyncAt || null, now, now
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
      // `updates` may omit ownerId; the owner id is needed to derive the key, so
      // fall back to the row's current owner.
      const ownerId = updates.ownerId ?? await this.requireOwnerId(id);
      fields.push('credentials_json = ?');
      values.push(await this.encrypt(JSON.stringify(updates.credentials), ownerId));
      fields.push('encryption_key_generation = ?');
      values.push(this.encryptionKeyGeneration);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    await this.db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  // Credentials
  async getCredentials(accountId: string): Promise<AccountCredentials | null> {
    const row = await this.db.prepare('SELECT credentials_json, owner_id, encryption_key_generation FROM accounts WHERE id = ?').bind(accountId).first<any>();
    if (!row) return null;
    const plaintext = await this.decryptRequired(row.credentials_json, row.owner_id, row.encryption_key_generation, `accounts.credentials for account '${accountId}'`);
    return JSON.parse(plaintext);
  }

  async saveCredentials(accountId: string, credentials: AccountCredentials): Promise<void> {
    const ownerId = await this.requireOwnerId(accountId);
    await this.db.prepare('UPDATE accounts SET credentials_json = ?, encryption_key_generation = ?, updated_at = ? WHERE id = ?')
      .bind(await this.encrypt(JSON.stringify(credentials), ownerId), this.encryptionKeyGeneration, Date.now(), accountId).run();
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
      // The master encryption key is never read back from storage: it comes only
      // from MCP_ENCRYPTION_KEY. Ignore any legacy row that still holds one.
      if (row.key === 'encryptionKey') continue;
      if (row.key === 'uiPreferences') settings.uiPreferences = JSON.parse(row.value);
      else if (row.key === 'sessions') (settings as any).sessions = JSON.parse(row.value);
      settings.updatedAt = Math.max(settings.updatedAt, row.updated_at);
    }
    return settings;
  }

  async saveSettings(settings: Settings): Promise<void> {
    const now = Date.now();
    // The master encryption key is deliberately never persisted (it lives in the
    // MCP_ENCRYPTION_KEY environment variable), so settings.encryptionKey is ignored.
    if (settings.uiPreferences) {
      await this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('uiPreferences', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(JSON.stringify(settings.uiPreferences), now).run();
    }
    const sessions = (settings as any).sessions;
    if (sessions) {
      await this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('sessions', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(JSON.stringify(sessions), now).run();
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
        JSON.stringify(msg.to.map((t: { address: string }) => t.address)),
        JSON.stringify(msg.cc?.map((t: { address: string }) => t.address) || []),
        JSON.stringify(msg.bcc?.map((t: { address: string }) => t.address) || []),
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
    return Promise.all((results as any[]).map(r => this.mapMailMessage(r)));
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
    return Promise.all((results as any[]).map(r => this.mapCalendarEvent(r)));
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
    const secretJson = await this.encrypt(client.clientSecret, client.ownerId);
    await this.db.prepare(`
      INSERT INTO oauth_clients (id, owner_id, provider, label, client_id, client_secret, scopes_json, tenant_id, accounts_server, client_platform, client_type, enabled, encryption_key_generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id = excluded.owner_id, provider = excluded.provider, label = excluded.label,
        client_id = excluded.client_id, client_secret = excluded.client_secret, scopes_json = excluded.scopes_json,
        tenant_id = excluded.tenant_id, accounts_server = excluded.accounts_server,
        client_platform = excluded.client_platform, client_type = excluded.client_type, enabled = excluded.enabled,
        encryption_key_generation = excluded.encryption_key_generation,
        updated_at = excluded.updated_at
    `).bind(client.id, client.ownerId, client.provider, client.label, client.clientId, secretJson,
      JSON.stringify(client.scopes), client.tenantId || null, client.accountsServer || null,
      client.clientPlatform || null, client.clientType || null, client.enabled ? 1 : 0,
      this.encryptionKeyGeneration, now, now).run();
  }

  async getOAuthClient(id: string): Promise<OAuthClient | null> {
    const row = await this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(id).first();
    if (!row) return null;
    return await this.mapOAuthClient(row as any);
  }

  async listOAuthClients(ownerId: string): Promise<OAuthClient[]> {
    const { results } = await this.db.prepare('SELECT * FROM oauth_clients WHERE owner_id = ? ORDER BY provider, label').bind(ownerId).all();
    return await Promise.all((results as any[]).map(r => this.mapOAuthClient(r)));
  }

  async deleteOAuthClient(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_clients WHERE id = ?').bind(id).run();
  }

  // Users
  async saveUser(user: User): Promise<void> {
    const now = Date.now();
    const apiKeyJson = user.mcpApiKey ? await this.encrypt(user.mcpApiKey, user.id) : null;
    const apiKeyHash = user.mcpApiKey ? await sha256Hex(user.mcpApiKey) : null;
    await this.db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, role, mcp_api_key, apiKeyHash, encryption_key_generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username, display_name = excluded.display_name, password_hash = excluded.password_hash,
        role = excluded.role, mcp_api_key = excluded.mcp_api_key, apiKeyHash = excluded.apiKeyHash,
        encryption_key_generation = excluded.encryption_key_generation, updated_at = excluded.updated_at
    `).bind(user.id, user.username, user.displayName, user.passwordHash, user.role, apiKeyJson, apiKeyHash,
      this.encryptionKeyGeneration, now, now).run();
  }

  async getUser(id: string): Promise<User | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!row) return null;
    return await this.mapUser(row as any);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!row) return null;
    return await this.mapUser(row as any);
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    // Locate the single candidate by hash (same scheme as the SQLite adapter) and
    // authenticate by decrypting its stored key. A hash match whose secret cannot
    // be decrypted is corruption: it throws, naming the user, instead of being
    // silently skipped as an "invalid key".
    const row = await this.db.prepare('SELECT * FROM users WHERE apiKeyHash = ?').bind(await sha256Hex(apiKey)).first<any>();
    if (!row) return null;
    const stored = await this.decryptOptional(row.mcp_api_key, row.id, row.encryption_key_generation, `users.mcpApiKey for user '${row.id}'`);
    if (stored !== null && stored === apiKey) return await this.mapUser(row);
    return null;
  }

  async listUsers(): Promise<User[]> {
    const { results } = await this.db.prepare('SELECT * FROM users ORDER BY username').all();
    return Promise.all((results as any[]).map(r => this.mapUser(r)));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.displayName !== undefined) { fields.push('display_name = ?'); values.push(updates.displayName); }
    if (updates.passwordHash) { fields.push('password_hash = ?'); values.push(updates.passwordHash); }
    if (updates.role) { fields.push('role = ?'); values.push(updates.role); }
    if (updates.mcpApiKey) {
      fields.push('mcp_api_key = ?'); values.push(await this.encrypt(updates.mcpApiKey, id));
      fields.push('apiKeyHash = ?'); values.push(await sha256Hex(updates.mcpApiKey));
      fields.push('encryption_key_generation = ?'); values.push(this.encryptionKeyGeneration);
    }
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
  private async mapAccount(row: any): Promise<Account> {
    return {
      id: row.id,
      ownerId: row.owner_id,
      provider: row.provider,
      name: row.name,
      slug: row.slug,
      email: row.email,
      displayName: row.display_name || undefined,
      credentials: JSON.parse(await this.decryptRequired(row.credentials_json, row.owner_id, row.encryption_key_generation, `accounts.credentials for account '${row.id}'`)),
      status: row.status,
      health: row.health || 'unknown',
      lastSyncAt: row.last_sync_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async mapOAuthClient(row: any): Promise<OAuthClient> {
    return {
      id: row.id,
      ownerId: row.owner_id,
      provider: row.provider,
      label: row.label,
      clientId: row.client_id,
      clientSecret: await this.decryptRequired(row.client_secret, row.owner_id, row.encryption_key_generation, `oauth_clients.clientSecret for client '${row.id}'`),
      scopes: JSON.parse(row.scopes_json),
      tenantId: row.tenant_id || undefined,
      accountsServer: row.accounts_server || undefined,
      clientPlatform: row.client_platform || undefined,
      clientType: row.client_type || undefined,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async mapUser(row: any): Promise<User> {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      role: row.role,
      mcpApiKey: (await this.decryptOptional(row.mcp_api_key, row.id, row.encryption_key_generation, `users.mcpApiKey for user '${row.id}'`)) ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async mapMailMessage(row: any): Promise<EmailMessage> {
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