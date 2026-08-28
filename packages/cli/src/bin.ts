#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import { MemoryStorage } from '@mcp-ecc/storage-memory';
import { McpEccServer } from '@mcp-ecc/mcp-server';
import { OAuthManager } from '@mcp-ecc/core';
import * as path from 'path';

const STORAGE_FILE = process.env.MCP_STORAGE_FILE || path.join(process.cwd(), 'data', 'mcp-ecc.db');
const ENCRYPTION_KEY = process.env.MCP_ENCRYPTION_KEY;

const storage = new MemoryStorage();
const oauthManager = new OAuthManager(storage);
const mcpServer = new McpEccServer(storage);

function showHelp(): void {
  console.log(`
${chalk.bold.cyan('MCP Email, Calendar, and Contacts (mcp-ecc) CLI')}

${chalk.bold('Usage:')}
  mcp-ecc [command] [options]

${chalk.bold('Commands:')}
  start                    Start the MCP server (stdio transport by default)
  auth | add-account       Interactively add and authenticate a new account
  edit-account <id>        Edit configuration details for an account
  delete-account <id>      Delete an account's credentials and configuration
  reauth <id>              Re-authenticate an existing OAuth account
  list-accounts            List all registered accounts
  help                     Show this help menu

${chalk.bold('Options for start:')}
  --sse                    Use Server-Sent Events (SSE) instead of stdio
  --port <number>          Specify port for SSE transport (default: 3000)

${chalk.bold('Examples:')}
  mcp-ecc auth
  mcp-ecc start --sse --port 3000
  mcp-ecc delete-account user@gmail.com
`);
}

const askQuestion = (rl: readline.Interface, query: string): Promise<string> => {
  return new Promise(resolve => rl.question(query, resolve));
};

async function handleInteractiveAuth(accountId?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  try {
    console.log('\n=== Register / Authenticate Account ===');
    let email = accountId || '';
    
    if (!email) {
      email = await askQuestion(rl, 'Enter Email Address / Account ID: ');
      if (!email.trim()) {
        console.log(chalk.red('Cancelled: Account identifier cannot be empty.'));
        rl.close();
        return;
      }
    }

    console.log('\nSelect Provider:');
    console.log('1. Google (Gmail, Calendar, Contacts)');
    console.log('2. Microsoft (Outlook, Calendars, Contacts)');
    console.log('3. Zoho Mail, Calendar, Contacts');
    console.log('4. IMAP / SMTP (Traditional)');
    console.log('5. CalDAV (Calendar only)');
    console.log('6. CardDAV (Contacts only)');
    
    const providerChoice = await askQuestion(rl, 'Choose option (1-6): ');
    
    const providers: Record<string, { name: string; provider: string; needsOAuth: boolean }> = {
      '1': { name: 'Google', provider: 'google', needsOAuth: true },
      '2': { name: 'Microsoft', provider: 'microsoft', needsOAuth: true },
      '3': { name: 'Zoho', provider: 'zoho', needsOAuth: true },
      '4': { name: 'IMAP/SMTP', provider: 'imap', needsOAuth: false },
      '5': { name: 'CalDAV', provider: 'caldav', needsOAuth: false },
      '6': { name: 'CardDAV', provider: 'carddav', needsOAuth: false },
    };

    const selected = providers[providerChoice];
    if (!selected) {
      console.log(chalk.red('Invalid option selected.'));
      rl.close();
      return;
    }

    if (selected.needsOAuth) {
      await handleOAuthFlow(rl, selected.provider, email);
    } else {
      await handleAppPasswordFlow(rl, selected.provider, email);
    }

    rl.close();
  } catch (err: any) {
    console.error(chalk.red(`Error during auth configuration: ${err.message}`));
    rl.close();
  }
}

async function handleOAuthFlow(rl: readline.Interface, provider: string, email: string): Promise<void> {
  const clientId = await askQuestion(rl, `${chalk.cyan(provider)} Client ID: `);
  const clientSecret = await askQuestion(rl, `${chalk.cyan(provider)} Client Secret (optional): `);
  
  if (!clientId.trim()) {
    console.log(chalk.red('Cancelled: Client ID is required.'));
    return;
  }

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

  rl.close();

  console.log(`\nInitiating Device Authorization Flow for ${provider}...`);
  
  const oauthConfig = {
    provider: provider as any,
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    redirectUri: '',
    scopes: [],
    tenantId,
    accountsServer,
  };

  const flowRes = await oauthManager.startFlow(provider as any, 'device_code', oauthConfig);
  
  console.log('\n==================================================');
  console.log(`1. Go to: ${chalk.cyan(flowRes.verificationUri)}`);
  console.log(`2. Enter the code: ${chalk.bold.yellow(flowRes.userCode)}`);
  console.log('==================================================\n');
  console.log('Waiting for user authorization in the browser...');

  const result = await oauthManager.pollDeviceCode(
    flowRes.deviceCode,
    flowRes.interval,
    oauthConfig
  );

  // Save account
  await storage.saveAccount({
    id: email,
    provider: provider as any,
    email,
    credentials: {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiryDate: result.expiresAt,
      tenantId: provider === 'microsoft' ? tenantId : undefined,
      config: {
        accountsServer: provider === 'zoho' ? accountsServer : undefined,
      },
    },
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  console.log(chalk.green(`\n✔ Success: Account '${email}' successfully authenticated.\n`));
}

async function handleAppPasswordFlow(rl: readline.Interface, provider: string, email: string): Promise<void> {
  const appPassword = await askQuestion(rl, 'Enter App Password: ');
  
  let config: Record<string, any> = {};
  
  if (provider === 'imap') {
    config.imapHost = await askQuestion(rl, 'IMAP Host (default: imap.gmail.com): ') || 'imap.gmail.com';
    config.imapPort = parseInt(await askQuestion(rl, 'IMAP Port (default: 993): ') || '993', 10);
    config.imapTls = true;
    config.smtpHost = await askQuestion(rl, 'SMTP Host (default: smtp.gmail.com): ') || 'smtp.gmail.com';
    config.smtpPort = parseInt(await askQuestion(rl, 'SMTP Port (default: 465): ') || '465', 10);
    config.smtpSecure = true;
  } else if (provider === 'caldav') {
    config.caldavUrl = await askQuestion(rl, 'CalDAV URL: ');
    if (!config.caldavUrl) {
      console.log(chalk.red('CalDAV URL is required.'));
      return;
    }
    config.accountName = await askQuestion(rl, 'Account name (optional): ');
  } else if (provider === 'carddav') {
    config.carddavUrl = await askQuestion(rl, 'CardDAV URL: ');
    if (!config.carddavUrl) {
      console.log(chalk.red('CardDAV URL is required.'));
      return;
    }
    config.accountName = await askQuestion(rl, 'Account name (optional): ');
  }

  await storage.saveAccount({
    id: email,
    provider: provider as any,
    email,
    credentials: {
      appPassword,
      config,
    },
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  console.log(chalk.green(`\n✔ ${provider.toUpperCase()} account '${email}' successfully saved.\n`));
  rl.close();
}

async function handleEditAccount(accountId: string): Promise<void> {
  const account = await storage.getAccount(accountId);
  if (!account) {
    console.log(chalk.red(`Error: Account '${accountId}' not found in storage.`));
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  try {
    console.log(chalk.cyan(`\n--- Editing configuration for ${accountId} ---`));
    
    if (['imap', 'smtp'].includes(account.provider)) {
      const currentConfig = account.credentials.config || {};
      const newPassword = await askQuestion(rl, `Enter App Password (leave blank to keep current): `);
      const newImapHost = await askQuestion(rl, `IMAP Host [${currentConfig.imapHost || 'imap.gmail.com'}]: `);
      const newImapPort = await askQuestion(rl, `IMAP Port [${currentConfig.imapPort || 993}]: `);
      const newSmtpHost = await askQuestion(rl, `SMTP Host [${currentConfig.smtpHost || 'smtp.gmail.com'}]: `);
      const newSmtpPort = await askQuestion(rl, `SMTP Port [${currentConfig.smtpPort || 465}]: `);

      await storage.updateCredentials(accountId, {
        appPassword: newPassword.trim() || account.credentials.appPassword,
        config: {
          imapHost: newImapHost.trim() || currentConfig.imapHost,
          imapPort: newImapPort.trim() ? parseInt(newImapPort, 10) : currentConfig.imapPort,
          imapTls: true,
          smtpHost: newSmtpHost.trim() || currentConfig.smtpHost,
          smtpPort: newSmtpPort.trim() ? parseInt(newSmtpPort, 10) : currentConfig.smtpPort,
          smtpSecure: true,
        },
      });

      console.log(chalk.green(`\n✔ Account configuration for '${accountId}' successfully updated.\n`));
    } else {
      // OAuth providers - update client credentials
      const newClientId = await askQuestion(rl, `Client ID [${account.credentials.clientId || ''}]: `);
      const newClientSecret = await askQuestion(rl, `Client Secret [${account.credentials.clientSecret || ''}]: `);
      
      let newTenantId = account.credentials.tenantId || 'common';
      let newAccountsServer = account.credentials.config?.accountsServer || 'accounts.zoho.com';

      if (account.provider === 'microsoft') {
        const newTenant = await askQuestion(rl, `Tenant ID [${newTenantId}]: `);
        newTenantId = newTenant.trim() || newTenantId;
      } else if (account.provider === 'zoho') {
        const newServer = await askQuestion(rl, `Accounts Server [${newAccountsServer}]: `);
        newAccountsServer = newServer.trim() || newAccountsServer;
      }

      await storage.updateCredentials(accountId, {
        clientId: newClientId.trim() || account.credentials.clientId,
        clientSecret: newClientSecret.trim() || account.credentials.clientSecret,
        tenantId: newTenantId,
        config: {
          ...account.credentials.config,
          accountsServer: newAccountsServer,
        },
      });

      console.log(chalk.green(`\n✔ Account client details for '${accountId}' successfully updated.\n`));
    }
  } catch (err: any) {
    console.error(chalk.red(`Error editing account: ${err.message}`));
  } finally {
    rl.close();
  }
}

program
  .name('mcp-ecc')
  .description('MCP Email, Calendar, and Contacts Server')
  .version('0.1.0');

program
  .command('start')
  .description('Start the MCP server')
  .option('--sse', 'Use Server-Sent Events (SSE) instead of stdio')
  .option('--port <number>', 'Port for SSE transport', '3000')
  .action(async (options) => {
    if (options.sse) {
      console.error(chalk.yellow('SSE transport not yet implemented in CLI. Use management-api package.'));
      process.exit(1);
    }
    
    console.error('Starting MCP Server via Stdio transport...');
    const server = mcpServer.getServer();
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP Server connected and running.');
  });

program
  .command('auth')
  .alias('add-account')
  .description('Interactively add and authenticate a new account')
  .argument('[accountId]', 'Email address / account ID')
  .action(handleInteractiveAuth);

program
  .command('edit-account <accountId>')
  .description('Edit configuration details for an account')
  .action(handleEditAccount);

program
  .command('delete-account <accountId>')
  .description('Delete an account')
  .action(async (accountId) => {
    await storage.deleteAccount(accountId);
    console.log(chalk.green(`\n✔ Account '${accountId}' has been successfully deleted.\n`));
  });

program
  .command('reauth <accountId>')
  .description('Re-authenticate an existing OAuth account')
  .action(async (accountId) => {
    const account = await storage.getAccount(accountId);
    if (!account) {
      console.error(chalk.red(`Error: Account '${accountId}' does not exist. Use 'auth' to add it.`));
      process.exit(1);
    }
    if (!['google', 'microsoft', 'zoho'].includes(account.provider)) {
      console.error(chalk.red(`Error: Reauthentication only applies to OAuth providers. For ${account.provider}, use 'edit-account'.`));
      process.exit(1);
    }
    if (!account.credentials.clientId) {
      console.error(chalk.red('Error: Client ID is missing. Please edit the account first or re-run auth.'));
      process.exit(1);
    }
    await handleInteractiveAuth(accountId);
  });

program
  .command('list-accounts')
  .description('List all registered accounts')
  .action(async () => {
    const accounts = await storage.listAccounts();
    console.log(chalk.bold('\n=== Registered Accounts ==='));
    if (accounts.length === 0) {
      console.log('No accounts configured yet. Run: mcp-ecc auth');
    } else {
      accounts.forEach((acc: any) => {
        let desc = `Provider: ${acc.provider}`;
        if (acc.credentials.tenantId && acc.credentials.tenantId !== 'common') {
          desc += `, Tenant: ${acc.credentials.tenantId}`;
        }
        console.log(`  - ${chalk.bold(acc.email)} [${desc}]`);
      });
    }
    console.log('');
  });

program
  .command('help')
  .description('Show help')
  .action(showHelp);

program.parseAsync(process.argv).catch(console.error);

// Handle unknown commands
if (!process.argv.slice(2).length) {
  showHelp();
}