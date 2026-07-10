import readline from 'readline';
import dotenv from 'dotenv';
import { HeadlessAuthManager } from './auth.js';
import { TokenStorage } from './storage.js';
import { runServer } from './index.js';

dotenv.config();

function showHelp() {
  console.log(`
\x1b[1m\x1b[36mMCP Email, Calendar, and Contacts (mcp-ecc) CLI\x1b[0m

\x1b[1mUsage:\x1b[0m
  mcp-ecc [command] [options]

\x1b[1mCommands:\x1b[0m
  start                        Start the MCP server (stdio transport by default)
  auth | add-account           Interactively add and authenticate a new account
  edit-account <account-id>    Edit configuration details for an IMAP/SMTP account
  delete-account <account-id>  Delete an account's credentials and configuration
  reauth <account-id>          Re-authenticate an existing OAuth account (Google/Microsoft)
  list-accounts                List all registered accounts
  help                         Show this help menu

\x1b[1mOptions for start:\x1b[0m
  --sse                        Use Server-Sent Events (SSE) instead of stdio
  --port <number>              Specify port for SSE transport (default: 3000)
  
\x1b[1mExamples:\x1b[0m
  mcp-ecc auth
  mcp-ecc start --sse --port 3000
  mcp-ecc delete-account user@gmail.com
  `);
}

const askQuestion = (rl: readline.Interface, query: string): Promise<string> => {
  return new Promise(resolve => rl.question(query, resolve));
};

async function handleInteractiveAuth(accountId?: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n=== Register / Authenticate Account ===');
    let email = accountId || '';
    if (!email) {
      email = await askQuestion(rl, 'Enter Email Address / Account ID: ');
      if (!email.trim()) {
        console.log('\x1b[31mCancelled: Account identifier cannot be empty.\x1b[0m');
        rl.close();
        return;
      }
    }

    console.log('\nSelect Provider:');
    console.log('1. Google (Gmail, Calendar, Contacts)');
    console.log('2. Microsoft (Outlook, Calendars, Contacts)');
    console.log('3. Zoho Mail');
    console.log('4. Traditional IMAP / SMTP');
    
    const providerChoice = await askQuestion(rl, 'Choose option (1-4): ');
    
    if (providerChoice === '1') {
      const clientId = await askQuestion(rl, 'Enter Google Client ID: ');
      const clientSecret = await askQuestion(rl, 'Enter Google Client Secret (Optional): ');
      if (!clientId.trim()) {
        console.log('\x1b[31mCancelled: Client ID is required.\x1b[0m');
        rl.close();
        return;
      }
      rl.close();
      await triggerOAuthFlow('google', email, clientId.trim(), clientSecret.trim());
    } else if (providerChoice === '2') {
      const clientId = await askQuestion(rl, 'Enter Microsoft Client ID: ');
      const clientSecret = await askQuestion(rl, 'Enter Microsoft Client Secret (Optional): ');
      const isOrg = await askQuestion(rl, 'Is this an M365 Organization/Office account? (y/N): ');
      
      let tenantId = 'common';
      if (isOrg.trim().toLowerCase() === 'y' || isOrg.trim().toLowerCase() === 'yes') {
        const customTenant = await askQuestion(rl, 'Enter Microsoft Tenant ID/Directory ID [organizations]: ');
        tenantId = customTenant.trim() || 'organizations';
      }

      if (!clientId.trim()) {
        console.log('\x1b[31mCancelled: Client ID is required.\x1b[0m');
        rl.close();
        return;
      }
      rl.close();
      await triggerOAuthFlow('microsoft', email, clientId.trim(), clientSecret.trim(), tenantId);
    } else if (providerChoice === '3') {
      const clientId = await askQuestion(rl, 'Enter Zoho Client ID: ');
      const clientSecret = await askQuestion(rl, 'Enter Zoho Client Secret: ');
      const token = await askQuestion(rl, 'Enter Zoho Access Token (Out-of-band Ingestion): ');
      const refresh = await askQuestion(rl, 'Enter Zoho Refresh Token (Optional): ');
      
      if (!clientId.trim()) {
        console.log('\x1b[31mCancelled: Client ID is required.\x1b[0m');
        rl.close();
        return;
      }

      TokenStorage.saveAccount({
        accountId: email,
        provider: 'zoho',
        tokens: {
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          accessToken: token.trim(),
          refreshToken: refresh.trim(),
          expiryDate: Date.now() + 3600 * 1000
        }
      });
      console.log(`\x1b[32m✔ Account '${email}' successfully saved with Zoho credentials.\x1b[0m`);
      rl.close();
    } else if (providerChoice === '4') {
      const appPassword = await askQuestion(rl, 'Enter App Password: ');
      const imapHost = await askQuestion(rl, 'IMAP Host (default: imap.gmail.com): ');
      const imapPortStr = await askQuestion(rl, 'IMAP Port (default: 993): ');
      const smtpHost = await askQuestion(rl, 'SMTP Host (default: smtp.gmail.com): ');
      const smtpPortStr = await askQuestion(rl, 'SMTP Port (default: 465): ');

      const config = {
        imapHost: imapHost.trim() || 'imap.gmail.com',
        imapPort: imapPortStr.trim() ? parseInt(imapPortStr, 10) : 993,
        imapTls: true,
        smtpHost: smtpHost.trim() || 'smtp.gmail.com',
        smtpPort: smtpPortStr.trim() ? parseInt(smtpPortStr, 10) : 465,
        smtpSecure: true
      };

      TokenStorage.saveAccount({
        accountId: email,
        provider: 'imap_smtp',
        tokens: {
          appPassword,
          config
        }
      });
      console.log(`\x1b[32m✔ IMAP/SMTP account '${email}' successfully saved.\x1b[0m`);
      rl.close();
    } else {
      console.log('\x1b[31mInvalid option selected.\x1b[0m');
      rl.close();
    }
  } catch (err: any) {
    console.error(`\x1b[31mError during auth configuration: ${err.message}\x1b[0m`);
    rl.close();
  }
}

async function triggerOAuthFlow(
  provider: 'google' | 'microsoft',
  accountId: string,
  clientId: string,
  clientSecret?: string,
  tenantId = 'common'
) {
  try {
    console.log(`\nInitiating Device Authorization Flow for ${provider}...`);
    const flowRes = await HeadlessAuthManager.initiateDeviceFlow(provider, clientId, tenantId);

    console.log('\n==================================================');
    console.log(`1. Go to: \x1b[36m${flowRes.verification_uri}\x1b[0m`);
    console.log(`2. Enter the code: \x1b[1m\x1b[33m${flowRes.user_code}\x1b[0m`);
    console.log('==================================================\n');
    console.log('Waiting for user authorization in the browser...');

    const result = await HeadlessAuthManager.pollForTokens(
      provider,
      flowRes.device_code,
      flowRes.interval,
      clientId,
      clientSecret,
      tenantId
    );

    TokenStorage.saveAccount({
      accountId,
      provider,
      tokens: {
        clientId,
        clientSecret,
        tenantId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiryDate: result.expiresAt
      }
    });

    console.log(`\n\x1b[32m✔ Success: Account '${accountId}' successfully authenticated.\x1b[0m\n`);
  } catch (err: any) {
    console.error(`\x1b[31m✖ Error during authorization: ${err.message}\x1b[0m`);
  }
}

async function handleEditAccount(accountId: string) {
  const account = TokenStorage.getAccount(accountId);
  if (!account) {
    console.log(`\x1b[31mError: Account '${accountId}' not found in storage.\x1b[0m`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n--- Editing configuration for ${accountId} ---`);
    if (account.provider === 'imap_smtp') {
      const currentConfig = account.tokens.config || {};
      
      const newPassword = await askQuestion(rl, `Enter App Password (leave blank to keep current): `);
      const newImapHost = await askQuestion(rl, `IMAP Host [${currentConfig.imapHost || 'imap.gmail.com'}]: `);
      const newImapPort = await askQuestion(rl, `IMAP Port [${currentConfig.imapPort || 993}]: `);
      const newSmtpHost = await askQuestion(rl, `SMTP Host [${currentConfig.smtpHost || 'smtp.gmail.com'}]: `);
      const newSmtpPort = await askQuestion(rl, `SMTP Port [${currentConfig.smtpPort || 465}]: `);

      const appPassword = newPassword.trim() || account.tokens.appPassword;
      const config = {
        imapHost: newImapHost.trim() || currentConfig.imapHost || 'imap.gmail.com',
        imapPort: newImapPort.trim() ? parseInt(newImapPort, 10) : currentConfig.imapPort || 993,
        imapTls: true,
        smtpHost: newSmtpHost.trim() || currentConfig.smtpHost || 'smtp.gmail.com',
        smtpPort: newSmtpPort.trim() ? parseInt(newSmtpPort, 10) : currentConfig.smtpPort || 465,
        smtpSecure: true
      };

      TokenStorage.saveAccount({
        ...account,
        tokens: {
          ...account.tokens,
          appPassword,
          config
        }
      });
      console.log(`\x1b[32m✔ Account '${accountId}' successfully updated.\x1b[0m`);
    } else if (account.provider === 'google' || account.provider === 'microsoft' || account.provider === 'zoho') {
      const newClientId = await askQuestion(rl, `Enter Client ID [${account.tokens.clientId || ''}]: `);
      const newClientSecret = await askQuestion(rl, `Enter Client Secret [${account.tokens.clientSecret || ''}]: `);
      
      let newTenantId = account.tokens.tenantId || 'common';
      if (account.provider === 'microsoft') {
        const tenantInput = await askQuestion(rl, `Enter Microsoft Tenant ID [${account.tokens.tenantId || 'common'}]: `);
        newTenantId = tenantInput.trim() || account.tokens.tenantId || 'common';
      }

      TokenStorage.saveAccount({
        ...account,
        tokens: {
          ...account.tokens,
          clientId: newClientId.trim() || account.tokens.clientId,
          clientSecret: newClientSecret.trim() || account.tokens.clientSecret,
          tenantId: newTenantId
        }
      });
      console.log(`\x1b[32m✔ Account client details for '${accountId}' successfully updated.\x1b[0m`);
    }
  } catch (err: any) {
    console.error(`\x1b[31mError editing account: ${err.message}\x1b[0m`);
  } finally {
    rl.close();
  }
}

export async function program() {
  const args = process.argv.slice(2);
  const command = args[0] ? args[0].toLowerCase() : 'start';

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    case 'list-accounts':
      const accounts = TokenStorage.listAccounts();
      console.log('\n=== Registered Accounts ===');
      if (accounts.length === 0) {
        console.log('No accounts configured yet. Run: mcp-ecc auth');
      } else {
        accounts.forEach(acc => {
          let desc = `Provider: ${acc.provider}`;
          if (acc.tokens.tenantId && acc.tokens.tenantId !== 'common') {
            desc += `, Tenant: ${acc.tokens.tenantId}`;
          }
          console.log(`- \x1b[1m${acc.accountId}\x1b[0m [${desc}]`);
        });
      }
      console.log('');
      break;

    case 'auth':
    case 'add-account':
      const optionalEmail = args[1];
      await handleInteractiveAuth(optionalEmail);
      break;

    case 'edit-account':
      const editEmail = args[1];
      if (!editEmail) {
        console.error('\x1b[31mError: Missing account ID argument. Usage: mcp-ecc edit-account <account-id>\x1b[0m');
        process.exit(1);
      }
      await handleEditAccount(editEmail);
      break;

    case 'delete-account':
      const delEmail = args[1];
      if (!delEmail) {
        console.error('\x1b[31mError: Missing account ID argument. Usage: mcp-ecc delete-account <account-id>\x1b[0m');
        process.exit(1);
      }
      TokenStorage.deleteAccount(delEmail);
      console.log(`\x1b[32m✔ Account '${delEmail}' has been successfully deleted.\x1b[0m`);
      break;

    case 'reauth':
      const reauthEmail = args[1];
      if (!reauthEmail) {
        console.error('\x1b[31mError: Missing account ID argument. Usage: mcp-ecc reauth <account-id>\x1b[0m');
        process.exit(1);
      }
      const acc = TokenStorage.getAccount(reauthEmail);
      if (!acc) {
        console.error(`\x1b[31mError: Account '${reauthEmail}' does not exist. Use 'auth' to add it.\x1b[0m`);
        process.exit(1);
      }
      if (acc.provider !== 'google' && acc.provider !== 'microsoft') {
        console.error(`\x1b[31mError: Reauthentication is only applicable for OAuth providers (google, microsoft). For IMAP/SMTP, use 'edit-account'.\x1b[0m`);
        process.exit(1);
      }
      if (!acc.tokens.clientId) {
        console.error(`\x1b[31mError: Client ID is missing. Please edit the account first or re-run 'auth'.\x1b[0m`);
        process.exit(1);
      }
      await triggerOAuthFlow(acc.provider, reauthEmail, acc.tokens.clientId, acc.tokens.clientSecret, acc.tokens.tenantId);
      break;

    case 'start':
      const sseIndex = args.indexOf('--sse');
      const portIndex = args.indexOf('--port');
      let sse = sseIndex !== -1;
      let port = undefined;
      
      if (portIndex !== -1 && args[portIndex + 1]) {
        port = parseInt(args[portIndex + 1], 10);
      }

      await runServer({ sse, port });
      break;

    default:
      // If first argument is --sse or other server options directly
      if (command.startsWith('-')) {
        const sseOpt = args.includes('--sse');
        const pIdx = args.indexOf('--port');
        let pVal = undefined;
        if (pIdx !== -1 && args[pIdx + 1]) {
          pVal = parseInt(args[pIdx + 1], 10);
        }
        await runServer({ sse: sseOpt, port: pVal });
      } else {
        console.error(`\x1b[31mError: Unknown command or syntax '${command}'\x1b[0m`);
        showHelp();
        process.exit(1);
      }
  }
}
