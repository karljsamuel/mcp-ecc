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
import {
  AuthService,
  OAuthManager,
  applySetup,
  checkConfig,
  containerNeedsEnvHandoff,
  defaultStorageFile,
  generateSessionSecret,
  generateSlug,
  getEncryptionKey,
  isLoopbackAddress,
  isRunningInContainer,
  resolveEnvPath,
  resolveSessionSecret,
  sanitizeForLog,
  SETUP_DEFAULT_HOST,
  SETUP_DEFAULT_PORT,
  SETUP_MODE_HOST,
  SETUP_STEPS,
  SetupError,
  SetupValidationError,
  timingSafeEqualString,
  validateSetupStep,
  verifySetupDatabase,
  type DBConnectionProbe,
  type ResolvedSetupConfig,
  type SetupAnswers,
  type SetupD1Config,
  type SetupStepId,
} from '@mcp-ecc/core';
import { McpEccServer } from '@mcp-ecc/mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Everything the wizard needs while no storage adapter exists yet. */
export interface SetupModeConfig {
  /** One-time token required by every /api/setup/* request. Never echoed back. */
  token: string;
  /** Env file the wizard writes. Defaults to core's resolveEnvPath(). */
  envPath?: string;
  /** Provider defaults offered by the wizard. */
  defaultAnswers?: SetupAnswers;
  /** Tests only: relax the loopback restriction. */
  allowNonLoopback?: boolean;
}

export interface ManagementApiConfig {
  /**
   * Storage adapter. Omitted only in setup mode, where the wizard constructs it
   * via createStorage() once the operator has chosen a database.
   */
  storage?: StorageAdapter;
  port: number;
  host: string;
  publicDir: string;
  publicUrl?: string;
  sessionSecret?: string;
  /** Build storage during setup (required whenever `setup` is set). */
  createStorage?: (cfg: ResolvedSetupConfig) => StorageAdapter | Promise<StorageAdapter>;
  /** Raw D1 probe factory used by the connection-verification step. */
  createD1Probe?: (cfg: SetupD1Config) => DBConnectionProbe;
  /** Present only when the process started without a usable configuration. */
  setup?: SetupModeConfig;
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
  return { id: c.id, provider: c.provider, label: c.label, clientId: c.clientId, scopes: c.scopes, tenantId: c.tenantId, accountsServer: c.accountsServer, clientPlatform: c.clientPlatform, clientType: c.clientType, enabled: c.enabled };
}

export class ManagementApi {
  private app: ReturnType<typeof Fastify>;
  /**
   * Storage is absent only while the process runs in setup mode. Every /api
   * route is hard-blocked in that state (onRequest hook -> 503, auth gate ->
   * 503), so the definite-assignment assertion below holds at runtime.
   */
  private storage!: StorageAdapter;
  private oauthManager!: OAuthManager;
  private authService!: AuthService;
  private config: ManagementApiConfig;
  private publicUrl: string;
  private healthTimer?: ReturnType<typeof setInterval>;
  private setupCompleted = false;
  private storageName = 'sqlite';

  constructor(config: ManagementApiConfig) {
    this.config = config;
    if (config.storage) {
      this.installStorage(config.storage, false);
    }
    this.publicUrl = config.publicUrl || process.env.PUBLIC_URL || `http://localhost:${config.port}`;
    if (config.storage) {
      this.storageName = (process.env.MCP_DB_PROVIDER || '').trim() === 'd1' ? 'cloudflare-d1' : 'sqlite';
    }
    this.app = Fastify({ logger: true });
    this.app.setErrorHandler((error: any, request: any, reply: any) => {
      // Request bodies can carry the admin password, the setup token and the
      // master key: sanitize before they reach the log.
      this.app.log.error({ error, body: sanitizeForLog(request.body) }, 'unhandled error');
      if (!reply.sent) {
        reply.code(error?.statusCode || 500).send({ error: error?.message || String(error) });
      }
    });
    this.setupPlugins();
    this.setupRoutes();
    this.setupMcpEndpoint();
  }

  /** Attach a storage adapter (normal boot, or the end of the setup wizard). */
  installStorage(storage: StorageAdapter, complete = true): void {
    this.storage = storage;
    this.oauthManager = new OAuthManager(storage);
    this.authService = new AuthService(storage);
    if (complete) this.setupCompleted = true;
  }

  /** True while the API serves only the UI and /api/setup/*. */
  get inSetupMode(): boolean {
    return !this.storage;
  }

  private get setupConfig(): SetupModeConfig | undefined {
    return this.config.setup;
  }

  private setupPlugins(): void {
    const origin = this.config.publicUrl ? [this.config.publicUrl] : true;
    this.app.register(cors, { origin, credentials: true });
    this.app.register(websocket);

    // Session cookies are signed with SESSION_SECRET — never with the master
    // encryption key, and never with a hardcoded constant.
    //  - configured secret              -> use it
    //  - setup mode                     -> throwaway secret (the wizard writes a
    //                                      fresh SESSION_SECRET into .env; no
    //                                      session can exist before an admin does)
    //  - otherwise missing              -> generate one and persist it
    const resolved = this.config.sessionSecret
      ? { secret: this.config.sessionSecret, source: 'env' as const }
      : this.config.setup
        ? { secret: generateSessionSecret(), source: 'setup-mode' as const }
        // No setup config and no SESSION_SECRET: generate and persist one.
        : resolveSessionSecret();
    if (resolved.source === 'generated') {
      this.app.log.warn('SESSION_SECRET was missing; generated one and stored it in the env file.');
    } else if (resolved.source === 'ephemeral') {
      this.app.log.warn('SESSION_SECRET was missing and could not be persisted; sessions will not survive a restart.');
    }
    this.app.register(cookies, { secret: resolved.secret });

    // Serve the admin UI (SPA). Guard against a missing build dir.
    this.app.register(staticFiles, { root: this.config.publicDir, prefix: '/' });

    // Setup mode: the public UI and /api/setup/* only. Anything else is 503,
    // so the SPA (and every API client) learns that setup is required.
    if (this.setupConfig) {
      this.app.addHook('onRequest', async (request: any, reply: any) => {
        if (this.setupCompleted) return;
        const path = String(request.raw.url || '').split('?')[0];
        // Liveness stays 200 so orchestrators do not restart the container.
        if (path === '/health') return;
        if (path.startsWith('/api/setup/')) return;
        if (path.startsWith('/api/') || path.startsWith('/oauth/') || path.startsWith('/mcp') || path.startsWith('/ws')) {
          return reply.code(503).send({
            error: 'Setup required',
            needsSetup: true,
            message: 'This instance is not configured yet. Open the setup page to choose a database and write .env.',
            setupUrl: '/setup',
          });
        }
      });
    }
  }

  private async refreshAccountHealth(): Promise<void> {
    const accounts = await this.storage.listAccounts();
    for (const account of accounts) {
      try {
        await this.checkAccountConnection(account);
        await this.storage.updateAccount(account.id, { health: 'healthy', status: 'active' });
      } catch {
        await this.storage.updateAccount(account.id, { health: 'unhealthy' });
      }
    }
  }

  /**
   * Cheapest per-provider liveness probe.
   *
   * The 5-minute health timer runs this for every account, so it must be one
   * bounded operation. Probing ONE basic folder (the provider's primary folder)
   * with `limit: 1` replaces the previous `listFolders()` call: folder listing
   * now measures per-folder unread counts and, for IMAP/Zoho, walks every folder
   * (Zoho bounds a scan at 2000 messages/folder, 20s wall clock).
   *
   * Per provider:
   *  - google    : messages.list(label:INBOX, maxResults 1) + one message.get
   *  - microsoft : one Graph request ($top=1, well-known folder name)
   *  - zoho      : account + folder resolution + one messages/view page
   *  - imap/smtp : connect, open INBOX, one search
   *  - caldav    : one PROPFIND (listCalendars)
   *  - carddav    : listContacts({limit:1}) — still enumerates address books and
   *                 vCards; needs a provider-level probe to get cheaper.
   */
  private async checkAccountConnection(account: any): Promise<string> {
    const credentials = account.credentials || {};
    switch (account.provider) {
      case 'google': {
        const { GoogleProvider } = await import('@mcp-ecc/provider-google');
        const provider = new GoogleProvider(account.id, credentials);
        await provider.listMessages('INBOX', { limit: 1 });
        return 'Google Gmail connection succeeded.';
      }
      case 'microsoft': {
        const { MicrosoftProvider } = await import('@mcp-ecc/provider-microsoft');
        const provider = new MicrosoftProvider(account.id, credentials);
        await provider.listMessages('inbox', { limit: 1 });
        return 'Microsoft Graph connection succeeded.';
      }
      case 'zoho': {
        const { ZohoProvider } = await import('@mcp-ecc/provider-zoho');
        const provider = new ZohoProvider(account.id, credentials);
        await provider.listMessages('INBOX', { limit: 1 });
        return 'Zoho Mail connection succeeded.';
      }
      case 'imap':
      case 'smtp': {
        const { ImapSmtpProvider } = await import('@mcp-ecc/provider-imap-smtp');
        const provider = new ImapSmtpProvider(account.id, credentials);
        await provider.listMessages('INBOX', { limit: 1 });
        return 'IMAP connection succeeded.';
      }
      case 'caldav': {
        const { CalDAVProvider } = await import('@mcp-ecc/provider-caldav');
        const provider = new CalDAVProvider(account.id, credentials);
        await provider.listCalendars();
        return 'CalDAV connection succeeded.';
      }
      case 'carddav': {
        const { CardDAVProvider } = await import('@mcp-ecc/provider-carddav');
        const provider = new CardDAVProvider(account.id, credentials);
        await provider.listContacts({ limit: 1 });
        return 'CardDAV connection succeeded.';
      }
      default:
        throw new Error(`Unsupported provider: ${account.provider}`);
    }
  }

  private setupRoutes(): void {
    // --- Health (public) ---
    // Stays 200 while unconfigured so an orchestrator does not restart-loop the
    // container; the status field says what is wrong.
    this.app.get('/health', async () => ({
      status: this.inSetupMode ? 'setup_required' : 'ok',
      setupRequired: this.inSetupMode,
      timestamp: Date.now(),
    }));

    // --- Public info (no auth): expose redirect URI + MCP endpoint for the UI ---
    this.app.get('/api/info', async () => ({
      publicUrl: this.publicUrl,
      oauthRedirectUri: `${this.publicUrl}/oauth/callback`,
      mcpEndpoint: `${this.publicUrl}/mcp`,
      storage: { provider: process.env.MCP_DB_PROVIDER || 'sqlite', adapter: this.storageName },
    }));

    // --- Public bootstrap status (no auth): used to show the 'create admin' screen ---
    this.app.get('/api/bootstrap-status', async () => {
      if (this.inSetupMode) return { needsBootstrap: false, needsSetup: true };
      const count = await this.storage.countUsers();
      return { needsBootstrap: count === 0, needsSetup: false };
    });

    // --- First-run setup -------------------------------------------------
    // Registered only when the process started without a usable configuration
    // (bin.ts sets `setup`). Three-way guard on every request:
    //   1. no user accounts may exist yet (409 once they do),
    //   2. the one-time token from stdout, compared in constant time, and
    //   3. loopback clients only.
    if (this.setupConfig) {
      this.app.get('/api/setup/state', async (request: any, reply: any) => {
        if (!(await this.guardSetupRequest(request, reply))) return reply;
        reply.header('Cache-Control', 'no-store');
        const config = checkConfig();
        const defaults = this.setupDefaults();
        return {
          needsSetup: true,
          steps: SETUP_STEPS,
          bindHost: this.config.host,
          envPath: this.setupConfig?.envPath || resolveEnvPath(),
          inContainer: isRunningInContainer(),
          handoff: containerNeedsEnvHandoff(),
          defaults,
          current: {
            dbProvider: (process.env.MCP_DB_PROVIDER || '').trim(),
            hasEncryptionKey: !!getEncryptionKey(),
            hasSessionSecret: !!process.env.SESSION_SECRET,
          },
          // Variable NAMES that are still missing — never their values.
          configIssues: config.missing,
          usersExist: await this.countExistingUsers(),
        };
      });

      this.app.post('/api/setup/step', async (request: any, reply: any) => {
        if (!(await this.guardSetupRequest(request, reply))) return reply;
        reply.header('Cache-Control', 'no-store');

        const body = (request.body || {}) as { step?: unknown; answers?: SetupAnswers };
        const step = String(body.step || '');
        if (!(SETUP_STEPS as readonly string[]).includes(step)) {
          return reply.code(400).send({ error: `Unknown setup step: ${step}` });
        }
        const stepId = step as SetupStepId;
        const answers: SetupAnswers = { ...(this.setupConfig?.defaultAnswers || {}), ...(body.answers || {}) };

        try {
          // Verification is an action, not a validation: run it for real.
          if (stepId === 'verify-connection') {
            const result = await verifySetupDatabase(answers, { createD1Probe: this.config.createD1Probe });
            return { step: stepId, ok: result.success, error: result.error, provider: result.provider, retryable: true };
          }

          if (stepId !== 'apply') {
            const validation = validateSetupStep(stepId, answers);
            return { step: stepId, ok: validation.valid, errors: validation.errors };
          }

          if (!this.config.createStorage) {
            return reply.code(500).send({ error: 'Setup is not wired to a storage factory on this instance.' });
          }

          // A container that cannot persist .env gets the copy-paste handoff
          // instead of a file write that a recreate would discard.
          const handoff = containerNeedsEnvHandoff();
          const result = await applySetup(answers, {
            createStorage: this.config.createStorage,
            createD1Probe: this.config.createD1Probe,
            envPath: this.setupConfig?.envPath,
            writeEnv: !handoff,
            returnEnvContent: handoff,
          });

          if (!result.handoff && result.envWritten) {
            this.installStorage(result.storage);
            // The process is now configured: start the periodic account checks
            // without waiting for a restart.
            this.startHealthLoop();
          }

          const warning = result.usersExisted
            ? `This database already contains user accounts, so no admin was created.${result.encryptionKeyGenerated ? ' A NEW MCP_ENCRYPTION_KEY was generated: credentials stored with the previous key can no longer be decrypted. Restore the original key before using these accounts.' : ''}`
            : undefined;

          return {
            step: stepId,
            ok: true,
            dbProvider: result.dbProvider,
            envPath: result.envPath,
            envWritten: result.envWritten,
            handoff: result.handoff,
            handoffInstructions: result.handoffInstructions,
            // Present only for the container handoff, so the operator can copy
            // it. Never logged, never rendered.
            envContent: result.envContent,
            adminCreated: result.adminCreated ? { username: result.adminCreated.username } : undefined,
            usersExisted: result.usersExisted,
            warning,
            encryptionKeyGenerated: result.encryptionKeyGenerated,
            sessionSecretGenerated: result.sessionSecretGenerated,
            requiresRestart: true,
            restartReason: result.handoff
              ? 'Paste the copied configuration into your compose-folder .env and recreate the container.'
              : `Restart the service so it binds ${answers.host || SETUP_DEFAULT_HOST} and starts the account health checks.`,
            nextSteps: result.nextSteps,
          };
        } catch (error) {
          if (error instanceof SetupValidationError) {
            return reply.code(400).send({ error: error.message, errors: error.errors });
          }
          if (error instanceof SetupError) {
            return reply.code(400).send({ error: error.message, detail: error.detail });
          }
          return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
        }
      });
    }

    // --- Auth: sessions are persisted in the settings table so logins survive restarts ---
    type SessionRecord = { token: string; userId: string; createdAt: number };

    const loadSessions = async (): Promise<SessionRecord[]> => {
      try {
        const settings = await this.storage.getSettings();
        return (settings as any)?.sessions || [];
      } catch { return []; }
    };
    const saveSessions = async (list: SessionRecord[]) => {
      const settings = await this.storage.getSettings();
      await this.storage.saveSettings({ ...(settings as any), sessions: list, updatedAt: Date.now() });
    };
    const putSession = async (token: string, userId: string) => {
      const list = await loadSessions();
      list.push({ token, userId, createdAt: Date.now() });
      await saveSessions(list);
    };
    const getSessionUser = async (token: string): Promise<User | null> => {
      const list = await loadSessions();
      const rec = list.find((s) => s.token === token);
      if (!rec) return null;
      return this.storage.getUser(rec.userId);
    };
    const deleteSession = async (token: string) => {
      const list = await loadSessions();
      await saveSessions(list.filter((s) => s.token !== token));
    };

    const currentUser = async (req: any): Promise<User | null> => {
      const token = req.cookies?.[SESSION_COOKIE];
      if (!token) return null;
      return getSessionUser(token);
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
      await putSession(token, user.id);
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
      return { user: publicUser(user), bootstrap: true };
    });

    this.app.post('/api/auth/login', async (request: any, reply: any) => {
      const { username, password } = request.body;
      if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
      try {
        const user = await this.authService.authenticate(username, password);
        const token = randomUUID();
        await putSession(token, user.id);
        reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
        return { user: publicUser(user) };
      } catch (e: any) {
        return reply.code(401).send({ error: e.message });
      }
    });

    this.app.post('/api/auth/logout', async (request: any, reply: any) => {
      const token = request.cookies?.[SESSION_COOKIE];
      if (token) await deleteSession(token);
      reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 0 });
      return { success: true };
    });

    this.app.get('/api/auth/me', async (request: any, reply: any) => {
      const user = await currentUser(request);
      if (!user) { reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 0 }); return reply.code(401).send({ error: 'Unauthorized' }); }
      return { user: publicUser(user) };
    });

    // --- Auth gate for everything else under /api ---
    this.app.addHook('preHandler', async (request: any, reply: any) => {
      const url = String(request.raw.url || '').split('?')[0];
      const isPublic = url === '/health'
        || url === '/api/info'
        || url === '/api/bootstrap-status'
        || url === '/api/auth/login'
        || url === '/api/auth/bootstrap'
        || url === '/api/auth/logout'
        // Setup endpoints carry their own one-time-token + loopback guard.
        || url === '/api/setup/state'
        || url === '/api/setup/step'
        || !url.startsWith('/api/');
      if (isPublic) return;
      // No adapter yet: setup mode. The onRequest hook answers non-setup API
      // routes with 503; this is the belt-and-braces path for anything that
      // slips past it.
      if (!this.storage) {
        return reply.code(503).send({ error: 'Setup required', needsSetup: true });
      }
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
          clientPlatform: client.clientPlatform || 'web', clientType: client.clientType || 'confidential',
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
          // Only resolve to a web-platform sibling when no explicit oauthClientId was given
          if (!oauthClientId) {
            const sibling = (await this.storage.listOAuthClients(ownerId)).find(c => 
              c.provider === oauthClient!.provider &&
              c.label === oauthClient!.label &&
              c.clientPlatform === 'web' &&
              c.enabled
            );
            if (sibling) {
              oauthClient = sibling;
            }
          }
          const redirectUri = `${this.publicUrl}/oauth/callback`;
          const flowType = provider === 'google' || provider === 'microsoft' || oauthClient.clientPlatform === 'web' ? 'authorization_code' : 'device_code';
          const flow = await this.oauthManager.startFlow(provider as ProviderName, flowType, OAuthManager.clientToConfig(oauthClient, redirectUri), account.id);
          await this.storage.updateCredentials(account.id, { oauthClientId: oauthClient.id });
          return reply.code(201).send({
            account: { id: account.id, slug: account.slug, name: account.name },
            authorizeUrl: flow.verificationUri,
            verificationUri: flow.verificationUri,
            userCode: flow.userCode,
            deviceCode: flow.deviceCode,
            message: flowType === 'device_code' ? `Account created. Go to ${flow.verificationUri} and enter code: ${flow.userCode}` : 'Account created. Open the authorisation URL to complete setup.',
          });
        }
      }

      return reply.code(201).send({ account: { id: account.id, slug: account.slug, name: account.name } });
    });

    this.app.post('/api/accounts/:id/test-connection', async (request: any, reply: any) => {
      const account = await this.storage.getAccount(request.params.id);
      if (!account || account.ownerId !== request.user.id) return reply.code(404).send({ error: 'Account not found' });
      try {
        const message = await this.checkAccountConnection(account);
        await this.storage.updateAccount(account.id, { health: 'healthy', status: 'active' });
        return { ok: true, message, checkedAt: Date.now() };
      } catch (error: any) {
        await this.storage.updateAccount(account.id, { health: 'unhealthy' });
        return { ok: false, message: error?.message || 'Provider connection failed', checkedAt: Date.now() };
      }
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
      if (client) {
        // Resolve sibling web client if available under same name
        const sibling = account.provider === 'microsoft' ? undefined : (await this.storage.listOAuthClients(request.user.id)).find(c =>
          c.provider === client!.provider &&
          c.label === client!.label &&
          c.clientPlatform === 'web' &&
          c.enabled
        );
        if (sibling) {
          client = sibling;
        }
      }
      if (!client) {
        return reply.code(400).send({ error: `No OAuth client available for ${account.provider}. Add one in OAuth Clients first.` });
      }
      if (!client.clientSecret && (client.clientType === 'confidential' || client.clientPlatform === 'web' || account.provider === 'google')) {
        return reply.code(400).send({ error: `OAuth client '${client.label}' has no usable client secret. Edit or recreate this client with the secret.` });
      }
      const redirectUri = `${this.publicUrl}/oauth/callback`;
      // Google cannot use device flow for Gmail/Calendar scopes. Web clients
      // must use the browser authorisation-code flow; device-capable clients
      // use device flow for Microsoft/Zoho.
      const flowType = account.provider === 'google' || account.provider === 'microsoft' || client.clientPlatform === 'web' ? 'authorization_code' : 'device_code';
      try {
        const flow = await this.oauthManager.startFlow(account.provider as ProviderName, flowType, OAuthManager.clientToConfig(client, redirectUri), account.id);
        // Persist the chosen client on the account for later token refresh.
        await this.storage.updateCredentials(account.id, { oauthClientId: client.id });
        return { authorizeUrl: flow.verificationUri, verificationUri: flow.verificationUri, userCode: flow.userCode, deviceCode: flow.deviceCode, interval: flow.interval, state: flow.state, message: flowType === 'device_code' ? `Go to ${flow.verificationUri} and enter code: ${flow.userCode}` : 'Open the authorisation URL to complete reauthentication.' };
      } catch (error: any) {
        return reply.code(400).send({ error: error?.message || 'Unable to start reauthentication flow' });
      }
    });

    // OAuth callback completes a flow and stores tokens on the pending account.
    this.app.get('/oauth/callback', async (request: any, reply: any) => {
      const { code, state } = request.query;
      if (!code || !state) return reply.code(400).send({ error: 'Missing code or state' });
      try {
        const oauthState = await this.storage.getOAuthState(String(state));
        const tokens = await this.oauthManager.completeFlow(String(state), String(code));
        if (oauthState?.accountId) {
          await this.storage.updateCredentials(oauthState.accountId, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiryDate: tokens.expiresAt,
            scope: tokens.scope,
            idToken: tokens.idToken,
            tokenType: tokens.tokenType,
            clientId: oauthState.clientId,
            clientSecret: oauthState.clientSecret,
            config: { accountsServer: oauthState.accountsServer },
          } as any);
          await this.storage.updateAccount(oauthState.accountId, { status: 'active', health: 'unknown' });
        }
        // Return the browser to the authenticated admin UI instead of leaving
        // it on a JSON callback response. The session cookie is same-origin.
        return reply.redirect('/accounts?oauth=success');
      } catch (error: any) {
        const message = encodeURIComponent(error?.message || 'OAuth completion failed');
        return reply.redirect(`/accounts?oauth=error&message=${message}`);
      }
    });

    // --- OAuth clients (per-user) ---
    this.app.get('/api/oauth-clients', async (request: any) => {
      const clients = await this.storage.listOAuthClients(request.user.id);
      return { clients: clients.map(publicClient) };
    });

    this.app.post('/api/oauth-clients', async (request: any, reply: any) => {
      const { provider, label, clientId, clientSecret, scopes, tenantId, accountsServer, clientPlatform, clientType } = request.body;
      if (!provider || !label || !clientId) return reply.code(400).send({ error: 'provider, label, clientId required' });
      if (!AUTH_PROVIDERS.includes(provider)) return reply.code(400).send({ error: `Unsupported provider: ${provider}` });
      const client: OAuthClient = {
        id: randomUUID(), ownerId: request.user.id, provider, label, clientId, clientSecret: clientSecret || '',
        scopes: scopes || [], tenantId, accountsServer, clientPlatform, clientType, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
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
    
    this.app.patch('/api/oauth-clients/:id', async (request: any, reply: any) => {
      const client = await this.storage.getOAuthClient(request.params.id);
      if (!client || client.ownerId !== request.user.id) return reply.code(404).send({ error: 'Client not found' });
      const { label, clientId, clientSecret, scopes, tenantId, accountsServer, clientPlatform, clientType } = request.body;
      const updates: any = { updatedAt: Date.now() };
      if (label !== undefined) updates.label = label;
      if (clientId !== undefined) updates.clientId = clientId;
      if (clientSecret !== undefined) updates.clientSecret = clientSecret;
      if (scopes !== undefined) updates.scopes = scopes;
      if (tenantId !== undefined) updates.tenantId = tenantId;
      if (accountsServer !== undefined) updates.accountsServer = accountsServer;
      if (clientPlatform !== undefined) updates.clientPlatform = clientPlatform;
      if (clientType !== undefined) updates.clientType = clientType;
      const merged = { ...client, ...updates };
      await this.storage.saveOAuthClient(merged);
      return { client: publicClient(merged) };
    });

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

  // --- Setup-mode helpers --------------------------------------------------

  /** Defaults offered by the wizard (values already in the environment win). */
  private setupDefaults(): {
    dbProvider: string;
    storageFile: string;
    port: string;
    host: string;
    publicUrl: string;
  } {
    const port = (process.env.PORT || '').trim() || SETUP_DEFAULT_PORT;
    return {
      dbProvider: (process.env.MCP_DB_PROVIDER || '').trim() || 'sqlite',
      storageFile: (process.env.MCP_STORAGE_FILE || '').trim() || defaultStorageFile(),
      port,
      host: (process.env.HOST || '').trim() || SETUP_DEFAULT_HOST,
      publicUrl: (process.env.PUBLIC_URL || '').trim() || `http://localhost:${port}`,
    };
  }

  /**
   * How many users the database has, or null when no adapter is reachable yet.
   * Used to refuse setup on an instance that already has accounts.
   */
  private async countExistingUsers(): Promise<number | null> {
    if (!this.storage) return null;
    try {
      return await this.storage.countUsers();
    } catch {
      return null;
    }
  }

  /**
   * Guard for /api/setup/*: (1) no admin may exist, (2) one-time token in
   * constant time, (3) loopback caller only.
   *
   * The token is never echoed in a response and never logged.
   */
  private async guardSetupRequest(request: any, reply: any): Promise<boolean> {
    const setup = this.setupConfig;
    if (!setup) {
      reply.code(404).send({ error: 'Setup is not available on this instance' });
      return false;
    }
    if (this.setupCompleted) {
      reply.code(409).send({ error: 'Setup has already been completed on this instance' });
      return false;
    }
    if (!setup.allowNonLoopback && !isLoopbackAddress(request.ip)) {
      reply.code(403).send({ error: 'Setup is only reachable from localhost' });
      return false;
    }
    const provided = String(request.headers?.['x-setup-token'] || '');
    if (!provided || !timingSafeEqualString(provided, setup.token)) {
      reply.code(401).send({ error: 'Invalid or missing setup token' });
      return false;
    }
    const users = await this.countExistingUsers();
    if (users !== null && users > 0) {
      reply.code(409).send({
        error: 'Setup is not allowed: this database already contains user accounts. Repair the existing configuration instead of re-running setup.',
      });
      return false;
    }
    return true;
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
    if (this.inSetupMode) {
      // No storage, no health checks: the wizard owns the process for now.
      this.app.log.warn(
        `mcp-ecc is unconfigured and running in SETUP MODE on ${this.config.host}:${this.config.port}. Open http://${SETUP_MODE_HOST}:${this.config.port}/setup`,
      );
      return;
    }
    this.startHealthLoop();
    console.log(`mcp-ecc management API listening on http://${this.config.host}:${this.config.port}`);
  }

  /** Check persisted accounts once at startup and every 5 minutes thereafter. */
  private startHealthLoop(): void {
    if (this.healthTimer || this.inSetupMode) return;
    void this.refreshAccountHealth();
    this.healthTimer = setInterval(() => void this.refreshAccountHealth(), 5 * 60 * 1000);
    this.healthTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.app.close();
  }

  getApp() {
    return this.app;
  }
}