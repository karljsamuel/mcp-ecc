#!/usr/bin/env node
import 'dotenv/config';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ManagementApi } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ENCRYPTION_KEY = process.env.MCP_ENCRYPTION_KEY;

// Storage: SQLite or Memory fallback.
let storage;
let storageName = 'sqlite';
try {
  const { SQLiteStorage } = await import('@mcp-ecc/storage-sqlite');
  const STORAGE_FILE = process.env.MCP_STORAGE_FILE || join(process.cwd(), 'data', 'mcp-ecc.db');
  storage = new SQLiteStorage(STORAGE_FILE, ENCRYPTION_KEY);
} catch (e: any) {
  const { MemoryStorage } = await import('@mcp-ecc/storage-memory');
  storage = new MemoryStorage();
  storageName = 'memory';
  console.warn(`SQLite storage unavailable (native module missing), falling back to in-memory: ${e.message}`);
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