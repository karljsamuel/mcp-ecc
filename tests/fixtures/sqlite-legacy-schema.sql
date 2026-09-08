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
    
