import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { StorageAdapter, ProviderName } from '@mcp-ecc/core';
import { D1Storage } from '@mcp-ecc/storage-d1';
import { OAuthManager } from '@mcp-ecc/core';
import { McpEccServer } from '@mcp-ecc/mcp-server';

interface Env {
  DB: any;
  MCP_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  BASE_URL: string;
  [key: string]: any;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Initialize storage and services per request (Workers are stateless)
function createServices(env: Env) {
  const storage = new D1Storage(env.DB, env.MCP_ENCRYPTION_KEY);
  const oauthManager = new OAuthManager(storage);
  const mcpServer = new McpEccServer(storage);
  return { storage, oauthManager, mcpServer };
}

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// MCP SSE endpoint (for HTTP transport)
// Note: The MCP SDK's SSE transport requires Node's ServerResponse, which is not
// available on Cloudflare Workers. Use the stdio transport on a Node runtime, or
// proxy to a Node-based management-api deployment. This endpoint is a placeholder.
app.get('/sse', async (c) => {
  return c.text('MCP SSE transport is not available on Cloudflare Workers. Use stdio on a Node runtime.');
});

app.post('/messages', async (c) => {
  return c.json({ error: 'MCP messages endpoint is not available on Cloudflare Workers' }, 501);
});

// Account management API
app.get('/api/accounts', async (c) => {
  const { storage } = createServices(c.env);
  const accounts = await storage.listAccounts();
  return c.json({ 
    accounts: accounts.map(a => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      displayName: a.displayName,
      status: a.status,
      lastSyncAt: a.lastSyncAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }))
  });
});

app.get('/api/accounts/:id', async (c) => {
  const { storage } = createServices(c.env);
  const account = await storage.getAccount(c.req.param('id'));
  if (!account) return c.json({ error: 'Account not found' }, 404);
  return c.json({ account: {
    id: account.id,
    provider: account.provider,
    email: account.email,
    displayName: account.displayName,
    status: account.status,
    lastSyncAt: account.lastSyncAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }});
});

app.post('/api/accounts', async (c) => {
  const { storage, oauthManager } = createServices(c.env);
  const body = await c.req.json();
  const { provider, email, config } = body;
  
  if (!provider || !email) return c.json({ error: 'Provider and email are required' }, 400);

  const oauthConfig = {
    provider: provider as ProviderName,
    clientId: c.env[`${provider.toUpperCase()}_CLIENT_ID`],
    clientSecret: c.env[`${provider.toUpperCase()}_CLIENT_SECRET`],
    redirectUri: `${c.env.BASE_URL}/oauth/callback`,
    scopes: getDefaultScopes(provider),
    tenantId: config?.tenantId,
    accountsServer: config?.accountsServer,
  };

  const flow = await oauthManager.startFlow(provider as ProviderName, 'authorization_code', oauthConfig);
  
  return c.json({ 
    authorizeUrl: flow.verificationUri,
    state: flow.state,
    userCode: flow.userCode,
  });
});

app.delete('/api/accounts/:id', async (c) => {
  const { storage } = createServices(c.env);
  await storage.deleteAccount(c.req.param('id'));
  return c.json({ success: true });
});

// OAuth routes
app.get('/oauth/start', async (c) => {
  const { oauthManager } = createServices(c.env);
  const provider = c.req.query('provider');
  const flow = c.req.query('flow') || 'authorization_code';
  
  if (!provider) return c.json({ error: 'Provider is required' }, 400);

  const oauthConfig = {
    provider: provider as ProviderName,
    clientId: c.env[`${provider.toUpperCase()}_CLIENT_ID`],
    clientSecret: c.env[`${provider.toUpperCase()}_CLIENT_SECRET`],
    redirectUri: `${c.env.BASE_URL}/oauth/callback`,
    scopes: getDefaultScopes(provider as any),
    tenantId: c.req.query('tenantId'),
    accountsServer: c.req.query('accountsServer'),
  };

  const flowResult = await oauthManager.startFlow(provider as ProviderName, flow as any, oauthConfig);
  return c.json(flowResult);
});

app.get('/oauth/callback', async (c) => {
  const { oauthManager, storage } = createServices(c.env);
  const { code, state, error } = c.req.query();
  
  if (error) {
    return c.html(`<html><body><h1>OAuth Error</h1><p>${error}</p></body></html>`);
  }

  if (!code || !state) {
    return c.json({ error: 'Missing code or state' }, 400);
  }

  const tokens = await oauthManager.completeFlow(state, code);
  
  // In real implementation, associate tokens with pending account
  // For now, just return success
  return c.html(`
    <html>
      <body>
        <h1>Account Connected Successfully</h1>
        <p>You can close this window and return to the application.</p>
        <script>window.close();</script>
      </body>
    </html>
  `);
});

app.post('/oauth/device-poll', async (c) => {
  const { oauthManager } = createServices(c.env);
  const { deviceCode, interval, provider, clientId, clientSecret, tenantId } = await c.req.json();
  
  if (!deviceCode || !provider) return c.json({ error: 'Device code and provider required' }, 400);

  const oauthConfig = {
    provider: provider as ProviderName,
    clientId: clientId || c.env[`${provider.toUpperCase()}_CLIENT_ID`],
    clientSecret: clientSecret || c.env[`${provider.toUpperCase()}_CLIENT_SECRET`],
    redirectUri: '',
    scopes: getDefaultScopes(provider as any),
    tenantId,
  };

  const tokens = await oauthManager.pollDeviceCode(deviceCode, interval, oauthConfig);
  return c.json({ tokens });
});

// MCP tool proxy endpoints (for HTTP clients)
app.post('/api/mcp/tools/:name', async (c) => {
  const { mcpServer } = createServices(c.env);
  const server = mcpServer.getServer();
  const toolName = c.req.param('name');
  const args = await c.req.json();
  
  // This would need to call the internal tool handler
  // Simplified - return error for now
  return c.json({ error: 'Tool execution via HTTP not implemented' }, 501);
});

// Helper function
function getDefaultScopes(provider: string): string[] {
  switch (provider) {
    case 'google':
      return [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/contacts',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ];
    case 'microsoft':
      return [
        'offline_access',
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'https://graph.microsoft.com/Calendars.ReadWrite',
        'https://graph.microsoft.com/Contacts.ReadWrite',
        'https://graph.microsoft.com/User.Read',
      ];
    case 'zoho':
      return [
        'ZohoMail.messages.ALL',
        'ZohoCalendar.events.ALL',
        'ZohoContacts.contacts.ALL',
        'ZohoMail.accounts.READ',
      ];
    default:
      return [];
  }
}

export default app;