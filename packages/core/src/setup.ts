/**
 * First-run setup engine (shared by the CLI and the management API).
 *
 * Core cannot import a storage adapter: `@mcp-ecc/storage-*` depends on core, so
 * importing one here would create a package cycle. The caller therefore injects
 * two factories:
 *   - createStorage(cfg)  -> builds the concrete StorageAdapter
 *   - createD1Probe(cfg)  -> builds a raw D1 probe used to verify the connection
 *
 * Steps, in order:
 *   database -> database-config -> verify-connection -> encryption-key ->
 *   server -> admin -> apply (write .env, construct storage, create admin)
 *
 * No secret value produced here is ever printed by this module. Callers may show
 * a generated .env to the operator through an explicit, opt-in handoff (the
 * container case), where the content is returned as data — never logged.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';
import {
  ENCRYPTION_KEY_VAR,
  buildEnvContent,
  containerNeedsEnvHandoff,
  generateEncryptionKey,
  generateSessionSecret,
  getEncryptionKey,
  isRunningInContainer,
  resolveEnvPath,
  verifyDBConnection,
  writeEnvFile,
  type DBConnectionProbe,
  type EnvConfig,
} from './config.js';
import { AuthService } from './auth.js';
import type { StorageAdapter } from './storage.js';
import type { User } from './types.js';

// --- Errors ----------------------------------------------------------------

/** Configuration is missing/incomplete: the setup flow must run first. */
export class SetupRequiredError extends Error {
  readonly reason: string;
  constructor(message: string, reason = 'not-configured') {
    super(message);
    this.name = 'SetupRequiredError';
    this.reason = reason;
  }
}

/** A setup step could not be completed (connection failure, storage failure). */
export class SetupError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'SetupError';
    this.detail = detail;
  }
}

/** One or more setup answers failed validation. */
export class SetupValidationError extends SetupError {
  readonly errors: Record<string, string[]>;
  constructor(errors: Record<string, string[]>, message = 'Invalid setup configuration') {
    super(message);
    this.name = 'SetupValidationError';
    this.errors = errors;
  }
}

// --- Prompt surface --------------------------------------------------------

export interface SetupChoice {
  value: string;
  label: string;
  description?: string;
}

export interface SetupPromptOptions {
  /** Value used when the operator submits an empty answer. */
  default?: string;
  /** The answer must not be echoed (passwords, api tokens, master key). */
  secret?: boolean;
  /** Present a list instead of free text; the answer is a choice `value`. */
  choices?: SetupChoice[];
  /** Inline validation; return an error string to reject the answer. */
  validate?: (value: string) => string | null;
}

/**
 * Everything the engine needs from its host. The CLI implements this with
 * readline, the management API implements it with request/response pairs.
 */
export interface SetupIO {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  prompt(question: string, options?: SetupPromptOptions): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  /** Optional long-running progress note (no secret values). */
  progress?(message: string): void;
}

// --- Answers / configuration ----------------------------------------------

export type SetupDatabaseProvider = 'sqlite' | 'd1';

export interface SetupD1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

export interface SetupAdminAnswers {
  username?: string;
  password?: string;
  displayName?: string;
}

/** Loosely-typed answers as they travel over the wire / through prompts. */
export interface SetupAnswers {
  dbProvider?: string;
  storageFile?: string;
  d1?: Partial<SetupD1Config>;
  /** Absent means "generate one". `'generate'` is accepted as an explicit alias. */
  encryptionKey?: string;
  port?: string | number;
  host?: string;
  publicUrl?: string;
  /** Generated independently of the master key unless supplied explicitly. */
  sessionSecret?: string;
  admin?: SetupAdminAnswers;
}

export interface ResolvedSetupConfig {
  dbProvider: SetupDatabaseProvider;
  dbConfig: Record<string, string>;
  encryptionKey: string;
  encryptionKeyGenerated: boolean;
  serverConfig: { port: string; host: string; publicUrl: string; sessionSecret: string };
  sessionSecretGenerated: boolean;
  envPath: string;
  envContent: string;
  inContainer: boolean;
  handoff: boolean;
}

export const SETUP_STEPS = [
  'database',
  'database-config',
  'verify-connection',
  'encryption-key',
  'server',
  'admin',
  'apply',
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number];

export interface SetupStepValidation {
  step: SetupStepId;
  valid: boolean;
  errors: string[];
}

export const SETUP_DEFAULT_PORT = '3001';
export const SETUP_DEFAULT_HOST = '0.0.0.0';
/** Bind address used while the API runs in setup mode. */
export const SETUP_MODE_HOST = '127.0.0.1';
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

export function defaultStorageFile(cwd: string = process.cwd()): string {
  return resolvePath(cwd, 'data', 'mcp-ecc.db');
}

// --- Primitives ------------------------------------------------------------

/** Constant-time string comparison (length differences must not leak). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Human-typeable one-time setup token (128 bits). */
export function generateSetupToken(): string {
  return randomBytes(16).toString('hex');
}

/** True for the addresses a local operator can reach without a proxy. */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  let value = String(ip).trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value === '::1' || value === 'localhost') return true;
  if (value === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Cookie-signing secret, decoupled from the master encryption key.
 *
 * Order: explicit config -> SESSION_SECRET in the environment -> generated and
 * appended to the .env file -> ephemeral (last resort, sessions do not survive
 * a restart). There is deliberately no hardcoded fallback.
 */
export function resolveSessionSecret(envPath?: string): {
  secret: string;
  source: 'env' | 'generated' | 'ephemeral';
  persisted: boolean;
} {
  const existing = process.env.SESSION_SECRET?.trim();
  if (existing) return { secret: existing, source: 'env', persisted: true };

  const secret = generateSessionSecret();
  const target = envPath || resolveEnvPath();
  try {
    mkdirSync(dirname(target), { recursive: true });
    const block = `\n# Session-cookie signing secret (independent of ${ENCRYPTION_KEY_VAR})\nSESSION_SECRET=${secret}\n`;
    appendFileSync(target, block, { mode: 0o600 });
    process.env.SESSION_SECRET = secret;
    return { secret, source: 'generated', persisted: true };
  } catch {
    // Cannot persist (read-only fs / container handoff). Use it in-memory only.
    process.env.SESSION_SECRET = secret;
    return { secret, source: 'ephemeral', persisted: false };
  }
}

/** Test whether a raw D1 configuration is reachable. */
export async function verifyD1Connection(
  cfg: SetupD1Config,
  createProbe?: (cfg: SetupD1Config) => DBConnectionProbe,
): Promise<{ success: boolean; error?: string }> {
  if (!createProbe) {
    return { success: false, error: 'd1 connection probe not provided by caller' };
  }
  return verifyDBConnection({ dbProvider: 'd1', createProbe: () => createProbe(cfg) });
}

// --- Validation ------------------------------------------------------------

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateSetupStep(step: SetupStepId, answers: SetupAnswers): SetupStepValidation {
  const errors: string[] = [];
  const provider = (answers.dbProvider || '').trim();

  switch (step) {
    case 'database': {
      if (!provider) errors.push('Select a database provider (sqlite or d1).');
      else if (provider !== 'sqlite' && provider !== 'd1') {
        errors.push(`Unsupported database provider "${provider}". Allowed: sqlite, d1.`);
      }
      break;
    }

    case 'database-config': {
      if (provider === 'd1' || (!provider && answers.d1)) {
        const d1 = answers.d1 || {};
        if (!d1.accountId?.trim()) errors.push('CLOUDFLARE_ACCOUNT_ID is required');
        if (!d1.databaseId?.trim()) errors.push('CLOUDFLARE_DATABASE_ID is required');
        if (!d1.apiToken?.trim()) errors.push('CLOUDFLARE_API_TOKEN is required');
      } else if (provider === 'sqlite') {
        if (!answers.storageFile?.trim()) errors.push('MCP_STORAGE_FILE (path to SQLite database file) is required');
      } else {
        errors.push('Select a database provider first.');
      }
      break;
    }

    case 'verify-connection': {
      // The verification step is inherently run, not validated; the provider
      // config it depends on is validated instead.
      const cfg = validateSetupStep('database-config', answers);
      errors.push(...cfg.errors);
      break;
    }

    case 'encryption-key': {
      const key = answers.encryptionKey?.trim();
      // Absent (or the explicit 'generate' sentinel) means "generate one".
      if (key && key !== 'generate') {
        if (key.length < MIN_ENCRYPTION_KEY_LENGTH) {
          errors.push(`${ENCRYPTION_KEY_VAR} must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters (openssl rand -hex 32)`);
        }
        if (key === 'default-secret-key') {
          errors.push(`${ENCRYPTION_KEY_VAR} must not be the placeholder value`);
        }
      }
      break;
    }

    case 'server': {
      const port = String(answers.port ?? SETUP_DEFAULT_PORT).trim();
      const portNumber = Number(port);
      if (!/^\d+$/.test(port) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        errors.push('PORT must be an integer between 1 and 65535');
      }
      if (answers.host !== undefined && !String(answers.host).trim()) {
        errors.push('HOST must not be empty (use 0.0.0.0 for all interfaces)');
      }
      if (answers.publicUrl !== undefined && String(answers.publicUrl).trim() && !isHttpUrl(String(answers.publicUrl).trim())) {
        errors.push('PUBLIC_URL must be an absolute http(s) URL (e.g. http://localhost:3001)');
      }
      break;
    }

    case 'admin': {
      const admin = answers.admin;
      if (admin && (admin.username !== undefined || admin.password !== undefined || admin.displayName !== undefined)) {
        const username = admin.username?.trim();
        if (!username) errors.push('Admin username is required');
        else if (/\s/.test(username)) errors.push('Admin username must not contain spaces');
        if (!admin.password) errors.push('Admin password is required');
        else if (admin.password.length < 8) errors.push('Admin password must be at least 8 characters');
      }
      break;
    }

    case 'apply': {
      for (const step of ['database', 'database-config', 'encryption-key', 'server', 'admin'] as SetupStepId[]) {
        errors.push(...validateSetupStep(step, answers).errors);
      }
      break;
    }

    default: {
      errors.push(`Unknown setup step: ${String(step)}`);
    }
  }

  return { step, valid: errors.length === 0, errors };
}

export function validateSetupAnswers(answers: SetupAnswers): { valid: boolean; errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  for (const step of ['database', 'database-config', 'encryption-key', 'server', 'admin'] as SetupStepId[]) {
    const result = validateSetupStep(step, answers);
    if (!result.valid) errors[step] = result.errors;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// --- Resolution ------------------------------------------------------------

export interface ResolveSetupOptions {
  envPath?: string;
  createdAt?: number;
}

/** Fill defaults, generate the missing secrets and render the .env content. */
export function resolveSetupConfig(answers: SetupAnswers, options: ResolveSetupOptions = {}): ResolvedSetupConfig {
  const validation = validateSetupAnswers(answers);
  if (!validation.valid) throw new SetupValidationError(validation.errors);

  const dbProvider = (answers.dbProvider || '').trim() as SetupDatabaseProvider;

  const port = String(answers.port ?? SETUP_DEFAULT_PORT).trim() || SETUP_DEFAULT_PORT;
  const host = (answers.host ?? SETUP_DEFAULT_HOST).trim() || SETUP_DEFAULT_HOST;
  const publicUrl = (answers.publicUrl ?? '').trim() || `http://localhost:${port}`;

  // The master key and the cookie secret are generated independently.
  // An absent key means "reuse the configured one, else generate"; the explicit
  // 'generate' sentinel forces a brand-new key.
  const suppliedKey = answers.encryptionKey?.trim();
  let encryptionKey: string;
  let encryptionKeyGenerated: boolean;
  if (suppliedKey && suppliedKey !== 'generate') {
    encryptionKey = suppliedKey;
    encryptionKeyGenerated = false;
  } else if (suppliedKey === 'generate') {
    encryptionKey = generateEncryptionKey();
    encryptionKeyGenerated = true;
  } else {
    const existing = getEncryptionKey();
    encryptionKey = existing || generateEncryptionKey();
    encryptionKeyGenerated = !existing;
  }

  const suppliedSecret = answers.sessionSecret?.trim();
  const sessionSecretGenerated = !suppliedSecret;
  const sessionSecret = suppliedSecret || generateSessionSecret();

  const dbConfig: Record<string, string> =
    dbProvider === 'd1'
      ? {
          CLOUDFLARE_ACCOUNT_ID: (answers.d1?.accountId || '').trim(),
          CLOUDFLARE_DATABASE_ID: (answers.d1?.databaseId || '').trim(),
          CLOUDFLARE_API_TOKEN: (answers.d1?.apiToken || '').trim(),
        }
      : { MCP_STORAGE_FILE: (answers.storageFile || '').trim() };

  const inContainer = isRunningInContainer();
  const handoff = containerNeedsEnvHandoff();

  const envCfg: EnvConfig = {
    encryptionKey,
    dbProvider,
    dbConfig,
    // PORT and HOST_PORT get the same value: PORT is read by the API, HOST_PORT
    // by docker-compose for the published port mapping.
    serverConfig: { port, host, publicUrl, sessionSecret },
  };

  return {
    dbProvider,
    dbConfig,
    encryptionKey,
    encryptionKeyGenerated,
    serverConfig: { port, host, publicUrl, sessionSecret },
    sessionSecretGenerated,
    envPath: options.envPath || resolveEnvPath(),
    envContent: buildEnvContent(envCfg),
    inContainer,
    handoff,
  };
}

// --- Dependencies ----------------------------------------------------------

export interface SetupDeps {
  /** Build the storage adapter from the resolved configuration. */
  createStorage: (cfg: ResolvedSetupConfig) => StorageAdapter | Promise<StorageAdapter>;
  /** Raw D1 probe factory used to verify the connection before writing .env. */
  createD1Probe?: (cfg: SetupD1Config) => DBConnectionProbe;
  /** Where to write .env. Defaults to core's resolveEnvPath(). */
  envPath?: string;
  /** Write the file. Default: true, unless the container handoff is used. */
  writeEnv?: boolean;
  /** Return the rendered .env as data so the caller can copy it. Default: container handoff. */
  returnEnvContent?: boolean;
  /** Container detection override (tests). */
  isContainer?: () => boolean;
  /** Auth service override (tests). */
  createAuthService?: (storage: StorageAdapter) => AuthService;
  /** Skip the pre-apply connection verification (the caller already verified). */
  skipVerify?: boolean;
}

export interface SetupApplyResult {
  ok: boolean;
  dbProvider: SetupDatabaseProvider;
  envPath: string;
  envWritten: boolean;
  handoff: boolean;
  handoffInstructions?: string[];
  /** Present only when the caller opted into the handoff (never logged). */
  envContent?: string;
  encryptionKeyGenerated: boolean;
  sessionSecretGenerated: boolean;
  storage: StorageAdapter;
  usersExisted: boolean;
  adminCreated?: Pick<User, 'id' | 'username' | 'displayName' | 'role'>;
  restartRequired: boolean;
  nextSteps: string[];
}

/** Variables an operator must pass through docker-compose for the container. */
export function requiredEnvVariables(cfg: { dbProvider: SetupDatabaseProvider }): string[] {
  const base = [
    ENCRYPTION_KEY_VAR,
    'MCP_DB_PROVIDER',
    'HOST_PORT',
    'PORT',
    'HOST',
    'PUBLIC_URL',
    'SESSION_SECRET',
  ];
  return cfg.dbProvider === 'd1'
    ? [...base, 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']
    : [...base, 'MCP_STORAGE_FILE'];
}

export function handoffInstructions(cfg: { dbProvider: SetupDatabaseProvider; envPath: string }): string[] {
  return [
    'Copy the generated .env content with the copy button — it is never rendered on screen.',
    'Paste it into the .env file that sits next to your docker-compose.yml (on your host, not inside the container).',
    `Make sure docker-compose.yml passes these variables into the container: ${requiredEnvVariables(cfg).join(', ')}.`,
    'Map the published port from HOST_PORT, e.g.  ports: ["${HOST_PORT:-3001}:3001"]  and keep the container-internal PORT at 3001.',
    'Recreate the container so the new environment takes effect:  docker compose up -d --force-recreate',
  ];
}

// --- Apply -----------------------------------------------------------------

/** Verify the database connection described by the answers. */
export async function verifySetupDatabase(
  answers: SetupAnswers,
  deps: Pick<SetupDeps, 'createD1Probe'>,
): Promise<{ success: boolean; error?: string; provider: string }> {
  const provider = (answers.dbProvider || '').trim();
  if (provider === 'd1') {
    const cfg: SetupD1Config = {
      accountId: (answers.d1?.accountId || '').trim(),
      databaseId: (answers.d1?.databaseId || '').trim(),
      apiToken: (answers.d1?.apiToken || '').trim(),
    };
    const result = await verifyD1Connection(cfg, deps.createD1Probe);
    return { ...result, provider };
  }
  const result = await verifyDBConnection({
    dbProvider: provider,
    storageFile: answers.storageFile?.trim(),
  });
  return { ...result, provider };
}

/**
 * Terminal step: verify the connection, write .env, construct storage, create
 * the first admin when the database is empty, and describe the next steps.
 */
export async function applySetup(answers: SetupAnswers, deps: SetupDeps): Promise<SetupApplyResult> {
  const cfg = resolveSetupConfig(answers, { envPath: deps.envPath });

  if (!deps.skipVerify) {
    const probe = await verifySetupDatabase(answers, deps);
    if (!probe.success) {
      throw new SetupError('Database connection could not be verified', probe.error);
    }
  }

  const container = deps.isContainer ? deps.isContainer() : cfg.inContainer;
  const wantHandoff = deps.returnEnvContent !== undefined ? deps.returnEnvContent : container && cfg.handoff;
  const writeEnv = deps.writeEnv !== undefined ? deps.writeEnv : !wantHandoff;

  let envWritten = false;
  if (writeEnv) {
    try {
      mkdirSync(dirname(cfg.envPath), { recursive: true });
      writeEnvFile(cfg.envPath, cfg.envContent);
      envWritten = true;
    } catch (error) {
      throw new SetupError(
        `Could not write ${cfg.envPath}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Make the new values visible to this process (storage construction below and
  // any child process started afterwards).
  process.env.MCP_DB_PROVIDER = cfg.dbProvider;
  process.env[ENCRYPTION_KEY_VAR] = cfg.encryptionKey;
  process.env.PORT = cfg.serverConfig.port;
  process.env.HOST_PORT = cfg.serverConfig.port;
  process.env.HOST = cfg.serverConfig.host;
  process.env.PUBLIC_URL = cfg.serverConfig.publicUrl;
  process.env.SESSION_SECRET = cfg.serverConfig.sessionSecret;
  for (const [key, value] of Object.entries(cfg.dbConfig)) process.env[key] = value;

  let storage: StorageAdapter;
  try {
    storage = await deps.createStorage(cfg);
  } catch (error) {
    throw new SetupError(
      'Storage initialization failed after writing the configuration',
      error instanceof Error ? error.message : String(error),
    );
  }

  const auth = deps.createAuthService ? deps.createAuthService(storage) : new AuthService(storage);
  let usersExisted = false;
  try {
    usersExisted = (await storage.countUsers()) > 0;
  } catch (error) {
    throw new SetupError(
      'The database was reached but could not be read (schema missing or wrong credentials)',
      error instanceof Error ? error.message : String(error),
    );
  }

  let adminCreated: SetupApplyResult['adminCreated'];
  const admin = answers.admin;
  if (!usersExisted && admin?.username && admin?.password) {
    try {
      const user = await auth.createUser({
        username: admin.username.trim(),
        displayName: admin.displayName?.trim() || admin.username.trim(),
        password: admin.password,
        role: 'admin',
      });
      adminCreated = { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
    } catch (error) {
      throw new SetupError(
        'Storage is ready but the admin account could not be created',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const nextSteps: string[] = [];
  if (wantHandoff) {
    nextSteps.push('Copy the .env content into your compose-folder .env, then recreate the container.');
  } else if (envWritten) {
    nextSteps.push(`Configuration written to ${cfg.envPath}`);
  }
  if (!adminCreated && !usersExisted) {
    nextSteps.push('Create the administrator account (setup was run without admin credentials).');
  }
  nextSteps.push('Restart the management API so the new environment is loaded.');

  return {
    ok: true,
    dbProvider: cfg.dbProvider,
    envPath: cfg.envPath,
    envWritten,
    handoff: wantHandoff,
    handoffInstructions: wantHandoff ? handoffInstructions({ dbProvider: cfg.dbProvider, envPath: cfg.envPath }) : undefined,
    envContent: wantHandoff ? cfg.envContent : undefined,
    encryptionKeyGenerated: cfg.encryptionKeyGenerated,
    sessionSecretGenerated: cfg.sessionSecretGenerated,
    storage,
    usersExisted,
    adminCreated,
    restartRequired: wantHandoff || !envWritten,
    nextSteps,
  };
}

// --- Interactive runner (CLI) ---------------------------------------------

export interface RunSetupOptions extends SetupDeps {
  /** How many verification attempts before giving up entirely. */
  maxVerifyAttempts?: number;
  /** Provide the admin answers; when omitted the flow asks for them. */
  answers?: SetupAnswers;
  sleep?: (ms: number) => Promise<void>;
}

async function askField(
  io: SetupIO,
  question: string,
  options: SetupPromptOptions,
  assign: (value: string) => void,
  validate: (value: string) => string | null = () => null,
): Promise<string> {
  for (;;) {
    const raw = await io.prompt(question, options);
    const value = raw.trim() === '' && options.default !== undefined ? options.default : raw.trim();
    const error = validate(value);
    if (!error) {
      assign(value);
      return value;
    }
    io.error(error);
  }
}

async function askDatabaseConfig(io: SetupIO, answers: SetupAnswers): Promise<void> {
  if (answers.dbProvider === 'd1') {
    const d1: SetupD1Config = {
      accountId: answers.d1?.accountId || '',
      databaseId: answers.d1?.databaseId || '',
      apiToken: answers.d1?.apiToken || '',
    };
    const required = (name: string) => (value: string) => (value ? null : `${name} is required`);
    await askField(io, 'CLOUDFLARE_ACCOUNT_ID: ', { default: d1.accountId || undefined }, (v) => { d1.accountId = v; }, required('CLOUDFLARE_ACCOUNT_ID'));
    await askField(io, 'CLOUDFLARE_DATABASE_ID: ', { default: d1.databaseId || undefined }, (v) => { d1.databaseId = v; }, required('CLOUDFLARE_DATABASE_ID'));
    await askField(io, 'CLOUDFLARE_API_TOKEN (D1:Edit): ', { secret: true }, (v) => { d1.apiToken = v; }, required('CLOUDFLARE_API_TOKEN'));
    answers.d1 = d1;
  } else {
    const fallback = answers.storageFile || defaultStorageFile();
    await askField(
      io,
      `SQLite database file [${fallback}]: `,
      { default: fallback },
      (v) => { answers.storageFile = v; },
      (value) => (value ? null : 'MCP_STORAGE_FILE is required'),
    );
  }

  const check = validateSetupStep('database-config', answers);
  if (!check.valid) throw new SetupValidationError({ 'database-config': check.errors });
}

/**
 * Drive the whole flow through a SetupIO. Returns the apply result, or null when
 * the operator aborts.
 */
export async function runSetup(io: SetupIO, options: RunSetupOptions): Promise<SetupApplyResult | null> {
  const answers: SetupAnswers = { ...(options.answers || {}) };
  const maxVerifyAttempts = options.maxVerifyAttempts ?? 5;

  io.info('mcp-ecc first-run setup');
  io.info('This writes a .env file and prepares the database.');

  // 1. Database provider
  if (!answers.dbProvider) {
    const choice = await io.prompt('Database provider', {
      choices: [
        { value: 'sqlite', label: 'SQLite (local file, zero configuration)' },
        { value: 'd1', label: 'Cloudflare D1 (hosted, needs API credentials)' },
      ],
      default: 'sqlite',
    });
    answers.dbProvider = choice.trim() || 'sqlite';
  }
  io.info(`Database provider: ${answers.dbProvider}`);

  // 2. + 3. Provider config, verified for real before anything is written.
  let attempts = 0;
  for (;;) {
    await askDatabaseConfig(io, answers);

    const check = validateSetupStep('database-config', answers);
    if (!check.valid) {
      io.error(check.errors.join('\n'));
      continue;
    }

    io.progress?.(`Verifying the ${answers.dbProvider} connection…`);
    const probe = await verifySetupDatabase(answers, options);
    if (probe.success) {
      io.info('Database connection verified.');
      break;
    }

    attempts += 1;
    io.error(`Database connection failed: ${probe.error || 'unknown error'}`);
    if (attempts >= maxVerifyAttempts) {
      io.error('Giving up after repeated connection failures. Nothing was written.');
      return null;
    }
    const retry = await io.confirm('Re-enter the database configuration?', true);
    if (!retry) {
      io.warn('Setup aborted. Nothing was written.');
      return null;
    }
  }

  // 4. Encryption key (generated unless the operator supplies one).
  const existingKey = getEncryptionKey();
  if (existingKey) {
    const reuse = await io.confirm(`${ENCRYPTION_KEY_VAR} is already set in the environment. Reuse it?`, true);
    // Reuse keeps the configured key; declining forces a brand-new one.
    answers.encryptionKey = reuse ? existingKey : 'generate';
  } else {
    const generate = await io.confirm(`Generate a new ${ENCRYPTION_KEY_VAR}?`, true);
    if (generate) {
      answers.encryptionKey = 'generate';
      io.info(`${ENCRYPTION_KEY_VAR} will be generated and written to the .env file.`);
    } else {
      await askField(
        io,
        `${ENCRYPTION_KEY_VAR}: `,
        { secret: true },
        (v) => { answers.encryptionKey = v; },
        (value) => validateSetupStep('encryption-key', { ...answers, encryptionKey: value }).errors[0] || null,
      );
    }
  }

  // 5. Server configuration (session secret is generated independently).
  const port = await io.prompt(`PORT [${answers.port ?? SETUP_DEFAULT_PORT}]: `, {
    default: String(answers.port ?? SETUP_DEFAULT_PORT),
  });
  answers.port = port.trim() || SETUP_DEFAULT_PORT;

  const host = await io.prompt(`HOST (bind address) [${answers.host ?? SETUP_DEFAULT_HOST}]: `, {
    default: String(answers.host ?? SETUP_DEFAULT_HOST),
  });
  answers.host = host.trim() || SETUP_DEFAULT_HOST;

  const publicUrl = await io.prompt(`PUBLIC_URL [http://localhost:${answers.port}]: `, {
    default: `http://localhost:${answers.port}`,
  });
  answers.publicUrl = publicUrl.trim() || `http://localhost:${answers.port}`;

  const serverCheck = validateSetupStep('server', answers);
  if (!serverCheck.valid) {
    io.error(serverCheck.errors.join('\n'));
    return null;
  }
  io.info('SESSION_SECRET will be generated independently of the master key.');

  // 6. Admin account (only used when the database has no users yet).
  if (!answers.admin) {
    const createAdmin = await io.confirm('Create the administrator account now?', true);
    if (createAdmin) {
      const adminAnswers: SetupAdminAnswers = {};
      // Bounded: a prompt surface that cannot produce a valid answer must not
      // spin forever (the engine also runs behind an HTTP-driven UI).
      const maxAdminAttempts = 5;
      let adminAttempt = 0;
      for (;;) {
        adminAttempt += 1;
        const candidate: SetupAnswers = { ...answers, admin: { ...adminAnswers } };
        const username = await io.prompt('Admin username: ', { default: 'admin' });
        adminAnswers.username = username.trim() || 'admin';
        const displayName = await io.prompt('Admin display name: ', { default: adminAnswers.username });
        adminAnswers.displayName = displayName.trim() || adminAnswers.username;
        const password = await io.prompt('Admin password: ', { secret: true });
        const confirmPassword = await io.prompt('Confirm admin password: ', { secret: true });
        if (password !== confirmPassword) {
          io.error('Passwords do not match.');
          if (adminAttempt >= maxAdminAttempts) {
            io.warn('Too many invalid attempts — skipping admin creation.');
            break;
          }
          continue;
        }
        adminAnswers.password = password;
        const check = validateSetupStep('admin', { ...candidate, admin: adminAnswers });
        if (check.valid) break;
        io.error(check.errors.join('\n'));
        if (adminAttempt >= maxAdminAttempts) {
          io.warn('Too many invalid attempts — skipping admin creation.');
          break;
        }
      }
      const adminCheck = validateSetupStep('admin', { ...answers, admin: adminAnswers });
      if (adminCheck.valid) answers.admin = adminAnswers;
    } else {
      io.warn('Skipping admin creation. The database will have no users until you create one.');
    }
  }

  // 7. Apply: write .env, construct storage, create the admin, report.
  io.progress?.('Applying configuration…');
  const result = await applySetup(answers, options);

  if (result.handoff) {
    io.warn(`Container detected: ${result.envPath} will not survive a container recreate.`);
    for (const line of result.handoffInstructions || []) io.info(`  - ${line}`);
  } else if (result.envWritten) {
    io.info(`Configuration written to ${result.envPath} (mode 600).`);
  }
  if (result.adminCreated) {
    io.info(`Administrator created: @${result.adminCreated.username}`);
  } else if (result.usersExisted) {
    io.info('Users already exist in this database; no admin was created.');
  }
  if (result.usersExisted && result.encryptionKeyGenerated) {
    io.warn(
      `This database already has user accounts and a NEW ${ENCRYPTION_KEY_VAR} was written. ` +
        'Credentials stored with the previous key can no longer be decrypted — restore the original key if that was not intended.',
    );
  }
  io.info('Next steps:');
  for (const step of result.nextSteps) io.info(`  - ${step}`);
  io.info(`Database provider: ${result.dbProvider}`);

  return result;
}
