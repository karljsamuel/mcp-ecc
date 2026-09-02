#!/usr/bin/env node
import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { ManagementApi } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ENCRYPTION_KEY = process.env.MCP_ENCRYPTION_KEY;

// Storage: SQLite, D1 or Memory fallback.
let storage;
let storageName = 'sqlite';
const DB_PROVIDER = process.env.MCP_DB_PROVIDER || process.env.DB_PROVIDER || 'sqlite';

try {
  if (DB_PROVIDER === 'd1') {
    const { D1Storage, CloudflareD1Database } = await import('@mcp-ecc/storage-d1');
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !databaseId || !apiToken) {
      throw new Error('D1 storage selected but CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, or CLOUDFLARE_API_TOKEN is missing.');
    }
    const db = new CloudflareD1Database(accountId, databaseId, apiToken);
    storage = new D1Storage(db, ENCRYPTION_KEY);
    storageName = 'cloudflare-d1';
    console.log(`[mcp-ecc] Cloudflare D1 storage initialized (DB: ${databaseId})`);
  } else {
    const { SQLiteStorage } = await import('@mcp-ecc/storage-sqlite');
    const STORAGE_FILE = process.env.MCP_STORAGE_FILE || join(process.cwd(), 'data', 'mcp-ecc.db');
    const dbDir = dirname(STORAGE_FILE);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      console.log(`[mcp-ecc] Created database directory at ${dbDir}`);
    }
    storage = new SQLiteStorage(STORAGE_FILE, ENCRYPTION_KEY);
    console.log(`[mcp-ecc] SQLite storage initialized at ${STORAGE_FILE}`);
  }
} catch (e: any) {
  const { MemoryStorage } = await import('@mcp-ecc/storage-memory');
  storage = new MemoryStorage();
  storageName = 'memory';
  console.warn(`Storage provider initialization failed, falling back to in-memory: ${e.message}`);
}

// Bootstrap guidance: if no users exist, the web UI shows the create-admin screen.
let hasUsers = false;
try {
  hasUsers = (await storage.countUsers()) > 0;
} catch { /* ignore */ }

// Admin UI static dir (embedded build, if present)
const publicDir = process.env.MCP_PUBLIC_DIR
  || join(__dirname, '..', '..', 'admin-ui', 'dist');

const api = new ManagementApi({
  storage,
  port: PORT,
  host: HOST,
  publicDir,
  publicUrl: PUBLIC_URL,
  sessionSecret: SESSION_SECRET,
});

api.start().then(() => {
  console.log(`mcp-ecc management API + MCP endpoint up on http://${HOST}:${PORT}`);
  console.log(`  - Web UI:        ${PUBLIC_URL}`);
  console.log(`  - MCP endpoint:  ${PUBLIC_URL}/mcp  (per-user Bearer API key required)`);
  console.log(`  - Storage:       ${storageName}`);
  if (!hasUsers) {
    console.log(`  - First run:     open ${PUBLIC_URL} to create the admin account`);
  }
}).catch((error) => {
  console.error('Failed to start mcp-ecc API:', error);
  process.exit(1);
});

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`Received ${signal}, shutting down...`);
    await api.stop();
    process.exit(0);
  });
}