#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as path from 'path';
import { SQLiteStorage } from '@mcp-ecc/storage-sqlite';
import { AuthService, OAuthManager, OAuthClient, ProviderName } from '@mcp-ecc/core';
import { McpEccServer } from '@mcp-ecc/mcp-server';

const STORAGE_FILE = process.env.MCP_STORAGE_FILE || path.join(process.cwd(), 'data', 'mcp-ecc.db');
const ENCRYPTION_KEY = process.env.MCP_ENCRYPTION_KEY || 'default-secret-key';

// Ensure parent directory exists for SQLite
const dbDir = path.dirname(STORAGE_FILE);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
  console.error(chalk.cyan(`[mcp-ecc] Created database directory at ${dbDir}`));
}

const storage = new SQLiteStorage(STORAGE_FILE, ENCRYPTION_KEY);
const authService = new AuthService(storage);
const oauthManager = new OAuthManager(storage);

const SESSION_FILE = path.join(dbDir, 'cli-session.json');

interface SessionData {
  userId: string;
}

function getSession(): SessionData | null {
  try {
    if (existsSync(SESSION_FILE)) {
      return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function saveSession(userId: string): void {
  writeFileSync(SESSION_FILE, JSON.stringify({ userId }), 'utf8');
}

function clearSession(): void {
  try {
    if (existsSync(SESSION_FILE)) {
      unlinkSync(SESSION_FILE);
    }
  } catch {}
}

async function getLoggedInUser(): Promise<any | null> {
  const sess = getSession();
  if (!sess) return null;
  const user = await storage.getUser(sess.userId);
  return user;
}

async function ensureAuthenticated() {
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
    const stdin = process.stdin as any;
    const stdout = process.stdout as any;
    stdout.write(query);
    stdin.resume();
    stdin.setRawMode(true);
    let password = '';
    const onData = (char: Buffer) => {
      const c = char.toString('utf8');
      if (c === '\n' || c === '\r' || c === '\r\n') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(password);
      } else if (c === '\u0003') { // Ctrl+C
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.exit(0);
      } else if (char[0] === 127 || char[0] === 8) { // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          stdout.write('\b \b');
        }
      } else {
        password += c;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
};

async function handleLogin(): Promise<void> {
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
      const user = await authService.createUser({
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
      const user = await authService.authenticate(username.trim(), password);
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

    const user = await authService.createUser({
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
    await authService.changePassword(currentUser.id, currentPassword, newPassword);
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
    accounts.forEach((acc, i) => {
      console.log(`  ${i + 1}. [${acc.provider}] ${chalk.bold(acc.name)} (${acc.email}) - Status: ${acc.status}`);
    });
  }
  console.log('');
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
      const filtered = clients.filter(c => c.provider === sel.provider);
      let selectedClientId = '';

      if (filtered.length > 0) {
        console.log('\nSelect OAuth Client:');
        filtered.forEach((c, idx) => {
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
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await storage.saveOAuthClient(savedClient);
        client = savedClient;
      } else {
        client = filtered.find(c => c.id === selectedClientId);
      }

      if (!client) throw new Error('Failed to resolve OAuth client');

      // Start Flow
      console.log(`\nInitiating Device Authorization Flow for ${sel.provider}...`);
      const flowRes = await oauthManager.startFlow(sel.provider as any, 'device_code', OAuthManager.clientToConfig(client, ''));

      console.log('\n==================================================');
      console.log(`1. Go to: ${chalk.cyan(flowRes.verificationUri)}`);
      console.log(`2. Enter the code: ${chalk.bold.yellow(flowRes.userCode)}`);
      console.log('==================================================\n');
      console.log('Waiting for user authorization in the browser...');

      const result = await oauthManager.pollDeviceCode(flowRes.deviceCode, flowRes.interval, OAuthManager.clientToConfig(client, ''));

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
    accounts.forEach((acc, i) => {
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

program
  .name('mcp-ecc')
  .description('MCP Email, Calendar, and Contacts Server')
  .version('0.3.1-beta.1');

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

const removeCmd = program.command('remove').description('Remove resources');
removeCmd.command('account').description('Remove a configured account').action(handleRemoveAccount);

const listCmd = program.command('list').description('List resources');
listCmd.command('accounts').description('List configured accounts').action(handleListAccounts);

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

program.parseAsync(process.argv).catch(console.error);
