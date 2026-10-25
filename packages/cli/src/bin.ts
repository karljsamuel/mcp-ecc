#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import {
  AuthService,
  OAuthManager,
  OAuthClient,
  ProviderName,
  checkConfig,
  getEncryptionKey,
  loadEnv,
  resolveEnvPath,
  runSetup,
  SetupRequiredError,
  type DBConnectionProbe,
  type SetupD1Config,
  type SetupIO,
  type SetupPromptOptions,
} from '@mcp-ecc/core';
import { McpEccServer } from '@mcp-ecc/mcp-server';

// Load .env before anything else. core's loadEnv honours MCP_ENV_FILE, so a
// global install, a local checkout and a container all resolve the same file.
let envLoaded = false;
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  loadEnv();
}
ensureEnvLoaded();

const env = (name: string): string | undefined => process.env[name]?.trim();

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

// --- Lazy runtime wiring ---------------------------------------------------
//
// NOTHING here runs at import time any more. `mcp-ecc setup` has to work on a
// completely unconfigured install, so configuration and storage are resolved
// inside the command that needs them (initStorage()).

let storage: any = null;
let storageName = 'sqlite';
let dbDir = process.cwd();
let authService: AuthService | null = null;
let oauthManager: OAuthManager | null = null;

function requireEncryptionKey(): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new SetupRequiredError(
      'MCP_ENCRYPTION_KEY is not set. Run `mcp-ecc setup` to generate one.',
      'missing-encryption-key',
    );
  }
  return key;
}

// Construct a storage adapter from an explicit configuration. Shared by the
// setup engine and the normal command path.
async function createCliStorage(cfg: {
  dbProvider: string;
  dbConfig: Record<string, string>;
  encryptionKey: string;
}): Promise<any> {
  if (cfg.dbProvider === 'd1') {
    const { D1Storage, CloudflareD1Database } = await import('@mcp-ecc/storage-d1');
    const db = new CloudflareD1Database(
      cfg.dbConfig.CLOUDFLARE_ACCOUNT_ID,
      cfg.dbConfig.CLOUDFLARE_DATABASE_ID,
      cfg.dbConfig.CLOUDFLARE_API_TOKEN,
    );
    const d1Storage = new D1Storage(db, cfg.encryptionKey);
    await d1Storage.initSchema();
    return d1Storage;
  }
  const { SQLiteStorage } = await import('@mcp-ecc/storage-sqlite');
  return new SQLiteStorage(cfg.dbConfig.MCP_STORAGE_FILE, cfg.encryptionKey);
}

// Resolve configuration + storage for a command that needs the database.
// Throws SetupRequiredError when the install is not configured yet.
async function initStorage(): Promise<void> {
  if (storage) return;

  ensureEnvLoaded();
  const check = checkConfig();
  const provider = (check.dbProvider || '').trim();
  if (!check.valid || (provider !== 'sqlite' && provider !== 'd1')) {
    const missing = check.missing.length > 0
      ? check.missing.join(', ')
      : `MCP_DB_PROVIDER must be "sqlite" or "d1" (got "${check.dbProvider}")`;
    throw new SetupRequiredError(`mcp-ecc is not configured yet: ${missing}. Run \`mcp-ecc setup\`.`, 'not-configured');
  }

  const dbProvider = provider as 'sqlite' | 'd1';
  const dbConfig: Record<string, string> = dbProvider === 'd1'
    ? {
        CLOUDFLARE_ACCOUNT_ID: env('CLOUDFLARE_ACCOUNT_ID') || '',
        CLOUDFLARE_DATABASE_ID: env('CLOUDFLARE_DATABASE_ID') || '',
        CLOUDFLARE_API_TOKEN: env('CLOUDFLARE_API_TOKEN') || '',
      }
    : { MCP_STORAGE_FILE: env('MCP_STORAGE_FILE') || '' };

  storageName = dbProvider === 'd1' ? 'cloudflare-d1' : 'sqlite';
  dbDir = dbProvider === 'd1' ? path.join(process.cwd(), 'data') : path.dirname(dbConfig.MCP_STORAGE_FILE);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    console.error(chalk.cyan(`[mcp-ecc] Created database directory at ${dbDir}`));
  }

  storage = await createCliStorage({ dbProvider, dbConfig, encryptionKey: requireEncryptionKey() });
  authService = new AuthService(storage);
  oauthManager = new OAuthManager(storage);
}

function auth(): AuthService {
  if (!authService) throw new Error('Storage is not initialised yet.');
  return authService;
}

function oauth(): OAuthManager {
  if (!oauthManager) throw new Error('Storage is not initialised yet.');
  return oauthManager;
}

function sessionFile(): string {
  return path.join(dbDir, 'cli-session.json');
}

function handleFatal(error: unknown): never {
  if (error instanceof SetupRequiredError) {
    console.error(chalk.red(`\n[mcp-ecc] ${error.message}\n`));
    process.exit(1);
  }
  console.error(chalk.red(`\n[mcp-ecc] Error: ${error instanceof Error ? error.message : String(error)}\n`));
  process.exit(1);
}

interface SessionData {
  userId: string;
}

function getSession(): SessionData | null {
  try {
    const file = sessionFile();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }
  } catch {}
  return null;
}

function saveSession(userId: string): void {
  writeFileSync(sessionFile(), JSON.stringify({ userId }), 'utf8');
}

function clearSession(): void {
  try {
    const file = sessionFile();
    if (existsSync(file)) {
      unlinkSync(file);
    }
  } catch {}
}

async function getLoggedInUser(): Promise<any | null> {
  await initStorage();
  const sess = getSession();
  if (!sess) return null;
  const user = await storage.getUser(sess.userId);
  return user;
}

async function ensureAuthenticated() {
  await initStorage();
  const userCount = await storage.countUsers();
  if (userCount === 0) {
    console.log(chalk.yellow('\nNo user accounts found. Please create the first admin account to get started.\n'));
    await handleLogin();
    const user = await getLoggedInUser();
    if (!user) process.exit(1);
    return user;
  }
  const user = await getLoggedInUser();
  if (!user) {
    console.log(chalk.red('\nError: Unauthorized. Please log in first.\n'));
    await handleLogin();
    const logged = await getLoggedInUser();
    if (!logged) process.exit(1);
    return logged;
  }
  return user;
}

const askQuestion = (rl: readline.Interface, query: string): Promise<string> => {
  return new Promise(resolve => rl.question(query, resolve));
};

const askPassword = (rl: readline.Interface, query: string): Promise<string> => {
  return new Promise(resolve => {
    const stdoutWrite = process.stdout.write;
    let isPromptDone = false;

    (process.stdout as any).write = (chunk: any, encoding?: any, callback?: any) => {
      if (isPromptDone) {
        return stdoutWrite.call(process.stdout, chunk, encoding, callback);
      }

      const str = chunk.toString();

      // Write query, newlines, and escape codes normally
      if (str.includes(query) || str === '\n' || str === '\r' || str === '\r\n' || str.startsWith('\x1b')) {
        return stdoutWrite.call(process.stdout, chunk, encoding, callback);
      }

      // Write backspace normally
      if (str === '\b \b') {
        return stdoutWrite.call(process.stdout, chunk, encoding, callback);
      }

      // Write asterisks for password characters
      const asterisks = '*'.repeat(str.length);
      return stdoutWrite.call(process.stdout, asterisks, encoding, callback);
    };

    rl.question(query, (password) => {
      isPromptDone = true;
      (process.stdout as any).write = stdoutWrite; // restore stdout
      resolve(password);
    });
  });
};

// --- First-run setup (CLI surface) -----------------------------------------
//
// The setup engine lives in @mcp-ecc/core; this is only the terminal
// implementation of its SetupIO.

interface CliSetupIO {
  io: SetupIO;
  close: () => void;
}

function createCliSetupIO(): CliSetupIO {
  // Two input modes:
  //  - a real terminal: readline, so secrets can be masked;
  //  - piped/redirected input (`mcp-ecc setup < answers.txt`): a plain line
  //    queue. readline's question() callback never fires once stdin hits EOF,
  //    which used to make a scripted run exit silently mid-flow. With the queue,
  //    EOF simply yields an empty answer and the engine's validation reports it.
  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  const queue: string[] = [];
  let partial = '';
  let closed = false;
  let waiter: ((line: string) => void) | null = null;

  const onData = (chunk: string) => {
    partial += chunk;
    for (let idx = partial.indexOf('\n'); idx >= 0; idx = partial.indexOf('\n')) {
      const line = partial.slice(0, idx).replace(/\r$/, '');
      partial = partial.slice(idx + 1);
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(line);
      } else {
        queue.push(line);
      }
    }
  };
  const onEnd = () => {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve('');
    }
  };

  if (!interactive) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  }

  const readLine = (promptText: string, secret: boolean): Promise<string> => {
    if (interactive && rl) {
      return secret ? askPassword(rl, promptText) : askQuestion(rl, promptText);
    }
    process.stdout.write(promptText);
    if (queue.length > 0) return Promise.resolve(queue.shift() as string);
    if (closed) return Promise.resolve('');
    return new Promise<string>((resolve) => { waiter = resolve; });
  };

  const withDefault = (raw: string, fallback?: string): string => {
    const trimmed = raw.trim();
    if (trimmed === '' && fallback !== undefined) return fallback;
    return trimmed;
  };

  const io: SetupIO = {
    info: (message) => console.log(message),
    warn: (message) => console.log(chalk.yellow(message)),
    error: (message) => console.error(chalk.red(message)),
    progress: (message) => console.log(chalk.gray(message)),

    async confirm(question, defaultValue = false) {
      const suffix = defaultValue ? ' [Y/n]: ' : ' [y/N]: ';
      const answer = (await readLine(question + suffix, false)).trim().toLowerCase();
      if (!answer) return defaultValue;
      return answer === 'y' || answer === 'yes';
    },

    async prompt(question, options: SetupPromptOptions = {}) {
      if (options.choices && options.choices.length > 0) {
        console.log(question);
        options.choices.forEach((choice, index) => {
          const suffix = choice.description ? ` — ${choice.description}` : '';
          console.log(`  ${index + 1}. ${choice.label}${suffix}`);
        });
        const hint = options.default ? ` (default ${options.default})` : '';
        const answer = (await readLine(`Choice [1-${options.choices.length}]${hint}: `, false)).trim();
        if (!answer) return options.default ?? options.choices[0].value;
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= options.choices.length) {
          return options.choices[index - 1].value;
        }
        const byValue = options.choices.find((choice) => choice.value === answer);
        return byValue ? byValue.value : answer;
      }

      const raw = await readLine(question, Boolean(options.secret));
      return withDefault(raw, options.default);
    },
  };

  const close = () => {
    if (rl) {
      rl.close();
      return;
    }
    process.stdin.removeListener('data', onData);
    process.stdin.removeListener('end', onEnd);
    process.stdin.pause();
  };

  return { io, close };
}

async function handleSetup(options: { envFile?: string }): Promise<void> {
  const { io, close } = createCliSetupIO();
  try {
    let createD1Probe: ((cfg: SetupD1Config) => DBConnectionProbe) | undefined;
    try {
      const { CloudflareD1Database } = await import('@mcp-ecc/storage-d1');
      createD1Probe = (cfg) => new CloudflareD1Database(cfg.accountId, cfg.databaseId, cfg.apiToken) as unknown as DBConnectionProbe;
    } catch {
      io.warn('Cloudflare D1 support is not available in this installation.');
    }

    const result = await runSetup(io, {
      envPath: options.envFile || resolveEnvPath(),
      // The CLI always writes the file. In a container, point MCP_ENV_FILE at a
      // mounted volume so the file survives a recreate.
      writeEnv: true,
      returnEnvContent: false,
      createStorage: (cfg) => createCliStorage(cfg),
      createD1Probe,
    });

    if (!result) process.exitCode = 1;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    close();
  }
}

async function handleLogin(): Promise<void> {
  await initStorage();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const userCount = await storage.countUsers();
    if (userCount === 0) {
      console.log(chalk.bold.cyan('=== Create First Admin Account ==='));
      const username = await askQuestion(rl, 'Username: ');
      if (!username.trim()) throw new Error('Username required');
      const displayName = await askQuestion(rl, 'Display name: ');
      const password = await askPassword(rl, 'Password: ');
      const confirm = await askPassword(rl, 'Confirm Password: ');
      if (password !== confirm) {
        throw new Error('Passwords do not match');
      }
      const user = await auth().createUser({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password,
        role: 'admin',
      });
      saveSession(user.id);
      console.log(chalk.green(`\n✔ Admin account successfully created and logged in: ${user.displayName} (@${user.username})\n`));
    } else {
      console.log(chalk.bold.cyan('=== Login ==='));
      const username = await askQuestion(rl, 'Username: ');
      if (!username.trim()) throw new Error('Username required');
      const password = await askPassword(rl, 'Password: ');
      const user = await auth().authenticate(username.trim(), password);
      saveSession(user.id);
      console.log(chalk.green(`\n✔ Successfully logged in as ${user.displayName} (@${user.username})\n`));
    }
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleAddUser(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  if (currentUser.role !== 'admin') {
    console.error(chalk.red('\nError: Only admin users can create new user accounts.\n'));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Create User Account ==='));
    const username = await askQuestion(rl, 'Username: ');
    if (!username.trim()) throw new Error('Username required');
    const displayName = await askQuestion(rl, 'Display name: ');
    const password = await askPassword(rl, 'Password: ');
    const confirm = await askPassword(rl, 'Confirm Password: ');
    if (password !== confirm) {
      throw new Error('Passwords do not match');
    }
    console.log('\nSelect Role:');
    console.log('1. Admin');
    console.log('2. Standard User');
    const roleChoice = await askQuestion(rl, 'Choose option [2]: ') || '2';
    const role: 'admin' | 'user' = roleChoice === '1' ? 'admin' : 'user';

    const user = await auth().createUser({
      username: username.trim(),
      displayName: displayName.trim() || undefined,
      password,
      role,
    });
    console.log(chalk.green(`\n✔ User account successfully created: ${user.displayName} (@${user.username}) [${user.role}]\n`));
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleStatus(): Promise<void> {
  const user = await getLoggedInUser();
  if (user) {
    console.log(chalk.green('\nStatus: Logged In'));
    console.log(`Username:     ${user.username}`);
    console.log(`Display Name: ${user.displayName}`);
    console.log(`Role:         ${user.role}\n`);
  } else {
    console.log(chalk.yellow('\nStatus: Not logged in. Run: mcp-ecc login\n'));
  }
}

async function handlePasswordChange(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Change Password ==='));
    const currentPassword = await askPassword(rl, 'Current password: ');
    const newPassword = await askPassword(rl, 'New password: ');
    const confirm = await askPassword(rl, 'Confirm new password: ');
    if (newPassword !== confirm) {
      throw new Error('New passwords do not match');
    }
    await auth().changePassword(currentUser.id, currentPassword, newPassword);
    console.log(chalk.green('\n✔ Password updated successfully.\n'));
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleListAccounts(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const accounts = await storage.listAccounts(currentUser.id);
  console.log(chalk.bold.cyan('\n=== Configure Accounts ==='));
  if (accounts.length === 0) {
    console.log('No accounts configured yet. Run: mcp-ecc add account');
  } else {
    accounts.forEach((acc: any, i: number) => {
      console.log(`  ${i + 1}. [${acc.provider}] ${chalk.bold(acc.name)} (${acc.email}) - Status: ${acc.status}`);
    });
  }
  console.log('');
}

function startLocalServerAndGetCode(port: number, expectedState?: string, accountInfo?: { name: string; email: string }): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlObj = new URL(req.url || '', `http://127.0.0.1:${port}`);
        const code = urlObj.searchParams.get('code');
        const state = urlObj.searchParams.get('state');
        const error = urlObj.searchParams.get('error');
        const errorDescription = urlObj.searchParams.get('error_description');

        // Handle provider-side error / user denial
        if (error) {
          server.close();
          reject(new Error(`Authorization failed: ${error}${errorDescription ? ' - ' + errorDescription : ''}`));
          return;
        }

        // Validate the state to prevent CSRF
        if (expectedState && state !== expectedState) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('State mismatch. Please re-run the authorization flow.');
          return;
        }

        if (code) {
          const accountHtml = accountInfo
            ? '<p style="font-size: 15px; color: #334155; margin-bottom: 8px;"><strong>Account:</strong> ' +
              escapeHtml(accountInfo.name) + ' (' + escapeHtml(accountInfo.email) + ')</p>\n'
            : '';
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html>\n' +
              '<body style="font-family: sans-serif; text-align: center; padding-top: 100px; background-color: #f8fafc; color: #1e293b;">\n' +
                '<div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">\n' +
                  '<h1 style="color: #10b981; margin-bottom: 10px;">Authorization Successful</h1>\n' +
                  accountHtml +
                  '<p style="font-size: 16px; margin-bottom: 20px;">mcp-ecc has securely captured your authentication tokens.</p>\n' +
                  '<p style="color: #64748b;">You can close this browser window and return to your terminal.</p>\n' +
                '</div>\n' +
              '</body>\n' +
            '</html>'
          );
          server.close();
          resolve({ code, state: state || '' });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code or state parameters');
        }
      } catch (err: any) {
        res.writeHead(500);
        res.end('Internal Error: ' + err.message);
      }
    });
    
    server.listen(port, '127.0.0.1', () => {
      // successfully listening
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function findAvailablePort(startPort: number): Promise<number> {
  const blockedPorts = [5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697];
  let port = startPort;
  while (blockedPorts.includes(port)) {
    port++;
  }
  const { createServer } = await import('http');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(port));
    });
    probe.on('error', () => resolve(findAvailablePort(port + 1)));
  });
}

async function handleAddAccount(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Add Account ==='));
    const name = await askQuestion(rl, 'Account name (e.g. Work Gmail): ');
    if (!name.trim()) throw new Error('Account name is required');
    const slug = await askQuestion(rl, 'Account slug (e.g. work-gmail): ');
    const email = await askQuestion(rl, 'Email: ');
    if (!email.trim()) throw new Error('Email is required');

    console.log('\nSelect Provider:');
    console.log('1. Google (Gmail, Calendar, Contacts)');
    console.log('2. Microsoft (Outlook, Calendars, Contacts)');
    console.log('3. Zoho Mail, Calendar, Contacts');
    console.log('4. IMAP / SMTP (Traditional)');
    console.log('5. CalDAV (Calendar only)');
    console.log('6. CardDAV (Contacts only)');
    const providerChoice = await askQuestion(rl, 'Choose option (1-6): ');

    const providers: Record<string, { provider: string; needsOAuth: boolean }> = {
      '1': { provider: 'google', needsOAuth: true },
      '2': { provider: 'microsoft', needsOAuth: true },
      '3': { provider: 'zoho', needsOAuth: true },
      '4': { provider: 'imap', needsOAuth: false },
      '5': { provider: 'caldav', needsOAuth: false },
      '6': { provider: 'carddav', needsOAuth: false },
    };

    const sel = providers[providerChoice];
    if (!sel) throw new Error('Invalid provider option selected');

    if (sel.needsOAuth) {
      // Load existing OAuth clients
      const clients = await storage.listOAuthClients(currentUser.id);
      const filtered = clients.filter((c: any) => c.provider === sel.provider);
      let selectedClientId = '';

      if (filtered.length > 0) {
        console.log('\nSelect OAuth Client:');
        filtered.forEach((c: any, idx: number) => {
          console.log(`  ${idx + 1}. ${c.label} (${c.clientId})`);
        });
        console.log(`  ${filtered.length + 1}. Create a new client`);
        const clientChoiceIdx = parseInt(await askQuestion(rl, `Choose option (1-${filtered.length + 1}): `) || '', 10);
        if (clientChoiceIdx > 0 && clientChoiceIdx <= filtered.length) {
          selectedClientId = filtered[clientChoiceIdx - 1].id;
        }
      }

      let client: any = null;
      if (!selectedClientId) {
        console.log('\nCreate New OAuth Client:');
        const label = await askQuestion(rl, 'Client label: ');
        const clientId = await askQuestion(rl, 'Client ID: ');
        const clientSecret = await askQuestion(rl, 'Client Secret: ');
        if (!clientId.trim()) throw new Error('Client ID is required');

        let tenantId = 'common';
        let accountsServer = 'accounts.zoho.com';
        let clientType: 'public' | 'confidential' = 'confidential';

        // Client type determines whether a client secret is sent on token refresh.
        // Desktop / Installed / Non-browser apps are PUBLIC clients (no secret on
        // refresh). Web apps / server-side are CONFIDENTIAL (secret required).
        console.log('\nClient Type:');
        console.log('1. Desktop / Installed / Non-browser app (public client)');
        console.log('2. Web app / server-side (confidential client)');
        const clientTypeChoice = await askQuestion(rl, 'Choose option [2]: ') || '2';
        if (clientTypeChoice === '1') {
          clientType = 'public';
        }

        if (sel.provider === 'microsoft') {
          const isOrg = await askQuestion(rl, 'Is this an M365 Organization/Office account? (y/N): ');
          if (isOrg.trim().toLowerCase() === 'y') {
            const customTenant = await askQuestion(rl, 'Enter Microsoft Tenant ID/Directory ID [organizations]: ');
            tenantId = customTenant.trim() || 'organizations';
          }
        } else if (sel.provider === 'zoho') {
          const region = await askQuestion(rl, 'Zoho region (us/eu/in/cn/jp/au) [us]: ');
          const regions: Record<string, string> = {
            'us': 'accounts.zoho.com',
            'eu': 'accounts.zoho.eu',
            'in': 'accounts.zoho.in',
            'cn': 'accounts.zoho.com.cn',
            'jp': 'accounts.zoho.jp',
            'au': 'accounts.zoho.com.au',
          };
          accountsServer = regions[region.trim().toLowerCase()] || 'accounts.zoho.com';
        }

        const savedClient: OAuthClient = {
          id: email, // use email or unique uuid
          ownerId: currentUser.id,
          provider: sel.provider as any,
          label: label.trim() || `${name} client`,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          scopes: [],
          tenantId: sel.provider === 'microsoft' ? tenantId : undefined,
          accountsServer: sel.provider === 'zoho' ? accountsServer : undefined,
          clientType,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await storage.saveOAuthClient(savedClient);
        client = savedClient;
      } else {
        const chosenClient = filtered.find((c: any) => c.id === selectedClientId);
        if (chosenClient) {
          const preferredPlatform = sel.provider === 'zoho' ? 'limited_input' : 'desktop';
          const sibling = filtered.find((c: any) =>
            c.label === chosenClient.label &&
            c.clientPlatform === preferredPlatform &&
            c.enabled
          );
          client = sibling || chosenClient;
        }
      }

      if (!client) throw new Error('Failed to resolve OAuth client');

      const result = await runOAuthFlow(client, sel.provider as string, name.trim(), email.trim());

      await storage.saveAccount({
        id: email,
        ownerId: currentUser.id,
        provider: sel.provider as any,
        name: name.trim(),
        slug: slug.trim() || email.replace(/[^a-z0-9_-]+/gi, '-'),
        email: email.trim(),
        credentials: {
          oauthClientId: client.id,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiryDate: result.expiresAt,
          tenantId: client.tenantId,
          isPublicClient: client.clientType === 'public',
          config: {
            accountsServer: client.accountsServer,
          },
        },
        status: 'active',
        health: 'unknown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      console.log(chalk.green(`\n✔ Account '${name}' successfully configured and authenticated.\n`));
    } else {
      // App password flow for imap/caldav/carddav
      const appPassword = await askPassword(rl, 'Enter App Password: ');
      let config: Record<string, any> = {};

      if (sel.provider === 'imap') {
        config.imapHost = await askQuestion(rl, 'IMAP Host (default: imap.gmail.com): ') || 'imap.gmail.com';
        config.imapPort = parseInt(await askQuestion(rl, 'IMAP Port (default: 993): ') || '993', 10);
        config.imapTls = true;
        config.smtpHost = await askQuestion(rl, 'SMTP Host (default: smtp.gmail.com): ') || 'smtp.gmail.com';
        config.smtpPort = parseInt(await askQuestion(rl, 'SMTP Port (default: 465): ') || '465', 10);
        config.smtpSecure = true;
      } else if (sel.provider === 'caldav') {
        config.caldavUrl = await askQuestion(rl, 'CalDAV URL: ');
        if (!config.caldavUrl) throw new Error('CalDAV URL is required');
      } else if (sel.provider === 'carddav') {
        config.carddavUrl = await askQuestion(rl, 'CardDAV URL: ');
        if (!config.carddavUrl) throw new Error('CardDAV URL is required');
      }

      await storage.saveAccount({
        id: email,
        ownerId: currentUser.id,
        provider: sel.provider as any,
        name: name.trim(),
        slug: slug.trim() || email.replace(/[^a-z0-9_-]+/gi, '-'),
        email: email.trim(),
        credentials: {
          appPassword,
          config,
        },
        status: 'active',
        health: 'unknown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      console.log(chalk.green(`\n✔ Account '${name}' configured successfully.\n`));
    }
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleRemoveAccount(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const accounts = await storage.listAccounts(currentUser.id);
  if (accounts.length === 0) {
    console.log(chalk.yellow('\nNo accounts configured yet.\n'));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Remove Account ==='));
    accounts.forEach((acc: any, i: number) => {
      console.log(`  ${i + 1}. [${acc.provider}] ${acc.name} (${acc.email})`);
    });
    const choiceIdx = parseInt(await askQuestion(rl, `\nSelect account to remove (1-${accounts.length}): `) || '', 10);
    if (choiceIdx > 0 && choiceIdx <= accounts.length) {
      const selected = accounts[choiceIdx - 1];
      await storage.deleteAccount(selected.id);
      console.log(chalk.green(`\n✔ Account '${selected.name}' has been successfully deleted.\n`));
    } else {
      console.log(chalk.red('\nInvalid selection.\n'));
    }
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleLogout(): Promise<void> {
  clearSession();
  console.log(chalk.green('\n✔ Successfully logged out.\n'));
}

// Run the correct OAuth flow for a provider and return tokens.
// Google uses the redirect/authorization-code loopback flow (full Gmail access).
// Microsoft and Zoho use the device flow (Zoho: Non-browser application client).
async function runOAuthFlow(client: OAuthClient, provider: string, accountName: string, accountEmail: string): Promise<any> {
  if (provider === 'google') {
    const port = await findAvailablePort(5000);
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const state = randomUUID();

    console.log('\nGoogle requires Web authorization flow for full Gmail access.');
    console.log('Register this redirect URI in your Google Cloud Console (Desktop app):');
    console.log(chalk.cyan(`  ${redirectUri}`));
    console.log(`\nStarting local callback server on port ${port}...`);

    const scopes = client.scopes && client.scopes.length > 0
      ? client.scopes
      : ['https://www.googleapis.com/auth/gmail.modify',
         'https://www.googleapis.com/auth/calendar',
         'https://www.googleapis.com/auth/contacts',
         'https://www.googleapis.com/auth/userinfo.email',
         'https://www.googleapis.com/auth/userinfo.profile'];

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', client.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    console.log('\n==================================================');
    console.log('Open this URL in your browser and grant access:');
    console.log('');
    console.log(chalk.cyan(authUrl.toString()));
    console.log('==================================================\n');
    console.log('Waiting for authorization...');

    const callback = await startLocalServerAndGetCode(port, state, { name: accountName, email: accountEmail });
    const code = callback.code;

    console.log('\nExchanging authorization code for tokens...');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData: any = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error} - ${tokenData.error_description || ''}`);
    }

    console.log(chalk.green('\n✔ Successfully obtained tokens with full Gmail access!'));
    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      scope: tokenData.scope,
    };
  }

  // Microsoft and Zoho device flow (Zoho: Non-browser application client)
  console.log(`\nInitiating Device Authorization Flow for ${provider}...`);
  const flowRes = await oauth().startFlow(provider as any, 'device_code', OAuthManager.clientToConfig(client, ''));

  console.log('\n==================================================');
  console.log(`1. Go to: ${chalk.cyan(flowRes.verificationUri)}`);
  console.log(`2. Enter the code: ${chalk.bold.yellow(flowRes.userCode)}`);
  console.log('==================================================\n');
  console.log('Waiting for user authorization in the browser...');

  return oauth().pollDeviceCode(flowRes.deviceCode, flowRes.interval, OAuthManager.clientToConfig(client, ''));
}

async function handleEditAccount(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const accounts = await storage.listAccounts(currentUser.id);
  if (accounts.length === 0) {
    console.log(chalk.yellow('\nNo accounts configured yet.\n'));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Edit Account ==='));
    accounts.forEach((acc: any, i: number) => {
      console.log(`  ${i + 1}. [${acc.provider}] ${acc.name} (${acc.email})`);
    });
    const choiceIdx = parseInt(await askQuestion(rl, `\nSelect account to edit (1-${accounts.length}): `) || '', 10);
    if (choiceIdx <= 0 || choiceIdx > accounts.length) {
      console.log(chalk.red('\nInvalid selection.\n'));
      return;
    }
    const selected = accounts[choiceIdx - 1];

    const updates: any = {};
    const newName = await askQuestion(rl, `Name [${selected.name}]: `);
    if (newName.trim()) updates.name = newName.trim();
    const newSlug = await askQuestion(rl, `Slug [${selected.slug}]: `);
    if (newSlug.trim()) updates.slug = newSlug.trim();
    const newEmail = await askQuestion(rl, `Email [${selected.email}]: `);
    if (newEmail.trim()) updates.email = newEmail.trim();

    // Password-based providers (IMAP/SMTP/CalDAV/CardDAV) store an app password
    // as their credential — allow updating it here.
    const passwordProviders = ['imap', 'smtp', 'caldav', 'carddav'];
    let newAppPassword: string | undefined;
    if (passwordProviders.includes(selected.provider)) {
      const answer = await askQuestion(rl, '\nUpdate App Password? (y/N): ');
      if (answer.trim().toLowerCase() === 'y') {
        newAppPassword = await askPassword(rl, 'New App Password: ');
        const confirm = await askPassword(rl, 'Confirm App Password: ');
        if (newAppPassword !== confirm) {
          throw new Error('App passwords do not match');
        }
      }
    }

    console.log('\nSelect Status:');
    console.log('1. active');
    console.log('2. error');
    console.log('3. disabled');
    const statusChoice = await askQuestion(rl, `Current [${selected.status}], choose (1-3) or leave blank: `);
    if (statusChoice.trim()) {
      const statusMap: Record<string, string> = { '1': 'active', '2': 'error', '3': 'disabled' };
      if (statusChoice === '1' || statusChoice === '2' || statusChoice === '3') {
        updates.status = statusMap[statusChoice];
      } else {
        console.log(chalk.red('Invalid status choice.'));
      }
    }

    if (Object.keys(updates).length > 0) {
      await storage.updateAccount(selected.id, updates);
      console.log(chalk.green('\n✔ Account details updated successfully.'));
    }
    if (newAppPassword) {
      await storage.updateCredentials(selected.id, { appPassword: newAppPassword });
      console.log(chalk.green('✔ App password updated successfully.'));
    }
    if (Object.keys(updates).length === 0 && !newAppPassword) {
      console.log(chalk.yellow('\nNo changes made.'));
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleReauthenticate(slug?: string): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const accounts = await storage.listAccounts(currentUser.id);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let target: any;
    if (slug) {
      target = accounts.find((a: any) => a.slug === slug);
      if (!target) {
        console.error(chalk.red(`Error: Account with slug '${slug}' not found.`));
        return;
      }
    } else {
      if (accounts.length === 0) {
        console.log(chalk.yellow('\nNo accounts configured yet.\n'));
        return;
      }
      console.log(chalk.bold.cyan('\n=== Reauthenticate Account ==='));
      accounts.forEach((acc: any, i: number) => {
        console.log(`  ${i + 1}. [${acc.provider}] ${acc.name} (${acc.email}) - Status: ${acc.status}`);
      });
      const choiceIdx = parseInt(await askQuestion(rl, `\nSelect account to reauthenticate (1-${accounts.length}): `) || '', 10);
      if (choiceIdx <= 0 || choiceIdx > accounts.length) {
        console.log(chalk.red('\nInvalid selection.\n'));
        return;
      }
      target = accounts[choiceIdx - 1];
    }

    const oauthProviders = ['google', 'microsoft', 'zoho'];
    if (!oauthProviders.includes(target.provider)) {
      console.error(chalk.red(`Error: Reauthentication is only supported for OAuth providers (${oauthProviders.join(', ')}).`));
      return;
    }

    // Resolve the stored OAuth client for this account
    const clientId = target.credentials?.oauthClientId;
    let client: any = null;
    if (clientId) {
      const originalClient = await storage.getOAuthClient(clientId);
      if (originalClient) {
        const preferredPlatform = target.provider === 'zoho' ? 'limited_input' : 'desktop';
        const clients = await storage.listOAuthClients(currentUser.id);
        const sibling = clients.find((c: any) =>
          c.provider === target.provider &&
          c.label === originalClient.label &&
          c.clientPlatform === preferredPlatform &&
          c.enabled
        );
        client = sibling || originalClient;
      }
    }

    if (!client) {
      console.error(chalk.red('Error: No saved OAuth client found for this account. Re-run: mcp-ecc add account'));
      return;
    }

    console.log(`\nReauthenticating ${target.name} (${target.email})...`);
    const result = await runOAuthFlow(client, target.provider, target.name, target.email);

    await storage.updateCredentials(target.id, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiryDate: result.expiresAt,
      tenantId: client.tenantId,
      isPublicClient: client.clientType === 'public',
    });
    await storage.updateAccount(target.id, { status: 'active', health: 'unknown' });
    console.log(chalk.green(`\n✔ Account '${target.name}' successfully reauthenticated.\n`));
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleAddOAuthClient(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Add OAuth Client ==='));
    
    console.log('\nSelect Provider:');
    console.log('1. Google');
    console.log('2. Microsoft');
    console.log('3. Zoho');
    const providerChoice = await askQuestion(rl, 'Choose option (1-3): ');
    
    const providers: Record<string, ProviderName> = {
      '1': 'google',
      '2': 'microsoft',
      '3': 'zoho',
    };
    const provider = providers[providerChoice];
    if (!provider) throw new Error('Invalid provider selected');

    const label = await askQuestion(rl, 'Client Label (e.g. My Org Client): ');
    if (!label.trim()) throw new Error('Label is required');

    const clientId = await askQuestion(rl, 'Client ID: ');
    if (!clientId.trim()) throw new Error('Client ID is required');

    const clientSecret = await askQuestion(rl, 'Client Secret: ');

    let clientPlatform: 'desktop' | 'web' | 'limited_input' = 'desktop';
    console.log('\nSelect Client Platform:');
    if (provider === 'google') {
      console.log('1. Desktop / Installed App (desktop)');
      console.log('2. Web Application (web)');
      console.log('   Note: Google does NOT support Device Flow / Limited Input for mail & calendar.');
      console.log('   Create a Desktop client for CLI auth, and a Web client for web UI auth.');
      const platformChoice = await askQuestion(rl, 'Choose option (1-2) [1]: ') || '1';
      const platforms: Record<string, 'desktop' | 'web'> = { '1': 'desktop', '2': 'web' };
      clientPlatform = platforms[platformChoice] || 'desktop';
    } else if (provider === 'microsoft') {
      // A single Azure app registration works for all platforms.
      clientPlatform = 'limited_input';
    } else if (provider === 'zoho') {
      console.log('1. Desktop / Installed App (desktop)');
      console.log('2. Web Application (web)');
      console.log('3. Device Flow / Limited Input (limited_input)');
      console.log('   Note: Zoho can be created as a Self-Client (limited_input) or Web client.');
      const platformChoice = await askQuestion(rl, 'Choose option (1-3) [1]: ') || '1';
      const platforms: Record<string, 'desktop' | 'web' | 'limited_input'> = { '1': 'desktop', '2': 'web', '3': 'limited_input' };
      clientPlatform = platforms[platformChoice] || 'desktop';
    }

    // Map platform to standard oauth client type
    const clientType = clientPlatform === 'desktop' || clientPlatform === 'limited_input' ? 'public' : 'confidential';

    let tenantId = 'common';
    let accountsServer = 'accounts.zoho.com';

    if (provider === 'microsoft') {
      const isOrg = await askQuestion(rl, 'Is this an M365 Organization/Office account? (y/N): ');
      if (isOrg.trim().toLowerCase() === 'y') {
        const customTenant = await askQuestion(rl, 'Enter Microsoft Tenant ID/Directory ID [organizations]: ');
        tenantId = customTenant.trim() || 'organizations';
      }
    } else if (provider === 'zoho') {
      const region = await askQuestion(rl, 'Zoho region (us/eu/in/cn/jp/au) [us]: ');
      const regions: Record<string, string> = {
        'us': 'accounts.zoho.com',
        'eu': 'accounts.zoho.eu',
        'in': 'accounts.zoho.in',
        'cn': 'accounts.zoho.com.cn',
        'jp': 'accounts.zoho.jp',
        'au': 'accounts.zoho.com.au',
      };
      accountsServer = regions[region.trim().toLowerCase()] || 'accounts.zoho.com';
    }

    let scopes: string[] = [];
    if (provider === 'google') {
      scopes = [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/contacts',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ];
    } else if (provider === 'microsoft') {
      scopes = ['offline_access', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite', 'https://graph.microsoft.com/Contacts.ReadWrite'];
    } else if (provider === 'zoho') {
      scopes = ['ZohoMail.folders.READ', 'ZohoMail.messages.ALL', 'ZohoCalendar.calendar.ALL', 'zohocontacts.contactapi.ALL', 'zohocontacts.contactapi.READ'];
    }

    const client: OAuthClient = {
      id: randomUUID(),
      ownerId: currentUser.id,
      provider,
      label: label.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes,
      tenantId,
      accountsServer,
      clientType,
      clientPlatform,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storage.saveOAuthClient(client);
    console.log(chalk.green(`\n✔ OAuth Client '${client.label}' (${clientPlatform}) added successfully.\n`));
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleListOAuthClients(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  try {
    const clients = await storage.listOAuthClients(currentUser.id);
    console.log(chalk.bold.cyan('\n=== Stored OAuth Clients ==='));
    if (clients.length === 0) {
      console.log(chalk.yellow('No OAuth Clients added yet.\n'));
      return;
    }
    clients.forEach((c: any, i: number) => {
      console.log(`  ${i + 1}. [${c.provider}] ${chalk.bold(c.label)}`);
      console.log(`     Client ID: ${c.clientId}`);
      console.log(`     Platform:  ${c.clientPlatform || 'desktop'} (${c.clientType || 'public'})`);
      if (c.tenantId) console.log(`     Tenant ID: ${c.tenantId}`);
      if (c.provider === 'zoho' && c.accountsServer) console.log(`     Server:    ${c.accountsServer}`);
      console.log(`     Enabled:   ${c.enabled ? chalk.green('yes') : chalk.red('no')}`);
      console.log('');
    });
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  }
}

async function handleEditOAuthClient(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const clients = await storage.listOAuthClients(currentUser.id);
  if (clients.length === 0) {
    console.log(chalk.yellow('\nNo OAuth Clients added yet.\n'));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Edit OAuth Client ==='));
    clients.forEach((c: any, i: number) => {
      console.log(`  ${i + 1}. [${c.provider}] ${c.label} (${c.clientId})`);
    });
    const choiceIdx = parseInt(await askQuestion(rl, `\nSelect OAuth client to edit (1-${clients.length}): `) || '', 10);
    if (choiceIdx <= 0 || choiceIdx > clients.length) {
      console.log(chalk.red('\nInvalid selection.\n'));
      return;
    }
    const selected = clients[choiceIdx - 1];

    const updates: any = {};
    const newLabel = await askQuestion(rl, `Label [${selected.label}]: `);
    if (newLabel.trim()) updates.label = newLabel.trim();
    
    const newClientId = await askQuestion(rl, `Client ID [${selected.clientId}]: `);
    if (newClientId.trim()) updates.clientId = newClientId.trim();

    const newClientSecret = await askQuestion(rl, `Client Secret [${selected.clientSecret ? '********' : 'none'}]: `);
    if (newClientSecret.trim()) updates.clientSecret = newClientSecret.trim();

    console.log('\nSelect Client Platform:');
    console.log(`1. Desktop / Installed App (desktop)`);
    console.log(`2. Web Application (web)`);
    console.log(`3. Device Flow / Limited Input (limited_input)`);
    const platformChoice = await askQuestion(rl, `Current [${selected.clientPlatform || 'desktop'}], choose (1-3) or leave blank: `);
    if (platformChoice.trim()) {
      const platforms: Record<string, 'desktop' | 'web' | 'limited_input'> = { '1': 'desktop', '2': 'web', '3': 'limited_input' };
      if (platforms[platformChoice]) {
        updates.clientPlatform = platforms[platformChoice];
        updates.clientType = updates.clientPlatform === 'web' ? 'confidential' : 'public';
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = Date.now();
      const merged = { ...selected, ...updates };
      await storage.saveOAuthClient(merged);
      console.log(chalk.green('\n✔ OAuth Client details updated successfully.\n'));
    } else {
      console.log(chalk.yellow('\nNo changes made.\n'));
    }
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

async function handleRemoveOAuthClient(): Promise<void> {
  const currentUser = await ensureAuthenticated();
  const clients = await storage.listOAuthClients(currentUser.id);
  if (clients.length === 0) {
    console.log(chalk.yellow('\nNo OAuth Clients added yet.\n'));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.bold.cyan('\n=== Remove OAuth Client ==='));
    clients.forEach((c: any, i: number) => {
      console.log(`  ${i + 1}. [${c.provider}] ${c.label} (${c.clientId})`);
    });
    const choiceIdx = parseInt(await askQuestion(rl, `\nSelect OAuth client to remove (1-${clients.length}): `) || '', 10);
    if (choiceIdx > 0 && choiceIdx <= clients.length) {
      const selected = clients[choiceIdx - 1];
      await storage.deleteOAuthClient(selected.id);
      console.log(chalk.green(`\n✔ OAuth Client '${selected.label}' has been successfully deleted.\n`));
    } else {
      console.log(chalk.red('\nInvalid selection.\n'));
    }
  } catch (err: any) {
    console.error(chalk.red(`\nError: ${err.message}\n`));
  } finally {
    rl.close();
  }
}

const ASCII_LINES = [
  `   __  __    ____    ____           _____    ____    ____`,
  `   |  \\/  |  / ___|  |  _ \\         | ____|  / ___|  / ___|`,
  `   | |\\/| | | |      | |_) |  ---   | |__   | |     | |    `,
  `   | |  | | | |      |  __/   ---   |  __|  | |     | |    `,
  `   | |  | | | |___   | |            | |___  | |___  | |___`,
  `   |_|  |_|  \\____|  |_|            |_____|  \\____|  \\____|`,
];

const SUBTITLE = 'Email · Calendar · Contacts — one MCP server for all your accounts';

function centerText(text: string): string {
  const width = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function printBanner(): void {
  // Align every row to the same width first, so the letter columns line up,
  // then center the whole block as one unit.
  const blockWidth = Math.max(...ASCII_LINES.map(l => l.length));
  console.log('');
  for (const line of ASCII_LINES) {
    console.log(centerText(chalk.cyan(line.padEnd(blockWidth))));
  }
  console.log('');
  console.log(centerText(chalk.gray(SUBTITLE)));
  console.log('');
}

const TUI_COMMANDS = [
  ['setup', 'Configure the database and write .env'],
  ['login', 'Log in to a user account'],
  ['status', 'Show current login session status'],
  ['password', 'Update password for currently logged-in user'],
  ['list accounts', 'List configured accounts'],
  ['add account', 'Add a new provider account'],
  ['add user', 'Add a new user account (Admin only)'],
  ['edit account', 'Edit a configured account'],
  ['reauthenticate [slug]', 'Re-authenticate an OAuth account'],
  ['remove account', 'Remove a configured account'],
  ['start', 'Start the MCP server (stdio)'],
  ['help', 'Show this help'],
  ['exit', 'Leave the TUI'],
];

function showTuiHelp(): void {
  console.log(chalk.bold.cyan('\nAvailable commands:'));
  for (const [cmd, desc] of TUI_COMMANDS) {
    console.log(`  ${chalk.green(cmd.padEnd(22))} ${chalk.gray(desc)}`);
  }
  console.log('');
}

async function runTui(): Promise<void> {
  printBanner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    // The user types commands WITHOUT the mcp-ecc prefix while inside the TUI.
    rl.setPrompt(chalk.cyan('mcp-ecc › '));
    rl.prompt();
  };

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) { prompt(); return; }

    const argv = line.split(/\s+/);
    const cmd = argv[0].toLowerCase();

    if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
      console.log(chalk.gray('\nGoodbye.'));
      rl.close();
      return;
    }
    if (cmd === 'help' || cmd === '?') {
      showTuiHelp();
      prompt();
      return;
    }

    // Re-dispatch the command in a subprocess with inherited stdio so its interactive prompts
    // (like askQuestion/askPassword) work perfectly on the user's terminal.
    rl.pause();
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [process.argv[1], ...argv], {
        stdio: 'inherit',
      });
      child.on('close', () => {
        resolve();
      });
      child.on('error', (err) => {
        console.error(chalk.red(`Failed to execute command: ${err.message}`));
        resolve();
      });
    });
    rl.resume();
    prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });

  showTuiHelp();
  prompt();
}

program
  .name('mcp-ecc')
  .description('MCP Email, Calendar, and Contacts Server')
  .version(PACKAGE_VERSION);

program
  .command('setup')
  .description('First-run setup: choose the database, verify it, and write .env')
  .option('--env-file <path>', 'Where to write the configuration (default: MCP_ENV_FILE or ./.env)')
  .action(handleSetup);

program
  .command('login')
  .description('Log into user account or bootstrap first admin account')
  .action(handleLogin);

program
  .command('logout')
  .description('Log out of current user account')
  .action(handleLogout);

program
  .command('status')
  .description('Show current login session status')
  .action(handleStatus);

program
  .command('password')
  .description('Update password for currently logged-in user')
  .action(handlePasswordChange);

// Subcommand Groups for clear structured commands
const addCmd = program.command('add').description('Add resources');
addCmd.command('account').description('Add a new provider account (Gmail, Office365, IMAP)').action(handleAddAccount);
addCmd.command('user').description('Add a new user account (Admin only)').action(handleAddUser);
addCmd.command('oauth-client').description('Add a new OAuth client credentials config').action(handleAddOAuthClient);

const removeCmd = program.command('remove').description('Remove resources');
removeCmd.command('account').description('Remove a configured account').action(handleRemoveAccount);
removeCmd.command('oauth-client').description('Remove a configured OAuth client').action(handleRemoveOAuthClient);

const editCmd = program.command('edit').description('Edit resources');
editCmd.command('account').description('Edit a configured account (name, slug, email, status)').action(handleEditAccount);
editCmd.command('oauth-client').description('Edit a configured OAuth client config').action(handleEditOAuthClient);

const reauthCmd = program.command('reauthenticate').description('Re-authenticate an OAuth account after failure/expiry');
reauthCmd.argument('[slug]', 'Account slug to reauthenticate (selects interactively if omitted)').action((slug?: string) => handleReauthenticate(slug));

const listCmd = program.command('list').description('List resources');
listCmd.command('accounts').description('List configured accounts').action(handleListAccounts);
listCmd.command('oauth-clients').description('List configured OAuth clients').action(handleListOAuthClients);

program
  .command('start')
  .description('Start the MCP server stdio service')
  .action(async () => {
    const user = await getLoggedInUser();
    if (!user) {
      console.error(chalk.red('Error: You must log in first to start the MCP server. Run: mcp-ecc login'));
      process.exit(1);
    }
    console.error(`Starting MCP Server scoped to ${user.displayName} (@${user.username})...`);
    const mcpServer = new McpEccServer(storage, user.id);
    const server = mcpServer.getServer();
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP Server connected and running.');
  });

// No arguments -> open the interactive TUI.
const hasArgs = process.argv.slice(2).length > 0;
if (!hasArgs) {
  runTui();
} else {
  program.parseAsync(process.argv).catch(handleFatal);
}
