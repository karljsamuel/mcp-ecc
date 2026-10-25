import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

// Resolve .env path respecting MCP_ENV_FILE or cwd.
// Works for a local checkout, a global npm install, and a Docker container.
export function resolveEnvPath(): string {
  return process.env.MCP_ENV_FILE || resolve(process.cwd(), '.env');
}

export function loadEnv(envPath?: string): void {
  config({ path: envPath || resolveEnvPath(), override: true });
}

export const ENCRYPTION_KEY_VAR = 'MCP_ENCRYPTION_KEY';

// Placeholder values that must never be accepted as a real key. The first is the
// historical fallback; the rest are what .env.example and older docs told people
// to paste in, so a verbatim copy must fail loudly rather than encrypt real
// credentials under a publicly known string.
export const PLACEHOLDER_ENCRYPTION_KEYS: ReadonlySet<string> = new Set([
  'default-secret-key',
  'change-me',
  'change-me-to-a-long-random-secret',
  'changeme',
  'your-secret-here',
  'replace-me',
]);

export function isPlaceholderEncryptionKey(key: string | undefined | null): boolean {
  const trimmed = (key ?? '').trim();
  if (!trimmed) return true;
  return PLACEHOLDER_ENCRYPTION_KEYS.has(trimmed.toLowerCase());
}

// There is deliberately no fallback here. A missing or placeholder key is a
// hard configuration error: falling back to a constant would encrypt real
// credentials under a publicly known key.
export function getEncryptionKey(): string | undefined {
  const key = process.env[ENCRYPTION_KEY_VAR]?.trim();
  if (!key) return undefined;
  if (PLACEHOLDER_ENCRYPTION_KEYS.has(key.toLowerCase())) return undefined;
  return key;
}

export interface ConfigCheckResult {
  valid: boolean;
  missing: string[];
  dbProvider: string;
}

export function checkConfig(): ConfigCheckResult {
  const missing: string[] = [];
  const dbProvider = (process.env.MCP_DB_PROVIDER || process.env.DB_PROVIDER || '').trim();

  if (!dbProvider) missing.push('MCP_DB_PROVIDER (sqlite or d1)');

  if (!getEncryptionKey()) {
    missing.push('MCP_ENCRYPTION_KEY (generate with: openssl rand -hex 32)');
  }

  if (dbProvider === 'd1') {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!process.env.CLOUDFLARE_DATABASE_ID) missing.push('CLOUDFLARE_DATABASE_ID');
    if (!process.env.CLOUDFLARE_API_TOKEN) missing.push('CLOUDFLARE_API_TOKEN (with D1:Edit permission)');
  }

  if (dbProvider === 'sqlite') {
    if (!process.env.MCP_STORAGE_FILE) missing.push('MCP_STORAGE_FILE (path to SQLite database file)');
  }

  return { valid: missing.length === 0, missing, dbProvider };
}

// --- Database connection verification -------------------------------------
//
// core cannot import a storage adapter: the adapters depend on core, so doing
// so creates a package cycle that breaks the TypeScript build. Instead the
// caller injects a probe. The CLI and management API already construct the
// concrete adapter, so they pass `() => new CloudflareD1Database(...)`.

export interface DBConnectionProbe {
  prepare(sql: string): { first(): Promise<unknown> };
}

export type DBProbeFactory = () => DBConnectionProbe;

export interface DBVerifyTarget {
  dbProvider: string;
  storageFile?: string;
  createProbe?: DBProbeFactory;
}

export async function verifyDBConnection(
  target: DBVerifyTarget | string,
): Promise<{ success: boolean; error?: string }> {
  // Accept the legacy string form for backwards compatibility.
  const cfg: DBVerifyTarget =
    typeof target === 'string' ? { dbProvider: target } : target;

  try {
    if (cfg.dbProvider === 'd1') {
      if (!cfg.createProbe) {
        return { success: false, error: 'd1 connection probe not provided by caller' };
      }
      await cfg.createProbe().prepare('SELECT 1').first();
      return { success: true };
    }

    if (cfg.dbProvider === 'sqlite') {
      const storageFile = cfg.storageFile || process.env.MCP_STORAGE_FILE;
      if (!storageFile) return { success: false, error: 'MCP_STORAGE_FILE not set' };

      const dir = dirname(storageFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Prove the path is writable rather than merely present.
      const testFile = join(dir, '.write-test');
      writeFileSync(testFile, 'test');
      unlinkSync(testFile);

      // If a file already exists, refuse to treat a non-SQLite file as a
      // database. Read only the 16-byte magic header, never the whole file.
      if (existsSync(storageFile)) {
        const fd = openSync(storageFile, 'r');
        try {
          const header = Buffer.alloc(16);
          const read = readSync(fd, header, 0, 16, 0);
          if (read >= 15 && header.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
            return { success: false, error: `${storageFile} exists but is not a SQLite database` };
          }
        } finally {
          closeSync(fd);
        }
      }

      return { success: true };
    }

    return { success: false, error: `Unknown database provider: ${cfg.dbProvider}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}

export function generateSessionSecret(): string {
  return randomBytes(32).toString('hex');
}

// --- Container detection --------------------------------------------------
//
// In a container a written .env is lost on recreate unless MCP_ENV_FILE points
// into a mounted volume, so the setup flow offers a copy-paste handoff instead
// of pretending the file was persisted.

export function isRunningInContainer(): boolean {
  if (process.env.MCP_FORCE_CONTAINER === '1') return true;
  if (process.env.MCP_FORCE_CONTAINER === '0') return false;
  if (existsSync('/.dockerenv')) return true;
  try {
    if (readFileSync('/proc/1/cgroup', 'utf8').includes('docker')) return true;
  } catch {
    /* not Linux, or unreadable — fall through */
  }
  return process.env.container === 'docker' || process.env.KUBERNETES_SERVICE_HOST !== undefined;
}

// True when the container has no writable .env location it can rely on.
export function containerNeedsEnvHandoff(): boolean {
  if (!isRunningInContainer()) return false;
  // If MCP_ENV_FILE points somewhere persistent the operator opted in already.
  const configured = process.env.MCP_ENV_FILE;
  if (configured && existsSync(dirname(configured))) return false;
  return true;
}

// --- .env generation ------------------------------------------------------

export interface EnvConfig {
  encryptionKey: string;
  dbProvider: string;
  dbConfig: Record<string, string>;
  serverConfig: {
    port: string;
    host: string;
    publicUrl: string;
    sessionSecret: string;
  };
}

export function buildEnvContent(cfg: EnvConfig): string {
  const envLines = [
    '# mcp-ecc environment configuration',
    '# Generated by mcp-ecc setup',
    '',
    '# === Required ===',
    '# Master key used to encrypt stored credentials (AES-256-GCM).',
    '# Generate with:  openssl rand -hex 32',
    `${ENCRYPTION_KEY_VAR}=${cfg.encryptionKey}`,
    '',
    '# === Database Provider ===',
    `MCP_DB_PROVIDER=${cfg.dbProvider}`,
  ];

  if (cfg.dbProvider === 'd1') {
    envLines.push(
      '',
      '# --- Cloudflare D1 Configuration ---',
      `CLOUDFLARE_ACCOUNT_ID=${cfg.dbConfig.CLOUDFLARE_ACCOUNT_ID}`,
      `CLOUDFLARE_DATABASE_ID=${cfg.dbConfig.CLOUDFLARE_DATABASE_ID}`,
      `CLOUDFLARE_API_TOKEN=${cfg.dbConfig.CLOUDFLARE_API_TOKEN}`,
    );
  } else {
    envLines.push(
      '',
      '# --- SQLite Configuration ---',
      `MCP_STORAGE_FILE=${cfg.dbConfig.MCP_STORAGE_FILE}`,
    );
  }

  envLines.push(
    '',
    '# === Server / networking ===',
    '# PORT is what the management API and MCP server listen on.',
    `PORT=${cfg.serverConfig.port}`,
    '# HOST_PORT is the host-side port mapping read by docker-compose.',
    `HOST_PORT=${cfg.serverConfig.port}`,
    `HOST=${cfg.serverConfig.host}`,
    `PUBLIC_URL=${cfg.serverConfig.publicUrl}`,
    `SESSION_SECRET=${cfg.serverConfig.sessionSecret}`,
    '',
    '# === Optional: override the Docker image used by docker-compose ===',
    '# MCP_ECC_IMAGE=ghcr.io/karljsamuel/mcp-ecc:beta',
  );

  return envLines.join('\n') + '\n';
}

export function writeEnvFile(envPath: string, content: string): void {
  writeFileSync(envPath, content, { mode: 0o600 });
}
