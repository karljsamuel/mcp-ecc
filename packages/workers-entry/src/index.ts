import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { ProviderName, OAuthClient, User } from '@mcp-ecc/core';
import { AuthService, OAuthManager, generateSlug } from '@mcp-ecc/core';
import { D1Storage } from '@mcp-ecc/storage-d1';
import { McpEccServer } from '@mcp-ecc/mcp-server';

interface Env {
  DB: any;
  ASSETS?: any;
  MCP_ENCRYPTION_KEY: string;
  SESSION_SECRET?: string;
  [key: string]: any;
}

const SESSION_COOKIE = 'mcp_ecc_session';
const AUTH_PROVIDERS: ProviderName[] = ['google', 'microsoft', 'zoho'];

function publicUser(u: User, includeApiKey = false) {
  const base: any = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
  if (includeApiKey && u.mcpApiKey) base.mcpApiKey = u.mcpApiKey;
  return base;
}

function publicClient(c: OAuthClient) {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    clientId: c.clientId,
    scopes: c.scopes,
    tenantId: c.tenantId,
    accountsServer: c.accountsServer,
    enabled: c.enabled,
  };
}

// Edge-native signed session tokens (HMAC-SHA256)
async function createSessionToken(userId: string, secret: string): Promise<string> {
  const payload = `${userId}:${Date.now() + 7 * 24 * 3600 * 1000}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${payload}:${sigHex}`;
}

async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [userId, expStr, sigHex] = parts;
  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Date.now() > exp) return null;
  const payload = `${userId}:${expStr}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!sigHex || sigHex.length % 2 !== 0) return null;
  const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload));
  return valid ? userId : null;
}

function getRedirectUri(c: any): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}/oauth/callback`;
}

function getPublicUrl(c: any): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Lazy, cached schema initialisation per isolate.
let schemaInitPromise: Promise<void> | null = null;
function ensureSchema(storage: D1Storage): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = storage.initSchema().catch((e) => {
      schemaInitPromise = null;
      throw e;
    });
  }
  return schemaInitPromise;
}

function createServices(env: Env) {
  const storage = new D1Storage(env.DB, env.MCP_ENCRYPTION_KEY);
  const oauthManager = new OAuthManager(storage);
  const authService = new AuthService(storage);
  const mcpServer = new McpEccServer(storage);
  return { storage, oauthManager, authService, mcpServer };
}

app.use('*', cors({ origin: (origin) => origin || '*', credentials: true }));

// Ensure D1 schema exists before handling any /api or /oauth requests
app.use('/api/*', async (c, next) => {
  if (c.env?.DB) {
    await ensureSchema(new D1Storage(c.env.DB, c.env.MCP_ENCRYPTION_KEY));
  }
  await next();
});

app.use('/oauth/*', async (c, next) => {
  if (c.env?.DB) {
    await ensureSchema(new D1Storage(c.env.DB, c.env.MCP_ENCRYPTION_KEY));
  }
  await next();
});

// Authentication middleware for /api/*
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const isPublic = path.startsWith('/api/info')
    || path.startsWith('/api/bootstrap-status')
    || path.startsWith('/api/auth/login')
    || path.startsWith('/api/auth/bootstrap')
    || path.startsWith('/api/auth/logout')
    || path.startsWith('/api/bootstrap');
  if (isPublic) return next();

  const secret = c.env.SESSION_SECRET || c.env.MCP_ENCRYPTION_KEY || 'default-secret';
  const cookie = getCookie(c, SESSION_COOKIE);
  const authHeader = c.req.header('authorization');
  let token = cookie;
  if (!token && authHeader?.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const userId = await verifySessionToken(token, secret);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { storage } = createServices(c.env);
  const user = await storage.getUser(userId);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  c.set('user', user);
  await next();
});

// --- Health Check ---
app.get('/health', async (c) => {
  try {
    if (c.env?.DB) {
      const { storage } = createServices(c.env);
      await storage.initSchema();
      return c.json({ status: 'ok', timestamp: Date.now(), storage: 'd1', schema: 'initialized' });
    }
    return c.json({ status: 'ok', timestamp: Date.now(), storage: 'unbound' });
  } catch (e: any) {
    return c.json({ status: 'error', timestamp: Date.now(), error: e.message }, 500);
  }
});

// --- Public Info ---
app.get('/api/info', (c) => {
  const publicUrl = getPublicUrl(c);
  return c.json({
    publicUrl,
    oauthRedirectUri: `${publicUrl}/oauth/callback`,
    mcpEndpoint: `${publicUrl}/mcp`,
  });
});

app.get('/api/bootstrap-status', async (c) => {
  const { storage } = createServices(c.env);
  const count = await storage.countUsers();
  return c.json({ needsBootstrap: count === 0 });
});

// --- Auth Endpoints ---
app.post('/api/auth/bootstrap', async (c) => {
  const { storage, authService } = createServices(c.env);
  const count = await storage.countUsers();
  if (count > 0) {
    return c.json({ error: 'Admin already configured. Contact an existing admin for a user account.' }, 400);
  }
  const { username, password, displayName } = await c.req.json();
  if (!username || !password) return c.json({ error: 'username and password required' }, 400);

  const user = await authService.bootstrapAdmin({ username, displayName, password });
  const secret = c.env.SESSION_SECRET || c.env.MCP_ENCRYPTION_KEY || 'default-secret';
  const token = await createSessionToken(user.id, secret);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
  return c.json({ user: publicUser(user), bootstrap: true });
});

app.post('/api/auth/login', async (c) => {
  const { authService } = createServices(c.env);
  const { username, password } = await c.req.json();
  if (!username || !password) return c.json({ error: 'username and password required' }, 400);
  try {
    const user = await authService.authenticate(username, password);
    const secret = c.env.SESSION_SECRET || c.env.MCP_ENCRYPTION_KEY || 'default-secret';
    const token = await createSessionToken(user.id, secret);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
    return c.json({ user: publicUser(user) });
  } catch (e: any) {
    return c.json({ error: e.message }, 401);
  }
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

app.get('/api/auth/me', (c) => {
  const user = c.get('user');
  return c.json({ user: publicUser(user) });
});

// --- Accounts (User-Scoped) ---
app.get('/api/accounts', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const accounts = await storage.listAccounts(user.id);
  return c.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      name: a.name,
      slug: a.slug,
      email: a.email,
      displayName: a.displayName,
      status: a.status,
      health: a.health,
      lastSyncAt: a.lastSyncAt,
      authenticated: !!(a.credentials?.accessToken || a.credentials?.appPassword),
    })),
  });
});

app.get('/api/accounts/:id', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const account = await storage.getAccount(c.req.param('id'));
  if (!account || account.ownerId !== user.id) return c.json({ error: 'Account not found' }, 404);
  return c.json({
    account: {
      id: account.id,
      provider: account.provider,
      name: account.name,
      slug: account.slug,
      email: account.email,
      displayName: account.displayName,
      status: account.status,
      health: account.health,
      lastSyncAt: account.lastSyncAt,
      authenticated: !!(account.credentials?.accessToken || account.credentials?.appPassword),
      oauthClientId: account.credentials?.oauthClientId,
    },
  });
});

app.post('/api/accounts', async (c) => {
  const user = c.get('user');
  const { storage, oauthManager } = createServices(c.env);
  const body = await c.req.json();
  const { name, provider, slug, email, config, oauthClientId, client } = body;
  if (!name || !provider || !email) return c.json({ error: 'name, provider, email required' }, 400);

  const id = crypto.randomUUID();
  const credentials: any = { config };
  const ownerId = user.id;

  if (client && AUTH_PROVIDERS.includes(provider)) {
    if (!client.clientId) return c.json({ error: 'client.clientId required for a new OAuth client' }, 400);
    const saved: OAuthClient = {
      id: crypto.randomUUID(),
      ownerId,
      provider,
      label: client.label || `${name} client`,
      clientId: client.clientId,
      clientSecret: client.clientSecret || '',
      scopes: client.scopes || [],
      tenantId: client.tenantId,
      accountsServer: client.accountsServer,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await storage.saveOAuthClient(saved);
    credentials.oauthClientId = saved.id;
  } else if (oauthClientId) {
    credentials.oauthClientId = oauthClientId;
  }

  const account = {
    id,
    ownerId,
    provider,
    name,
    slug: slug || generateSlug(name, id),
    email,
    displayName: undefined,
    credentials,
    status: 'active' as const,
    health: 'unknown' as const,
    lastSyncAt: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await storage.saveAccount(account);

  if (AUTH_PROVIDERS.includes(provider)) {
    let oauthClient: OAuthClient | null = null;
    if (credentials.oauthClientId) {
      oauthClient = await storage.getOAuthClient(credentials.oauthClientId);
    }
    if (!oauthClient) {
      const clients = await storage.listOAuthClients(ownerId);
      oauthClient = clients.find((cl) => cl.provider === provider && cl.enabled) || null;
    }
    if (oauthClient) {
      const redirectUri = getRedirectUri(c);
      const flow = await oauthManager.startFlow(provider as ProviderName, 'device_code', OAuthManager.clientToConfig(oauthClient, redirectUri));
      await storage.updateCredentials(account.id, { oauthClientId: oauthClient.id });
      return c.json(
        {
          account: { id: account.id, slug: account.slug, name: account.name },
          authorizeUrl: flow.verificationUri,
          verificationUri: flow.verificationUri,
          userCode: flow.userCode,
          deviceCode: flow.deviceCode,
          message: `Account created. Go to ${flow.verificationUri} and enter code: ${flow.userCode}`,
        },
        201
      );
    }
  }

  return c.json({ account: { id: account.id, slug: account.slug, name: account.name } }, 201);
});

app.patch('/api/accounts/:id', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const account = await storage.getAccount(c.req.param('id'));
  if (!account || account.ownerId !== user.id) return c.json({ error: 'Account not found' }, 404);
  const body = await c.req.json();
  const allowed = ['name', 'slug', 'displayName', 'status', 'health', 'email'];
  const updates: any = {};
  for (const k of allowed) if (body[k] !== undefined) updates[k] = body[k];
  await storage.updateAccount(account.id, updates);
  return c.json({ success: true });
});

app.delete('/api/accounts/:id', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const account = await storage.getAccount(c.req.param('id'));
  if (!account || account.ownerId !== user.id) return c.json({ error: 'Account not found' }, 404);
  await storage.deleteAccount(account.id);
  return c.json({ success: true });
});

app.post('/api/accounts/:id/reauth', async (c) => {
  const user = c.get('user');
  const { storage, oauthManager } = createServices(c.env);
  const account = await storage.getAccount(c.req.param('id'));
  if (!account || account.ownerId !== user.id) return c.json({ error: 'Account not found' }, 404);
  if (!AUTH_PROVIDERS.includes(account.provider as ProviderName)) {
    return c.json({ error: 'Re-auth not supported for this provider' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  let client: OAuthClient | null = null;
  if (body?.oauthClientId) {
    client = await storage.getOAuthClient(body.oauthClientId);
    if (client && client.ownerId !== user.id) client = null;
  }
  if (!client) {
    const clients = await storage.listOAuthClients(user.id);
    client = clients.find((cl) => cl.provider === account.provider && cl.enabled) || null;
  }
  if (!client) {
    return c.json({ error: `No OAuth client available for ${account.provider}. Add one in OAuth Clients first.` }, 400);
  }

  const redirectUri = getRedirectUri(c);
  const flow = await oauthManager.startFlow(account.provider as ProviderName, 'device_code', OAuthManager.clientToConfig(client, redirectUri));
  await storage.updateCredentials(account.id, { oauthClientId: client.id });
  return c.json({
    authorizeUrl: flow.verificationUri,
    verificationUri: flow.verificationUri,
    userCode: flow.userCode,
    deviceCode: flow.deviceCode,
    interval: flow.interval,
    state: flow.state,
    message: `Go to ${flow.verificationUri} and enter code: ${flow.userCode}`,
  });
});

// --- OAuth Clients (User-Scoped) ---
app.get('/api/oauth-clients', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const clients = await storage.listOAuthClients(user.id);
  return c.json({ clients: clients.map(publicClient) });
});

app.post('/api/oauth-clients', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const body = await c.req.json();
  const { provider, label, clientId, clientSecret, scopes, tenantId, accountsServer } = body;
  if (!provider || !label || !clientId) return c.json({ error: 'provider, label, clientId required' }, 400);
  if (!AUTH_PROVIDERS.includes(provider)) return c.json({ error: `Unsupported provider: ${provider}` }, 400);

  const client: OAuthClient = {
    id: crypto.randomUUID(),
    ownerId: user.id,
    provider,
    label,
    clientId,
    clientSecret: clientSecret || '',
    scopes: scopes || [],
    tenantId,
    accountsServer,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await storage.saveOAuthClient(client);
  return c.json({ client: publicClient(client) }, 201);
});

app.delete('/api/oauth-clients/:id', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const client = await storage.getOAuthClient(c.req.param('id'));
  if (!client || client.ownerId !== user.id) return c.json({ error: 'Client not found' }, 404);
  await storage.deleteOAuthClient(client.id);
  return c.json({ success: true });
});

// --- OAuth Flow Callback ---
app.get('/oauth/callback', async (c) => {
  const { oauthManager } = createServices(c.env);
  const { code, state, error } = c.req.query();
  if (error) {
    return c.html(`<html><body><h1>OAuth Error</h1><p>${error}</p></body></html>`);
  }
  if (!code || !state) {
    return c.json({ error: 'Missing code or state' }, 400);
  }
  await oauthManager.completeFlow(String(state), String(code));
  return c.html(`
    <html>
      <body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
        <h1>Authorization Successful</h1>
        <p>Your account is now linked. You can close this window.</p>
        <script>window.close();</script>
      </body>
    </html>
  `);
});

// --- Settings & User Self-Management ---
app.get('/api/settings/me', async (c) => {
  const user = c.get('user');
  const { storage } = createServices(c.env);
  const fresh = await storage.getUser(user.id);
  if (!fresh) return c.json({ error: 'User not found' }, 404);
  return c.json({ settings: publicUser(fresh, true), mcpApiKey: fresh.mcpApiKey });
});

app.patch('/api/settings/me', async (c) => {
  const user = c.get('user');
  const { storage, authService } = createServices(c.env);
  const body = await c.req.json();
  const { displayName, currentPassword, newPassword } = body;
  if (newPassword) {
    if (!currentPassword) return c.json({ error: 'currentPassword required to change password' }, 400);
    try {
      await authService.changePassword(user.id, currentPassword, newPassword);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
  if (displayName !== undefined) {
    await storage.updateUser(user.id, { displayName });
  }
  const fresh = await storage.getUser(user.id);
  if (!fresh) return c.json({ error: 'User not found' }, 404);
  return c.json({ settings: publicUser(fresh, true), mcpApiKey: fresh.mcpApiKey });
});

app.post('/api/settings/me/rotate-apikey', async (c) => {
  const user = c.get('user');
  const { storage, authService } = createServices(c.env);
  const key = await authService.rotateApiKey(user.id);
  const fresh = await storage.getUser(user.id);
  return c.json({ settings: fresh ? publicUser(fresh, true) : undefined, mcpApiKey: key });
});

// Fallback: serve static React Admin UI assets from packages/admin-ui/dist
app.all('*', async (c) => {
  if (c.env?.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.notFound();
});

export default app;
