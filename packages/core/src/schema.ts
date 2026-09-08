/** Canonical, append-only storage schema history. Preserve backend-specific layouts. */
export type SchemaBackend = 'sqlite' | 'd1';
type BackendValue<T> = T | Record<SchemaBackend, T>;
interface ColumnDefinition {
  name: BackendValue<string>;
  definition: BackendValue<string>;
  backends?: readonly SchemaBackend[];
}
interface TableDefinition {
  name: BackendValue<string>;
  columns: readonly ColumnDefinition[];
  backends?: readonly SchemaBackend[];
  constraints?: Record<SchemaBackend, readonly string[]>;
}

// Version 1 is frozen at the pre-ledger schema. Evolve it with new migrations,
// not edits to these definitions. Version 2 reconciles historical missing columns.
export const STORAGE_SCHEMA: readonly TableDefinition[] = [
  {
    name: "users",
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY"},
      {"name": "username", "definition": {"sqlite": "TEXT UNIQUE NOT NULL", "d1": "TEXT NOT NULL UNIQUE"}},
      {"name": {"sqlite": "displayName", "d1": "display_name"}, "definition": "TEXT NOT NULL"},
      {"name": {"sqlite": "passwordHash", "d1": "password_hash"}, "definition": "TEXT NOT NULL"},
      {"name": "role", "definition": {"sqlite": "TEXT NOT NULL", "d1": "TEXT NOT NULL DEFAULT 'user'"}},
      {"name": {"sqlite": "mcpApiKey", "d1": "mcp_api_key"}, "definition": {"sqlite": "TEXT", "d1": "TEXT NOT NULL"}},
      {"name": {"sqlite": "createdAt", "d1": "created_at"}, "definition": "INTEGER NOT NULL"},
      {"name": {"sqlite": "updatedAt", "d1": "updated_at"}, "definition": "INTEGER NOT NULL"},
    ],
  },
  {
    name: "accounts",
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY"},
      {"name": {"sqlite": "ownerId", "d1": "owner_id"}, "definition": "TEXT NOT NULL"},
      {"name": "provider", "definition": "TEXT NOT NULL"},
      {"name": "name", "definition": {"sqlite": "TEXT", "d1": "TEXT NOT NULL"}},
      {"name": "slug", "definition": "TEXT NOT NULL"},
      {"name": "email", "definition": "TEXT NOT NULL"},
      {"name": "status", "definition": {"sqlite": "TEXT NOT NULL", "d1": "TEXT DEFAULT 'active'"}},
      {"name": {"sqlite": "credentials", "d1": "credentials_json"}, "definition": "TEXT NOT NULL"},
      {"name": {"sqlite": "createdAt", "d1": "created_at"}, "definition": "INTEGER NOT NULL"},
      {"name": {"sqlite": "updatedAt", "d1": "updated_at"}, "definition": "INTEGER NOT NULL"},
      {"name": "display_name", "definition": "TEXT", "backends": ["d1"]},
      {"name": "health", "definition": "TEXT DEFAULT 'unknown'", "backends": ["d1"]},
      {"name": "last_sync_at", "definition": "INTEGER", "backends": ["d1"]},
    ],
    constraints: {"sqlite": ["UNIQUE(ownerId, slug)"], "d1": ["FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE"]},
  },
  {
    name: "oauth_clients",
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY"},
      {"name": {"sqlite": "ownerId", "d1": "owner_id"}, "definition": "TEXT NOT NULL"},
      {"name": "provider", "definition": "TEXT NOT NULL"},
      {"name": "label", "definition": "TEXT NOT NULL"},
      {"name": {"sqlite": "clientId", "d1": "client_id"}, "definition": "TEXT NOT NULL"},
      {"name": {"sqlite": "clientSecret", "d1": "client_secret"}, "definition": "TEXT NOT NULL"},
      {"name": {"sqlite": "scopes", "d1": "scopes_json"}, "definition": "TEXT NOT NULL"},
      {"name": {"sqlite": "tenantId", "d1": "tenant_id"}, "definition": "TEXT"},
      {"name": {"sqlite": "accountsServer", "d1": "accounts_server"}, "definition": "TEXT"},
      {"name": {"sqlite": "clientType", "d1": "client_type"}, "definition": "TEXT"},
      {"name": "enabled", "definition": {"sqlite": "INTEGER NOT NULL", "d1": "INTEGER NOT NULL DEFAULT 1"}},
      {"name": {"sqlite": "createdAt", "d1": "created_at"}, "definition": "INTEGER NOT NULL"},
      {"name": {"sqlite": "updatedAt", "d1": "updated_at"}, "definition": "INTEGER NOT NULL"},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE"]},
  },
  {
    name: "settings",
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY", "backends": ["sqlite"]},
      {"name": "data", "definition": "TEXT NOT NULL", "backends": ["sqlite"]},
      {"name": "key", "definition": "TEXT PRIMARY KEY", "backends": ["d1"]},
      {"name": "value", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
  },
  {
    name: "oauth_states",
    columns: [
      {"name": "state", "definition": "TEXT PRIMARY KEY"},
      {"name": {"sqlite": "data", "d1": "data_json"}, "definition": "TEXT NOT NULL"},
      {"name": "created_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
  },
  {
    name: {"sqlite": "sync_states", "d1": "sync_state"},
    columns: [
      {"name": {"sqlite": "accountId", "d1": "account_id"}, "definition": "TEXT PRIMARY KEY"},
      {"name": "data", "definition": "TEXT NOT NULL", "backends": ["sqlite"]},
      {"name": "mail_cursor", "definition": "TEXT", "backends": ["d1"]},
      {"name": "contacts_cursor", "definition": "TEXT", "backends": ["d1"]},
      {"name": "calendar_cursor", "definition": "TEXT", "backends": ["d1"]},
      {"name": "last_full_sync", "definition": "INTEGER", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE"]},
  },
  {
    name: "mail_messages",
    backends: ["d1"],
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY", "backends": ["d1"]},
      {"name": "account_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "folder_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "thread_id", "definition": "TEXT", "backends": ["d1"]},
      {"name": "from_addr", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "to_addrs", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "cc_addrs", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "bcc_addrs", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "subject", "definition": "TEXT", "backends": ["d1"]},
      {"name": "snippet", "definition": "TEXT", "backends": ["d1"]},
      {"name": "body", "definition": "TEXT", "backends": ["d1"]},
      {"name": "html_body", "definition": "TEXT", "backends": ["d1"]},
      {"name": "date", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "unread", "definition": "INTEGER NOT NULL DEFAULT 0", "backends": ["d1"]},
      {"name": "starred", "definition": "INTEGER NOT NULL DEFAULT 0", "backends": ["d1"]},
      {"name": "labels_or_folders", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "attachments", "definition": "TEXT", "backends": ["d1"]},
      {"name": "headers", "definition": "TEXT", "backends": ["d1"]},
      {"name": "created_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE"]},
  },
  {
    name: "mail_folders",
    backends: ["d1"],
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY", "backends": ["d1"]},
      {"name": "account_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "name", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "parent_id", "definition": "TEXT", "backends": ["d1"]},
      {"name": "type", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "unread_count", "definition": "INTEGER DEFAULT 0", "backends": ["d1"]},
      {"name": "total_count", "definition": "INTEGER DEFAULT 0", "backends": ["d1"]},
      {"name": "created_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE"]},
  },
  {
    name: "calendar_events",
    backends: ["d1"],
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY", "backends": ["d1"]},
      {"name": "account_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "calendar_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "summary", "definition": "TEXT", "backends": ["d1"]},
      {"name": "description", "definition": "TEXT", "backends": ["d1"]},
      {"name": "location", "definition": "TEXT", "backends": ["d1"]},
      {"name": "start_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "end_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "all_day", "definition": "INTEGER NOT NULL DEFAULT 0", "backends": ["d1"]},
      {"name": "status", "definition": "TEXT", "backends": ["d1"]},
      {"name": "attendees", "definition": "TEXT", "backends": ["d1"]},
      {"name": "recurrence_rule", "definition": "TEXT", "backends": ["d1"]},
      {"name": "raw", "definition": "TEXT", "backends": ["d1"]},
      {"name": "created_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE", "UNIQUE(account_id, calendar_id, id)"]},
  },
  {
    name: "calendars",
    backends: ["d1"],
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY", "backends": ["d1"]},
      {"name": "account_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "external_id", "definition": "TEXT", "backends": ["d1"]},
      {"name": "name", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "description", "definition": "TEXT", "backends": ["d1"]},
      {"name": "color", "definition": "TEXT", "backends": ["d1"]},
      {"name": "primary_calendar", "definition": "INTEGER NOT NULL DEFAULT 0", "backends": ["d1"]},
      {"name": "access_role", "definition": "TEXT", "backends": ["d1"]},
      {"name": "created_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE", "UNIQUE(account_id, external_id)"]},
  },
  {
    name: "contacts",
    backends: ["d1"],
    columns: [
      {"name": "id", "definition": "TEXT PRIMARY KEY", "backends": ["d1"]},
      {"name": "account_id", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "external_id", "definition": "TEXT", "backends": ["d1"]},
      {"name": "display_name", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "emails", "definition": "TEXT NOT NULL", "backends": ["d1"]},
      {"name": "phones", "definition": "TEXT", "backends": ["d1"]},
      {"name": "addresses", "definition": "TEXT", "backends": ["d1"]},
      {"name": "organization", "definition": "TEXT", "backends": ["d1"]},
      {"name": "job_title", "definition": "TEXT", "backends": ["d1"]},
      {"name": "notes", "definition": "TEXT", "backends": ["d1"]},
      {"name": "raw", "definition": "TEXT", "backends": ["d1"]},
      {"name": "created_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
      {"name": "updated_at", "definition": "INTEGER NOT NULL", "backends": ["d1"]},
    ],
    constraints: {"sqlite": [], "d1": ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE", "UNIQUE(account_id, external_id)"]},
  },
];

export const STORAGE_INDEXES = [
  {"name": "idx_mail_account_folder", "table": "mail_messages", "columns": "account_id, folder_id", "backends": ["d1"]},
  {"name": "idx_mail_date", "table": "mail_messages", "columns": "account_id, date DESC", "backends": ["d1"]},
  {"name": "idx_mail_unread", "table": "mail_messages", "columns": "account_id, unread, date DESC", "backends": ["d1"]},
  {"name": "idx_contacts_account", "table": "contacts", "columns": "account_id", "backends": ["d1"]},
  {"name": "idx_events_account_range", "table": "calendar_events", "columns": "account_id, start_at, end_at", "backends": ["d1"]},
  {"name": "idx_calendars_account", "table": "calendars", "columns": "account_id", "backends": ["d1"]},
] as const;

function value<T>(entry: BackendValue<T>, backend: SchemaBackend): T {
  return typeof entry === 'object' && entry !== null ? (entry as Record<SchemaBackend, T>)[backend] : entry as T;
}

export function schemaStatements(backend: SchemaBackend): string[] {
  const tables = STORAGE_SCHEMA.filter(table => !table.backends || table.backends.includes(backend));
  return [
    ...tables.map(table => {
      const columns = table.columns.filter(column => !column.backends || column.backends.includes(backend))
        .map(column => `${value(column.name, backend)} ${value(column.definition, backend)}`);
      return `CREATE TABLE IF NOT EXISTS ${value(table.name, backend)} (${[...columns, ...(table.constraints?.[backend] || [])].join(', ')})`;
    }),
    ...STORAGE_INDEXES.filter(index => (index.backends as readonly SchemaBackend[]).includes(backend))
      .map(index => `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}(${index.columns})`),
  ];
}

export interface ColumnMigration {
  table: string;
  name: BackendValue<string>;
  definition: string;
  backends?: readonly SchemaBackend[];
}
export interface SchemaMigration {
  version: number;
  name: string;
  statements?: (backend: SchemaBackend) => readonly string[];
  columns?: readonly ColumnMigration[];
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, name: 'baseline', statements: schemaStatements },
  { version: 2, name: 'legacy-optional-columns', columns: [
    { table: 'oauth_clients', name: { sqlite: 'clientType', d1: 'client_type' }, definition: 'TEXT' },
    { table: 'oauth_clients', name: { sqlite: 'clientPlatform', d1: 'client_platform' }, definition: 'TEXT' },
    { table: 'accounts', name: 'display_name', definition: 'TEXT', backends: ['d1'] },
    { table: 'accounts', name: 'health', definition: 'TEXT', backends: ['d1'] },
    { table: 'accounts', name: 'last_sync_at', definition: 'INTEGER', backends: ['d1'] },
  ] },
];

export const MIGRATION_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;
export const READ_MIGRATIONS_SQL = 'SELECT version FROM schema_migrations ORDER BY version';
export const RECORD_MIGRATION_SQL = 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)';

export function migrationColumns(migration: SchemaMigration, backend: SchemaBackend) {
  return (migration.columns || []).filter(column => !column.backends || column.backends.includes(backend))
    .map(column => ({ table: column.table, name: value(column.name, backend), definition: column.definition }));
}
