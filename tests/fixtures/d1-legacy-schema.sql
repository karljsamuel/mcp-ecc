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
    
