#!/usr/bin/env node
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import {
  checkConfig,
  containerNeedsEnvHandoff,
  generateSetupToken,
  getEncryptionKey,
  isRunningInContainer,
  loadEnv,
  resolveEnvPath,
  setupModeHost,
  type DBConnectionProbe,
  type SetupD1Config,
} from '@mcp-ecc/core';
import { ManagementApi } from './index.js';

// ESM has no __dirname: derive it (this used to be a ReferenceError below).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the project root / MCP_ENV_FILE.
loadEnv();

const env = (name: string): string | undefined => process.env[name]?.trim();

const PORT = parseInt(env('PORT') || '3001', 10);
const DEFAULT_HOST = '0.0.0.0';
const PUBLIC_URL = env('PUBLIC_URL') || env('BASE_URL') || `http://localhost:${PORT}`;
const SESSION_SECRET = env('SESSION_SECRET');

// Admin UI static dir (embedded build, if present)
const publicDir = env('MCP_PUBLIC_DIR') || join(__dirname, '..', '..', 'admin-ui', 'dist');

interface StorageConfig {
  dbProvider: string;
  dbConfig: Record<string, string>;
  encryptionKey: string;
}

// Construct a storage adapter from an explicit configuration. The setup wizard
// calls this mid-flight; the normal boot path calls it with the environment.
async function buildStorage(cfg: StorageConfig): Promise<any> {
  if (cfg.dbProvider === 'd1') {
    const { D1Storage, CloudflareD1Database } = await import('@mcp-ecc/storage-d1');
    const db = new CloudflareD1Database(
      cfg.dbConfig.CLOUDFLARE_ACCOUNT_ID,
      cfg.dbConfig.CLOUDFLARE_DATABASE_ID,
      cfg.dbConfig.CLOUDFLARE_API_TOKEN,
    );
    const storage = new D1Storage(db, cfg.encryptionKey);
    await storage.initSchema();
    return storage;
  }

  const { SQLiteStorage } = await import('@mcp-ecc/storage-sqlite');
  const storageFile = cfg.dbConfig.MCP_STORAGE_FILE;
  const dbDir = dirname(storageFile);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    console.log(`[mcp-ecc] Created database directory at ${dbDir}`);
  }
  return new SQLiteStorage(storageFile, cfg.encryptionKey);
}

// Resolved lazily so a sqlite-only install never loads the D1 client.
let d1Module: any;
function createD1Probe(cfg: SetupD1Config): DBConnectionProbe {
  if (!d1Module) throw new Error('Cloudflare D1 support is not available in this installation');
  return new d1Module.CloudflareD1Database(cfg.accountId, cfg.databaseId, cfg.apiToken) as unknown as DBConnectionProbe;
}

function storageConfigFromEnv(dbProvider: string, encryptionKey: string): StorageConfig {
  return {
    dbProvider,
    encryptionKey,
    dbConfig: dbProvider === 'd1'
      ? {
          CLOUDFLARE_ACCOUNT_ID: env('CLOUDFLARE_ACCOUNT_ID') || '',
          CLOUDFLARE_DATABASE_ID: env('CLOUDFLARE_DATABASE_ID') || '',
          CLOUDFLARE_API_TOKEN: env('CLOUDFLARE_API_TOKEN') || '',
        }
      : { MCP_STORAGE_FILE: env('MCP_STORAGE_FILE') || '' },
  };
}

function attachShutdown(api: ManagementApi): void {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down...`);
      await api.stop();
      process.exit(0);
    });
  }
}

/**
 * Started without a usable configuration: serve the UI and /api/setup/* only,
 * bind loopback, and hand the operator a one-time token.
 */
async function startSetupMode(missing: string[]): Promise<void> {
  const token = generateSetupToken();
  const inContainer = isRunningInContainer();
  // In a container the listener must sit on 0.0.0.0: Docker forwards the
  // published port to eth0, so a loopback bind would be unreachable from the host.
  const host = setupModeHost();
  const setupUrl = inContainer
    ? `${PUBLIC_URL.replace(/\/+$/, '')}/setup`
    : `http://127.0.0.1:${PORT}/setup`;

  const api = new ManagementApi({
    createStorage: (cfg) => buildStorage(cfg),
    createD1Probe,
    port: PORT,
    host,
    publicDir,
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
    setup: {
      token,
      envPath: resolveEnvPath(),
      // Setup requests reach a container via the bridge gateway, not loopback.
      allowNonLoopback: inContainer,
    },
  });

  // The token goes to stdout ONLY: the Fastify logger must never see it, and it
  // is never returned by an HTTP response.
  const lines = [
    '',
    '  mcp-ecc is not configured yet — starting in SETUP MODE.',
    `  Missing configuration: ${missing.join(', ') || 'unknown'}`,
    '',
    `  Setup token: ${token}`,
    '',
    inContainer
      ? '  1. Open the setup page at:'
      : '  1. Open the setup page (this machine only):',
    `       ${setupUrl}`,
    '  2. Paste the setup token printed above.',
    '  3. Choose the database, let it verify the connection, then create the admin account.',
    '',
  ];
  if (inContainer) {
    lines.push(
      `  Container: listening on ${host} so the published host port can reach it.`,
      '  Publish the port on the host loopback to keep it off the local network, e.g.',
      '    -p 127.0.0.1:<host-port>:3001',
      '  Until an admin account exists the setup token is the only thing protecting this page.',
      '',
    );
  }
  if (isRunningInContainer() && containerNeedsEnvHandoff()) {
    lines.push(
      '  Container detected: the final step shows a modal that copies the .env content',
      '  so you can paste it into the .env next to your docker-compose.yml.',
      '',
    );
  } else {
    lines.push(`  Configuration will be written to ${resolveEnvPath()}`, '');
  }
  process.stdout.write(lines.join('\n'));

  attachShutdown(api);
  await api.start();
  console.log(`  Setup mode: every API route except /api/setup/* answers 503 until setup completes.`);
}

async function startNormalMode(dbProvider: string): Promise<void> {
  const host = env('HOST') || DEFAULT_HOST;
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    // checkConfig() already reports this; setup mode is the only way forward.
    return startSetupMode(['MCP_ENCRYPTION_KEY']);
  }

  let storage: any;
  let storageName = 'sqlite';
  const cfg = storageConfigFromEnv(dbProvider, encryptionKey);

  try {
    storage = await buildStorage(cfg);
    storageName = dbProvider === 'd1' ? 'cloudflare-d1' : 'sqlite';
    if (dbProvider === 'd1') {
      console.log(`[mcp-ecc] Cloudflare D1 storage initialized (DB: ${cfg.dbConfig.CLOUDFLARE_DATABASE_ID})`);
      console.log('[mcp-ecc] Cloudflare D1 schema verified and initialized.');
    } else {
      console.log(`[mcp-ecc] SQLite storage initialized at ${cfg.dbConfig.MCP_STORAGE_FILE}`);
    }
  } catch (e: any) {
    console.error(`[mcp-ecc] Critical: Storage provider initialization failed: ${e.message}`);
    process.exit(1);
  }

  // Bootstrap guidance: if no users exist, the web UI shows the create-admin screen.
  let hasUsers = false;
  try {
    hasUsers = (await storage.countUsers()) > 0;
  } catch { /* ignore */ }

  const api = new ManagementApi({
    storage,
    createStorage: (resolved) => buildStorage(resolved),
    createD1Probe,
    port: PORT,
    host,
    publicDir,
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
  });

  api.start().then(() => {
    console.log(`mcp-ecc management API + MCP endpoint up on http://${host}:${PORT}`);
    console.log(`  - Web UI:        ${PUBLIC_URL}`);
    console.log(`  - MCP endpoint:  ${PUBLIC_URL}/mcp  (per-user Bearer API key required)`);
    console.log(`  - Storage:       ${storageName}`);
    if (!hasUsers) {
      console.log(`  - First run:     open ${PUBLIC_URL} to create the admin account`);
    }
    if (!SESSION_SECRET) {
      console.log('  - SESSION_SECRET: not set — one was generated and stored in the env file');
    }
  }).catch((error) => {
    console.error('Failed to start mcp-ecc API:', error);
    process.exit(1);
  });

  attachShutdown(api);
}

async function main(): Promise<void> {
  // Optional dependency: only needed when the wizard verifies D1.
  try {
    d1Module = await import('@mcp-ecc/storage-d1');
  } catch { /* D1 not installed */ }

  const check = checkConfig();
  const provider = (check.dbProvider || '').trim();
  const providerValid = provider === 'sqlite' || provider === 'd1';

  const missing = [...check.missing];
  if (provider && !providerValid) {
    missing.push(`MCP_DB_PROVIDER must be "sqlite" or "d1" (got "${provider}")`);
  }

  if (check.valid && providerValid) {
    await startNormalMode(provider);
    return;
  }

  // Unconfigured: do NOT exit. Start the setup server instead.
  await startSetupMode(missing);
}

main().catch((error) => {
  console.error('Failed to start mcp-ecc API:', error);
  process.exit(1);
});
