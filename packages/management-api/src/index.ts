import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import cookies from '@fastify/cookie';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import type { StorageAdapter, ProviderName, OAuthClient, User } from '@mcp-ecc/core';
import { OAuthManager, AuthService, generateSlug } from '@mcp-ecc/core';
import { McpEccServer } from '@mcp-ecc/mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ManagementApiConfig {
  storage: StorageAdapter;
  port: number;
  host: string;
  publicDir: string;
  publicUrl?: string;
  sessionSecret?: string;
}

const SESSION_COOKIE = 'mcp_ecc_session';
const AUTH_PROVIDERS: ProviderName[] = ['google', 'microsoft', 'zoho'];

// Strip secret fields before returning an entity to clients.
function publicUser(u: User, includeApiKey = false) {
  const base: any = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
  if (includeApiKey && u.mcpApiKey) base.mcpApiKey = u.mcpApiKey;
  return base;
}
function publicClient(c: OAuthClient) {
  return { id: c.id, provider: c.provider, label: c.label, clientId: c.clientId, scopes: c.scopes, tenantId: c.tenantId, accountsServer: c.accountsServer, enabled: c.enabled };
}

export class ManagementApi {
  private app: ReturnType<typeof Fastify>;
  private storage: StorageAdapter;
  private oauthManager: OAuthManager;
  private authService: AuthService;
  private config: ManagementApiConfig;
  private publicUrl: string;

  constructor(config: ManagementApiConfig) {
    this.config = config;
    this.storage = config.storage;
    this.oauthManager = new OAuthManager(config.storage);
    this.authService = new AuthService(config.storage);
    this.publicUrl = config.publicUrl || process.env.PUBLIC_URL || `http://localhost:${config.port}`;
    this.app = Fastify({ logger: true });
    this.app.setErrorHandler((error: any, request: any, reply: any) => {
      this.app.log.error({ error, body: request.body }, 'unhandled error');
      if (!reply.sent) {
        reply.code(error?.statusCode || 500).send({ error: error?.message || String(error) });
      }
    });
    this.setupPlugins();
    this.setupRoutes();
    this.setupMcpEndpoint();
  }

  private setupPlugins(): void {
    const origin = this.config.publicUrl ? [this.config.publicUrl] : true;
    this.app.register(cors, { origin, credentials: true });
    this.app.register(websocket);
    // Sign the session cookie with the configured secret, else derive from encryption key.
    const secret = this.config.sessionSecret || process.env.SESSION_SECRET || process.env.MCP_ENCRYPTION_KEY || 'insecure-default';
    this.app.register(cookies, { secret });
    // Serve the admin UI (SPA). Guard against a missing build dir.
    this.app.register(staticFiles, { root: this.config.publicDir, prefix: '/' });
  }

  private setupRoutes(): void {
    // --- Health (public) ---
    this.app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

    // --- Public info (no auth): expose redirect URI + MCP endpoint for the UI ---
    this.app.get('/api/info', async () => ({
      publicUrl: this.publicUrl,
      oauthRedirectUri: `${this.publicUrl}/oauth/callback`,
      mcpEndpoint: `${this.publicUrl}/mcp`,
    }));

    // --- Public bootstrap status (no auth): used to show the 'create admin' screen ---
    this.app.get('/api/bootstrap-status', async () => {
      const count = await this.storage.countUsers();
      return { needsBootstrap: count === 0 };
    });

    // --- Auth: bootstrap + login use the session map ---
    const sessions = new Map<string, string>(); // sessionToken -> userId

    const currentUser = async (req: any): Promise<User | null> => {
      const token = req.cookies?.[SESSION_COOKIE];
      if (!token) return null;
      const userId = sessions.get(token);
      if (!userId) return null;
      return this.storage.getUser(userId);
    };

    // First-run admin creation (only when no users exist — hard-gated)
    this.app.post('/api/auth/bootstrap', async (request: any, reply: any) => {
      const count = await this.storage.countUsers();
      if (count > 0) {
        return reply.code(400).send({ error: 'Admin already configured. Contact an existing admin for a user account.' });
      }
      const { username, password, displayName } = request.body;
      if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
      const user = await this.authService.bootstrapAdmin({ username, displayName, password });
      const token = randomUUID();
      sessions.set(token, user.id);
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
      return { user: publicUser(user), bootstrap: true };
    });

    this.app.post('/api/auth/login', async (request: any, reply: any) => {
      const { username, password } = request.body;
      if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
      try {
        const user = await this.authService.authenticate(username, password);
        const token = randomUUID();
        sessions.set(token, user.id);
        reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
        return { user: publicUser(user) };
      } catch (e: any) {
        return reply.code(401).send({ error: e.message });
      }
    });

    this.app.post('/api/auth/logout', async (request: any, reply: any) => {
      const token = request.cookies?.[SESSION_COOKIE];
      if (token) sessions.delete(token);
      reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax' });
      return { success: true };
    });

    this.app.get('/api/auth/me', async (request: any, reply: any) => {
      const user = await currentUser(request);
      if (!user) return reply.code(401).send({ error: 'Unauthorized' });
      return { user: publicUser(user) };
    });

    // --- Auth gate for everything else under /api ---
    this.app.addHook('preHandler', async (request: any, reply: any) => {
      const url = request.raw.url || '';
      const isPublic = url.startsWith('/health')
        || url === '/api/info'
        || url === '/api/bootstrap-status'
        || url === '/api/auth/login'
        || url === '/api/auth/bootstrap'
        || url === '/api/auth/logout'
        || !url.startsWith('/api/');
      if (isPublic) return;
      const user = await currentUser(request);
      if (!user) return reply.code(401).send({ error: 'Unauthorized' });
      request.user = user;
    });

    // --- Accounts (scoped to the logged-in user) ---
    this.app.get('/api/accounts', async (request: any) => {
      const accounts = await this.storage.listAccounts(request.user.id);
      return { accounts: accounts.map(a => ({
        id: a.id, provider: a.provider, name: a.name, slug: a.slug, email: a.email,
        displayName: a.displayName, status: a.status, health: a.health,
        lastSyncAt: a.lastSyncAt, authenticated: !!(a.credentials?.accessToken || a.credentials?.appPassword),
      })) };
    });

    this.app.get('/api/accounts/:id', async (request: any, reply: any) => {
      const account = await this.storage.getAccount(request.params.id);
      if (!account || account.ownerId !== request.user.id) return reply.code(404).send({ error: 'Account not found' });
      return { account: {
        id: account.id, provider: account.provider, name: account.name, slug: account.slug, email: account.email,
        displayName: account.displayName, status: account.status, health: account.health, lastSyncAt: account.lastSyncAt,
        authenticated: !!(account.credentials?.accessToken || account.credentials?.appPassword),
        oauthClientId: account.credentials?.oauthClientId,
      } };
    });

    this.app.post('/api/accounts', async (request: any, reply: any) => {
      const { name, provider, slug, email, config, oauthClientId, client } = request.body;
      if (!name || !provider || !email) return reply.code(400).send({ error: 'name, provider, email required' });
      const id = randomUUID();
      const credentials: any = { config };
      const ownerId = request.user.id;

      // If inline client credentials were provided for an OAuth provider,
      // save them as a reusable OAuth client and link it to this account.
      if (client && AUTH_PROVIDERS.includes(provider)) {
        if (!client.clientId) return reply.code(400).send({ error: 'client.clientId required for a new OAuth client' });
        const saved: OAuthClient = {
          id: randomUUID(), ownerId, provider, label: client.label || `${name} client`,
          clientId: client.clientId, clientSecret: client.clientSecret || '',
          scopes: client.scopes || [], tenantId: client.tenantId, accountsServer: client.accountsServer,
          enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
        };
        await this.storage.saveOAuthClient(saved);
        credentials.oauthClientId = saved.id;
      } else if (oauthClientId) {
        credentials.oauthClientId = oauthClientId;
      }

      const account = {
        id, ownerId, provider, name, slug: slug || generateSlug(name, id),
        email, displayName: undefined, credentials,
        status: 'active' as const, health: 'unknown' as const, lastSyncAt: undefined,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      await this.storage.saveAccount(account);

      // If OAuth provider, automatically initiate auth flow and return device code instructions
      if (AUTH_PROVIDERS.includes(provider)) {
        let oauthClient: OAuthClient | null = null;
        if (credentials.oauthClientId) {
          oauthClient = await this.storage.getOAuthClient(credentials.oauthClientId);
        }
        if (!oauthClient) {
          const clients = await this.storage.listOAuthClients(ownerId);
          oauthClient = clients.find((c) => c.provider === provider && c.enabled) || null;
        }
        if (oauthClient) {
          const redirectUri = `${this.publicUrl}/oauth/callback`;
          const flow = await this.oauthManager.startFlow(provider as ProviderName, 'device_code', OAuthManager.clientToConfig(oauthClient, redirectUri));
          await this.storage.updateCredentials(account.id, { oauthClientId: oauthClient.id });
          return reply.code(201).send({
            account: { id: account.id, slug: account.slug, name: account.name },
            authorizeUrl: flow.verificationUri,
            verificationUri: flow.verificationUri,
            userCode: flow.userCode,
            deviceCode: flow.deviceCode,
            message: `Account created. Go to ${flow.verificationUri} and enter code: ${flow.userCode}`,
          });
        }
      }

      return reply.code(201).send({ account: { id: account.id, slug: account.slug, name: account.name } });
    });

    this.app.patch('/api/accounts/:id', async (request: any, reply: any) => {
      const account = await this.storage.getAccount(request.params.id);
      if (!account || account.ownerId !== request.user.id) return reply.code(404).send({ error: 'Account not found' });
      const allowed = ['name', 'slug', 'displayName', 'status', 'health', 'email'];
      const updates: any = {};
      for (const k of allowed) if (request.body[k] !== undefined) updates[k] = request.body[k];
      await this.storage.updateAccount(account.id, updates);
      return { success: true };
    });

    this.app.delete('/api/accounts/:id', async (request: any, reply: any) => {
      const account = await this.storage.getAccount(request.params.id);
      if (!account || account.ownerId !== request.user.id) return reply.code(404).send({ error: 'Account not found' });
      await this.storage.deleteAccount(account.id);
      return { success: true };
    });

    this.app.post('/api/accounts/:id/reauth', async (request: any, reply: any) => {
      const account = await this.storage.getAccount(request.params.id);
      if (!account || account.ownerId !== request.user.id) return reply.code(404).send({ error: 'Account not found' });
      if (!AUTH_PROVIDERS.includes(account.provider as ProviderName)) {
        return reply.code(400).send({ error: 'Re-auth not supported for this provider' });
      }
      // Resolve the OAuth client: explicit, or first matching owned client.
      let client: OAuthClient | null = null;
      if (request.body?.oauthClientId) {
        client = await this.storage.getOAuthClient(request.body.oauthClientId);
        if (client && client.ownerId !== request.user.id) client = null;
      }
      if (!client) {
        const clients = await this.storage.listOAuthClients(request.user.id);
        client = clients.find((c) => c.provider === account.provider && c.enabled) || null;
      }
      if (!client) {
        return reply.code(400).send({ error: `No OAuth client available for ${account.provider}. Add one in OAuth Clients first.` });
      }
      const redirectUri = `${this.publicUrl}/oauth/callback`;
      const flow = await this.oauthManager.startFlow(account.provider as ProviderName, 'device_code', OAuthManager.clientToConfig(client, redirectUri));
      // Persist the chosen client on the account for later token refresh.
      await this.storage.updateCredentials(account.id, { oauthClientId: client.id });
      return { authorizeUrl: flow.verificationUri, verificationUri: flow.verificationUri, userCode: flow.userCode, deviceCode: flow.deviceCode, interval: flow.interval, state: flow.state, message: `Go to ${flow.verificationUri} and enter code: ${flow.userCode}` };
    });

    // OAuth callback completes a flow and stores tokens on the pending account.
    this.app.get('/oauth/callback', async (request: any) => {
      const { code, state } = request.query;
      if (!code || !state) return { error: 'Missing code or state' };
      const tokens = await this.oauthManager.completeFlow(String(state), String(code));
      return { success: true, message: 'OAuth complete. Return to the app to finish linking.' };
    });

    // --- OAuth clients (per-user) ---
    this.app.get('/api/oauth-clients', async (request: any) => {
      const clients = await this.storage.listOAuthClients(request.user.id);
      return { clients: clients.map(publicClient) };
    });

    this.app.post('/api/oauth-clients', async (request: any, reply: any) => {
      const { provider, label, clientId, clientSecret, scopes, tenantId, accountsServer } = request.body;
      if (!provider || !label || !clientId) return reply.code(400).send({ error: 'provider, label, clientId required' });
      if (!AUTH_PROVIDERS.includes(provider)) return reply.code(400).send({ error: `Unsupported provider: ${provider}` });
      const client: OAuthClient = {
        id: randomUUID(), ownerId: request.user.id, provider, label, clientId, clientSecret: clientSecret || '',
        scopes: scopes || [], tenantId, accountsServer, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      };
      await this.storage.saveOAuthClient(client);
      return reply.code(201).send({ client: publicClient(client) });
    });

    this.app.delete('/api/oauth-clients/:id', async (request: any, reply: any) => {
      const client = await this.storage.getOAuthClient(request.params.id);
      if (!client || client.ownerId !== request.user.id) return reply.code(404).send({ error: 'Client not found' });
      await this.storage.deleteOAuthClient(client.id);
      return { success: true };
    });

    // --- Users (admin only) ---
    this.app.get('/api/users', async (request: any, reply: any) => {
      if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
      const users = await this.storage.listUsers();
      return { users: users.map((u) => publicUser(u, false)) };
    });

    this.app.post('/api/users', async (request: any, reply: any) => {
      if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
      const { username, password, displayName, role } = request.body;
      if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
      try {
        const user = await this.authService.createUser({ username, displayName, password, role: role === 'admin' ? 'admin' : 'user' });
        return reply.code(201).send({ user: publicUser(user) });
      } catch (e: any) {
        return reply.code(400).send({ error: e.message });
      }
    });

    this.app.delete('/api/users/:id', async (request: any, reply: any) => {
      if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
      const target = await this.storage.getUser(request.params.id);
      if (!target) return reply.code(404).send({ error: 'User not found' });
      if (target.id === request.user.id) return reply.code(400).send({ error: 'Cannot delete yourself' });
      if (target.role === 'admin' && await this.countAdmins() <= 1) return reply.code(400).send({ error: 'Cannot delete the last admin' });
      await this.storage.deleteUser(target.id);
      return { success: true };
    });

    this.app.patch('/api/users/:id', async (request: any, reply: any) => {
      if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
      const { displayName, role } = request.body;
      const updates: any = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (role !== undefined) updates.role = role === 'admin' ? 'admin' : 'user';
      await this.storage.updateUser(request.params.id, updates);
      return { success: true };
    });

    this.app.post('/api/users/:id/reset-password', async (request: any, reply: any) => {
      if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
      const { password } = request.body;
      if (!password) return reply.code(400).send({ error: 'password required' });
      await this.authService.resetPassword(request.params.id, password);
      return { success: true };
    });

    // --- Settings (own user) ---
    this.app.get('/api/settings/me', async (request: any) => {
      const user = await this.storage.getUser(request.user.id);
      if (!user) return { error: 'User not found' };
      return { settings: publicUser(user, true), mcpApiKey: user.mcpApiKey };
    });

    this.app.patch('/api/settings/me', async (request: any, reply: any) => {
      const { displayName, currentPassword, newPassword } = request.body;
      if (newPassword) {
        if (!currentPassword) return reply.code(400).send({ error: 'currentPassword required to change password' });
        try {
          await this.authService.changePassword(request.user.id, currentPassword, newPassword);
        } catch (e: any) {
          return reply.code(400).send({ error: e.message });
        }
      }
      if (displayName !== undefined) {
        await this.storage.updateUser(request.user.id, { displayName });
      }
      const user = await this.storage.getUser(request.user.id);
      if (!user) return reply.code(404).send({ error: 'User not found' });
      return { settings: publicUser(user, true), mcpApiKey: user.mcpApiKey };
    });

    this.app.post('/api/settings/me/rotate-apikey', async (request: any) => {
      const key = await this.authService.rotateApiKey(request.user.id);
      const user = await this.storage.getUser(request.user.id);
      return { settings: user ? publicUser(user, true) : undefined, mcpApiKey: key };
    });

    // --- Public setup docs (for AI agents to self-configure) ---
    const APP_ROOT = join(__dirname, '..', '..', '..');
    const PUBLIC_DIR = this.config.publicDir;

    const resolveDoc = (filename: string): string | null => {
      const candidates = [
        join(APP_ROOT, filename),
        join(PUBLIC_DIR, '..', filename),
        join(PUBLIC_DIR, '..', '..', filename),
        join(process.cwd(), filename),
      ];
      for (const p of candidates) {
        try { return readFileSync(p, 'utf8'); } catch { /* continue */ }
      }
      return null;
    };

    this.app.get('/setup/skill.md', async (_request: any, reply: any) => {
      const text = resolveDoc('SKILL.md');
      if (!text) return reply.code(404).send('SKILL.md not found');
      return reply.type('text/markdown').send(text);
    });

    this.app.get('/setup/llms.txt', async (_request: any, reply: any) => {
      const text = resolveDoc('llms.txt');
      if (!text) return reply.code(404).send('llms.txt not found');
      return reply.type('text/plain').send(text);
    });

    // --- SPA fallback (public UI; 404 fix) ---
    this.app.setNotFoundHandler(async (request: any, reply: any) => {
      const url = request.raw.url || '';
      if (url.startsWith('/api/') || url.startsWith('/oauth/') || url.startsWith('/ws')) {
        reply.code(404);
        return { error: 'Not found' };
      }
      try {
        return reply.sendFile('index.html');
      } catch {
        reply.code(404);
        return { error: `Not found (no UI built at ${this.config.publicDir})` };
      }
    });
  }

  private async countAdmins(): Promise<number> {
    const users = await this.storage.listUsers();
    return users.filter((u) => u.role === 'admin').length;
  }

  private readIfExists(p: string): string {
    if (!existsSync(p)) throw new Error('file not found');
    return readFileSync(p, 'utf8');
  }

  private setupMcpEndpoint(): void {
    const sessions = new Map<string, { api: McpEccServer; transport: StreamableHTTPServerTransport }>();

    const authUser = async (request: any): Promise<User | null> => {
      const auth = request.headers['authorization'];
      if (!auth || !auth.startsWith('Bearer ')) return null;
      const key = auth.slice(7).trim();
      try {
        return await this.authService.validateApiKey(key);
      } catch {
        return null;
      }
    };

    const getOrCreateSession = async (request: any): Promise<{ api: McpEccServer; transport: StreamableHTTPServerTransport }> => {
      const sessionId = request.headers['mcp-session-id'];
      if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId)!;
      // New session: create a server scoped to the authenticated user.
      const user = await authUser(request);
      if (!user) throw new Error('Unauthorized: missing or invalid MCP API key');
      const api = new McpEccServer(this.storage, user.id);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      await api.getServer().connect(transport);
      return { api, transport };
    };

    const handle = async (request: any, reply: any, session: { api: McpEccServer; transport: StreamableHTTPServerTransport }) => {
      try {
        await session.transport.handleRequest(request.raw, reply.raw, request.body);
        if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
          sessions.set(session.transport.sessionId, session);
        }
      } catch (error: any) {
        this.app.log.error({ error }, 'MCP request handler failed');
        if (!reply.raw.writableEnded) {
          reply.raw.statusCode = error?.message?.startsWith('Unauthorized') ? 401 : 500;
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) } }));
        }
      }
    };

    this.app.all('/mcp', async (request: any, reply: any) => {
      try {
        const session = await getOrCreateSession(request);
        reply.hijack();
        await handle(request, reply, session);
      } catch (error: any) {
        reply.code(401).send({ error: error?.message || 'Unauthorized' });
      }
    });
  }

  async start(): Promise<void> {
    await this.app.listen({ port: this.config.port, host: this.config.host });
    console.log(`mcp-ecc management API listening on http://${this.config.host}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  getApp() {
    return this.app;
  }
}