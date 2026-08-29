import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { StorageAdapter, ProviderName, OAuthConfig } from '@mcp-ecc/core';
import { OAuthManager } from '@mcp-ecc/core';
import { McpEccServer } from '@mcp-ecc/mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ManagementApiConfig {
  storage: StorageAdapter;
  port: number;
  host: string;
  publicDir: string;
}

export class ManagementApi {
  private app: ReturnType<typeof Fastify>;
  private storage: StorageAdapter;
  private oauthManager: OAuthManager;
  private mcpServer: McpEccServer;
  private config: ManagementApiConfig;

  constructor(config: ManagementApiConfig) {
    this.config = config;
    this.storage = config.storage;
    this.oauthManager = new OAuthManager(config.storage);
    this.mcpServer = new McpEccServer(config.storage);
    this.app = Fastify({ logger: true });
    this.app.setErrorHandler((error: any, request: any, reply: any) => {
      this.app.log.error({ error, body: request.body }, 'unhandled error');
      if (!reply.sent) {
        reply.code(500).send({ error: String(error) });
      }
    });
    this.setupPlugins();
    this.setupRoutes();
    this.setupMcpEndpoint();
  }

  private async setupPlugins(): Promise<void> {
    await this.app.register(cors, { origin: true });
    await this.app.register(websocket);
    await this.app.register(staticFiles, {
      root: this.config.publicDir,
      prefix: '/',
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

    // Account management
    this.app.get('/api/accounts', async () => {
      const accounts = await this.storage.listAccounts();
      return { accounts: accounts.map(a => ({
        id: a.id,
        provider: a.provider,
        email: a.email,
        displayName: a.displayName,
        status: a.status,
        lastSyncAt: a.lastSyncAt,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })) };
    });

    this.app.get('/api/accounts/:id', async (request: any) => {
      const account = await this.storage.getAccount(request.params.id);
      if (!account) throw new Error('Account not found');
      return { account: {
        id: account.id,
        provider: account.provider,
        email: account.email,
        displayName: account.displayName,
        status: account.status,
        lastSyncAt: account.lastSyncAt,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      }};
    });

    this.app.post('/api/accounts', async (request: any) => {
      const { provider, email, config } = request.body;
      if (!provider || !email) throw new Error('Provider and email are required');

      // Generate OAuth config - in real implementation, client credentials would come from env/secrets
      const oauthConfig: OAuthConfig = {
        provider,
        clientId: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '',
        clientSecret: process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || '',
        redirectUri: `${process.env.BASE_URL || `http://localhost:${this.config.port}`}/oauth/callback`,
        scopes: this.getDefaultScopes(provider),
        tenantId: config?.tenantId,
        accountsServer: config?.accountsServer,
      };

      // Start OAuth flow
      const flow = await this.oauthManager.startFlow(provider, 'authorization_code', oauthConfig);
      
      // Store pending account with OAuth state
      // In real implementation, save pending account with state
      return { 
        authorizeUrl: flow.verificationUri,
        state: flow.state,
        message: `Visit ${flow.verificationUri} and enter code: ${flow.userCode || flow.state}` 
      };
    });

    this.app.delete('/api/accounts/:id', async (request: any) => {
      await this.storage.deleteAccount(request.params.id);
      return { success: true };
    });

    this.app.post('/api/accounts/:id/sync', async (request: any) => {
      const { types } = request.body;
      // Trigger sync - would integrate with sync service
      return { message: 'Sync triggered', types };
    });

    // OAuth routes
    this.app.get('/oauth/start', async (request: any) => {
      const { provider, flow = 'authorization_code' } = request.query;
      if (!provider) throw new Error('Provider is required');

      const oauthConfig: OAuthConfig = {
        provider: provider as ProviderName,
        clientId: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '',
        clientSecret: process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || '',
        redirectUri: `${process.env.BASE_URL || `http://localhost:${this.config.port}`}/oauth/callback`,
        scopes: this.getDefaultScopes(provider as ProviderName),
      };

      const flowResult = await this.oauthManager.startFlow(provider as ProviderName, flow as any, oauthConfig);
      return flowResult;
    });

    this.app.get('/oauth/callback', async (request: any) => {
      const { code, state, error } = request.query;
      
      if (error) {
        return this.app.reply.view('/oauth/error', { error });
      }

      if (!code || !state) {
        throw new Error('Missing code or state');
      }

      const tokens = await this.oauthManager.completeFlow(state, code);
      
      // In real implementation, associate tokens with pending account
      return { success: true, message: 'Account connected successfully' };
    });

    this.app.post('/oauth/device-poll', async (request: any) => {
      const { deviceCode, interval, provider, clientId, clientSecret, tenantId } = request.body;
      if (!deviceCode || !provider) throw new Error('Device code and provider required');

      const oauthConfig: OAuthConfig = {
        provider,
        clientId,
        clientSecret,
        redirectUri: '',
        scopes: this.getDefaultScopes(provider),
        tenantId,
      };

      const tokens = await this.oauthManager.pollDeviceCode(deviceCode, interval, oauthConfig);
      return { tokens };
    });

    // WebSocket for real-time updates
    this.app.register(async (fastify: any) => {
      fastify.get('/ws', { websocket: true }, (connection: any, request: any) => {
        connection.socket.on('message', (message: any) => {
          // Handle incoming messages
        });
      });
    });

    // Serve admin UI for all other routes (SPA fallback)
    this.app.setNotFoundHandler(async (request: any, reply: any) => {
      if (request.raw.url?.startsWith('/api/') || request.raw.url?.startsWith('/oauth/') || request.raw.url?.startsWith('/ws')) {
        reply.code(404);
        return { error: 'Not found' };
      }
      return reply.sendFile('index.html');
    });
  }

  private async setupMcpEndpoint(): Promise<void> {
    // Mount the MCP server over Streamable HTTP on the same port as the
    // management API, so a single container serves web UI + REST + MCP.
    // Each session gets its own McpEccServer + transport, because the MCP
    // Protocol can only connect to one transport at a time. Sessions are
    // keyed by the Mcp-Session-Id the client returns; the id is generated
    // during initialize, so we register it in the map after handling.
    const sessions = new Map<string, { api: McpEccServer; transport: StreamableHTTPServerTransport }>();

    const getOrCreateSession = async (request: any) => {
      const sessionId = request.headers['mcp-session-id'];
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!;
      }
      const api = new McpEccServer(this.storage);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await api.getServer().connect(transport);
      return { api, transport };
    };

    const handle = async (request: any, reply: any, session: { api: McpEccServer; transport: StreamableHTTPServerTransport }): Promise<void> => {
      try {
        await session.transport.handleRequest(request.raw, reply.raw, request.body);
        // Register the session once the transport has an id (i.e. after initialize).
        if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
          sessions.set(session.transport.sessionId, session);
        }
      } catch (error) {
        this.app.log.error({ error }, 'MCP request handler failed');
        if (!reply.raw.writableEnded) {
          reply.raw.statusCode = 500;
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: request.body?.id ?? null }));
        }
      }
    };

    // GET: open an SSE stream for server-initiated messages / event stream.
    this.app.get('/mcp', async (request: any, reply: any) => {
      const session = await getOrCreateSession(request);
      reply.hijack();
      await handle(request, reply, session);
    });

    // POST: JSON-RPC (initialize, tools/list, tools/call ...).
    this.app.post('/mcp', async (request: any, reply: any) => {
      const session = await getOrCreateSession(request);
      reply.hijack();
      await handle(request, reply, session);
    });

    // DELETE: close the transport/session.
    this.app.delete('/mcp', async (request: any, reply: any) => {
      const sessionId = request.headers['mcp-session-id'];
      const session = sessionId ? sessions.get(sessionId) : undefined;
      reply.hijack();
      try {
        if (session) {
          await session.transport.handleRequest(request.raw, reply.raw, request.body);
          await session.transport.close();
          sessions.delete(sessionId);
        } else {
          reply.raw.statusCode = 200;
          reply.raw.end();
        }
      } catch (error) {
        this.app.log.error({ error }, 'MCP DELETE handler failed');
        if (!reply.raw.writableEnded) {
          reply.raw.statusCode = 500;
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }));
        }
      }
    });
  }

  private getDefaultScopes(provider: ProviderName): string[] {
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

  async start(): Promise<void> {
    await this.app.listen({ port: this.config.port, host: this.config.host });
    console.log(`Management API listening on http://${this.config.host}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  getApp() {
    return this.app;
  }
}