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
const ENCRYPTION_KEY = process.env.MCP_ENCRYPTION_KEY;

// Storage: prefer SQLite (persistent) when the native module is available,
// otherwise fall back to in-memory. The SQLite adapter is imported lazily so a
// missing native `better-sqlite3` binary does not crash startup.
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
  console.warn(`SQLite storage unavailable, falling back to in-memory: ${e.message}`);
}

// Admin UI static dir (embedded build, if present)
const publicDir = process.env.MCP_PUBLIC_DIR
  || join(__dirname, '..', '..', 'admin-ui', 'dist');

const api = new ManagementApi({
  storage,
  port: PORT,
  host: HOST,
  publicDir,
});

api.start().then(() => {
  console.log(`mcp-ecc management API + MCP endpoint listening on http://${HOST}:${PORT}`);
  console.log(`- Web UI:       http://${HOST}:${PORT}`);
  console.log(`- MCP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`- Storage:      ${storageName}`);
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