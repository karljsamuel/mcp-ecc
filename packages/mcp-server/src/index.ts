import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { StorageAdapter, Account, ProviderName } from '@mcp-ecc/core';
import { GoogleProvider } from '@mcp-ecc/provider-google';
import { MicrosoftProvider } from '@mcp-ecc/provider-microsoft';
import { ZohoProvider } from '@mcp-ecc/provider-zoho';
import { ImapSmtpProvider } from '@mcp-ecc/provider-imap-smtp';
import { CalDAVProvider } from '@mcp-ecc/provider-caldav';
import { CardDAVProvider } from '@mcp-ecc/provider-carddav';

interface ProviderInstances {
  mail: any;
  calendar: any;
  contacts: any;
}

export class McpEccServer {
  private server: Server;
  private storage: StorageAdapter;
  private ownerId: string | null;
  private providerCache = new Map<string, ProviderInstances>();

  constructor(storage: StorageAdapter, ownerId?: string | null) {
    this.storage = storage;
    this.ownerId = ownerId || null;
    this.server = new Server(
      { name: 'mcp-ecc', version: '0.3.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );
    this.setupHandlers();
  }

  getServer(): Server {
    return this.server;
  }

  private async assertOwns(account: any): Promise<void> {
    if (this.ownerId && account.ownerId && account.ownerId !== this.ownerId) {
      throw new Error(`Account not found: ${account.id}`);
    }
  }

  private async getAccountOwned(accountId: string): Promise<any> {
    const account = await this.storage.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);
    await this.assertOwns(account);
    return account;
  }

  private async getOrCreateProviders(accountId: string): Promise<ProviderInstances> {
    if (this.providerCache.has(accountId)) {
      return this.providerCache.get(accountId)!;
    }

    const account = await this.getAccountOwned(accountId);

    let mailProvider: any;
    let calendarProvider: any;
    let contactsProvider: any;

    switch (account.provider) {
      case 'google':
        mailProvider = new GoogleProvider(accountId, account.credentials);
        calendarProvider = new GoogleProvider(accountId, account.credentials);
        contactsProvider = new GoogleProvider(accountId, account.credentials);
        break;
      case 'microsoft':
        mailProvider = new MicrosoftProvider(accountId, account.credentials);
        calendarProvider = new MicrosoftProvider(accountId, account.credentials);
        contactsProvider = new MicrosoftProvider(accountId, account.credentials);
        break;
      case 'zoho':
        mailProvider = new ZohoProvider(accountId, account.credentials);
        calendarProvider = new ZohoProvider(accountId, account.credentials);
        contactsProvider = new ZohoProvider(accountId, account.credentials);
        break;
      case 'imap':
      case 'smtp':
        mailProvider = new ImapSmtpProvider(accountId, account.credentials);
        calendarProvider = null; // Not supported
        contactsProvider = null; // Not supported
        break;
      case 'caldav':
        mailProvider = null; // Not supported
        calendarProvider = new CalDAVProvider(accountId, account.credentials);
        contactsProvider = null; // Not supported
        break;
      case 'carddav':
        mailProvider = null; // Not supported
        calendarProvider = null; // Not supported
        contactsProvider = new CardDAVProvider(accountId, account.credentials);
        break;
      default:
        throw new Error(`Unsupported provider: ${account.provider}`);
    }

    const providers: ProviderInstances = { mail: mailProvider, calendar: calendarProvider, contacts: contactsProvider };
    this.providerCache.set(accountId, providers);
    return providers;
  }

  private setupHandlers(): void {
    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const accounts = await this.storage.listAccounts(this.ownerId || undefined);
      const resources = [];

      for (const account of accounts) {
        if (account.status !== 'active') continue;

        // Today's agenda resource
        if (account.provider !== 'imap' && account.provider !== 'smtp') {
          resources.push({
            uri: `mcp-ecc://${account.slug}/today-agenda`,
            name: `Today's agenda for ${account.name}`,
            mimeType: 'text/markdown',
            description: `Consolidated daily calendar view and unread messages count for ${account.name}`,
          });
        }

        // Mail folders
        if (account.provider !== 'caldav' && account.provider !== 'carddav') {
          resources.push({
            uri: `mcp-ecc://${account.slug}/mail/folders`,
            name: `Mail folders for ${account.name}`,
            mimeType: 'application/json',
            description: `List of mail folders for ${account.name}`,
          });
        }

        // Calendars
        if (account.provider !== 'imap' && account.provider !== 'smtp' && account.provider !== 'carddav') {
          resources.push({
            uri: `mcp-ecc://${account.slug}/calendars`,
            name: `Calendars for ${account.name}`,
            mimeType: 'application/json',
            description: `List of calendars for ${account.name}`,
          });
        }

        // Contacts
        if (account.provider !== 'imap' && account.provider !== 'smtp' && account.provider !== 'caldav') {
          resources.push({
            uri: `mcp-ecc://${account.slug}/contacts`,
            name: `Contacts for ${account.name}`,
            mimeType: 'application/json',
            description: `Contact list for ${account.name}`,
          });
        }
      }

      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^mcp-ecc:\/\/([^/]+)\/(.+)$/);
      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const [, slug, resourcePath] = match;
      let account;
      if (this.ownerId) {
        account = await this.storage.getAccountBySlug(slug, this.ownerId);
      } else {
        // No owner context: resolve slug across all accounts (first match).
        const all = await this.storage.listAccounts();
        account = all.find(a => a.slug === slug);
      }
      if (!account) throw new Error(`Account not found: ${slug}`);
      const providers = await this.getOrCreateProviders(account.id);

      if (resourcePath === 'today-agenda') {
        if (!providers.calendar || !providers.mail) {
          throw new Error('Today agenda not supported for this account type');
        }

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const [events, messages] = await Promise.all([
          providers.calendar.listEvents('primary', { timeMin: startOfDay.getTime(), timeMax: endOfDay.getTime() }),
          providers.mail.listMessages('INBOX', { limit: 10 }).catch(() => []),
        ]);

        let markdown = `# Agenda and Overview for ${account.name}\n\n`;
        markdown += `## Today's Events (${new Date().toDateString()})\n`;
        
        if (events.length === 0) {
          markdown += `- No events scheduled for today.\n`;
        } else {
          for (const evt of events) {
            const start = new Date(evt.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(evt.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            markdown += `- **${start} - ${end}**: ${evt.summary} (${evt.location || 'No Location'})\n`;
            if (evt.description) {
              markdown += `  *Description: ${evt.description}*\n`;
            }
          }
        }

        markdown += `\n## Recent Inbox Messages\n`;
        const unread = messages.filter((m: any) => m.unread);
        if (unread.length === 0) {
          markdown += `- No unread messages in the top INBOX.\n`;
        } else {
          for (const m of unread) {
            markdown += `- **From**: ${m.from.address} | **Subject**: ${m.subject} *(ID: ${m.id})*\n`;
          }
        }

        return {
          contents: [{ uri, mimeType: 'text/markdown', text: markdown }],
        };
      }

      if (resourcePath === 'mail/folders') {
        if (!providers.mail) throw new Error('Mail not supported for this account');
        const folders = await providers.mail.listFolders();
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(folders, null, 2) }],
        };
      }

      if (resourcePath === 'calendars') {
        if (!providers.calendar) throw new Error('Calendar not supported for this account');
        const calendars = await providers.calendar.listCalendars();
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(calendars, null, 2) }],
        };
      }

      if (resourcePath === 'contacts') {
        if (!providers.contacts) throw new Error('Contacts not supported for this account');
        const contacts = await providers.contacts.listContacts({ limit: 100 });
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(contacts, null, 2) }],
        };
      }

      throw new Error(`Unknown resource path: ${resourcePath}`);
    });

    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
        // Account management tools
        {
          name: 'accounts.list',
          description: 'List all configured accounts',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'accounts.get',
          description: 'Get account details',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
        },
        {
          name: 'accounts.add',
          description: 'Add a new account (starts OAuth flow)',
          inputSchema: { 
            type: 'object', 
            properties: { 
              provider: { type: 'string', enum: ['google', 'microsoft', 'zoho', 'imap', 'smtp', 'caldav', 'carddav'] },
              email: { type: 'string' },
              config: { type: 'object' },
            }, 
            required: ['provider', 'email'] 
          },
        },
        {
          name: 'accounts.remove',
          description: 'Remove an account',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
        },
        {
          name: 'accounts.sync',
          description: 'Trigger sync for an account',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              types: { type: 'array', items: { type: 'string', enum: ['mail', 'calendar', 'contacts'] } } 
            }, 
            required: ['accountId'] 
          },
        },

        // Mail tools
        {
          name: 'mail.listFolders',
          description: 'List mail folders for an account',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
        },
        {
          name: 'mail.listMessages',
          description: 'List messages in a folder',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              folderId: { type: 'string' }, 
              limit: { type: 'number' }, 
              query: { type: 'string' } 
            }, 
            required: ['accountId', 'folderId'] 
          },
        },
        {
          name: 'mail.getMessage',
          description: 'Get a specific message',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' } }, required: ['accountId', 'messageId'] },
        },
        {
          name: 'mail.sendMessage',
          description: 'Send an email',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              to: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' } } } },
              cc: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' } } } },
              bcc: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' } } } },
              subject: { type: 'string' },
              body: { type: 'string' },
              htmlBody: { type: 'string' },
              inReplyTo: { type: 'string' },
            }, 
            required: ['accountId', 'to', 'subject', 'body'] 
          },
        },
        {
          name: 'mail.searchMessages',
          description: 'Search messages',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['accountId', 'query'] },
        },
        {
          name: 'mail.moveMessage',
          description: 'Move message to folder',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' }, folderId: { type: 'string' } }, required: ['accountId', 'messageId', 'folderId'] },
        },
        {
          name: 'mail.setFlags',
          description: 'Set/remove flags on message',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' }, addFlags: { type: 'array', items: { type: 'string' } }, removeFlags: { type: 'array', items: { type: 'string' } } }, required: ['accountId', 'messageId'] },
        },
        {
          name: 'mail.deleteMessage',
          description: 'Delete a message',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' }, permanent: { type: 'boolean' } }, required: ['accountId', 'messageId'] },
        },

        // Calendar tools
        {
          name: 'calendar.listCalendars',
          description: 'List calendars for an account',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
        },
        {
          name: 'calendar.listEvents',
          description: 'List events in a calendar',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              calendarId: { type: 'string' }, 
              timeMin: { type: 'number' }, 
              timeMax: { type: 'number' }, 
              limit: { type: 'number' } 
            }, 
            required: ['accountId', 'calendarId'] 
          },
        },
        {
          name: 'calendar.getEvent',
          description: 'Get a specific event',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, calendarId: { type: 'string' }, eventId: { type: 'string' } }, required: ['accountId', 'calendarId', 'eventId'] },
        },
        {
          name: 'calendar.createEvent',
          description: 'Create a new event',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              calendarId: { type: 'string' }, 
              summary: { type: 'string' }, 
              startAt: { type: 'number' }, 
              endAt: { type: 'number' }, 
              description: { type: 'string' }, 
              location: { type: 'string' }, 
              attendees: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' } } } },
              allDay: { type: 'boolean' },
              recurrenceRule: { type: 'string' },
            }, 
            required: ['accountId', 'calendarId', 'summary', 'startAt', 'endAt'] 
          },
        },
        {
          name: 'calendar.updateEvent',
          description: 'Update an event',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              calendarId: { type: 'string' }, 
              eventId: { type: 'string' }, 
              summary: { type: 'string' }, 
              startAt: { type: 'number' }, 
              endAt: { type: 'number' }, 
              description: { type: 'string' }, 
              location: { type: 'string' }, 
              attendees: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' } } } },
              status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
            }, 
            required: ['accountId', 'calendarId', 'eventId'] 
          },
        },
        {
          name: 'calendar.deleteEvent',
          description: 'Delete an event',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, calendarId: { type: 'string' }, eventId: { type: 'string' } }, required: ['accountId', 'calendarId', 'eventId'] },
        },
        {
          name: 'calendar.freeBusy',
          description: 'Get free/busy information',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, calendarIds: { type: 'array', items: { type: 'string' } }, timeMin: { type: 'number' }, timeMax: { type: 'number' } }, required: ['accountId', 'calendarIds', 'timeMin', 'timeMax'] },
        },

        // Contacts tools
        {
          name: 'contacts.list',
          description: 'List contacts for an account',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['accountId'] },
        },
        {
          name: 'contacts.get',
          description: 'Get a specific contact',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, contactId: { type: 'string' } }, required: ['accountId', 'contactId'] },
        },
        {
          name: 'contacts.create',
          description: 'Create a new contact',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              displayName: { type: 'string' }, 
              emails: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' }, type: { type: 'string' } } } },
              phones: { type: 'array', items: { type: 'object', properties: { number: { type: 'string' }, type: { type: 'string' } } } },
              organization: { type: 'string' },
              jobTitle: { type: 'string' },
              notes: { type: 'string' },
            }, 
            required: ['accountId', 'displayName'] 
          },
        },
        {
          name: 'contacts.update',
          description: 'Update a contact',
          inputSchema: { 
            type: 'object', 
            properties: { 
              accountId: { type: 'string' }, 
              contactId: { type: 'string' }, 
              displayName: { type: 'string' }, 
              emails: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' }, type: { type: 'string' } } } },
              phones: { type: 'array', items: { type: 'object', properties: { number: { type: 'string' }, type: { type: 'string' } } } },
              organization: { type: 'string' },
              jobTitle: { type: 'string' },
              notes: { type: 'string' },
            }, 
            required: ['accountId', 'contactId'] 
          },
        },
        {
          name: 'contacts.delete',
          description: 'Delete a contact',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, contactId: { type: 'string' } }, required: ['accountId', 'contactId'] },
        },
        {
          name: 'contacts.search',
          description: 'Search contacts',
          inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['accountId', 'query'] },
        },
      ];

      return { tools };
    });

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const args_ = (args || {}) as Record<string, any>;
      let result: any;

      try {

        // Account tools
        if (name === 'accounts.list') {
          const accounts = await this.storage.listAccounts(this.ownerId || undefined);
          result = { accounts: accounts.map(a => ({ id: a.id, slug: a.slug, provider: a.provider, name: a.name, email: a.email, status: a.status, health: a.health })) };
        }
        else if (name === 'accounts.get') {
          const account = await this.getAccountOwned(args_.accountId);
          result = { account: { id: account.id, slug: account.slug, provider: account.provider, name: account.name, email: account.email, displayName: account.displayName, status: account.status, health: account.health } };
        }
        else if (name === 'accounts.add') {
          // This would start OAuth flow - handled via management UI / CLI
          result = { message: 'Use CLI or management UI to add accounts' };
        }
        else if (name === 'accounts.remove') {
          const account = await this.getAccountOwned(args_.accountId);
          await this.storage.deleteAccount(account.id);
          this.providerCache.delete(account.id);
          result = { success: true };
        }
        else if (name === 'accounts.sync') {
          result = { message: 'Sync triggered - implementation pending' };
        }

        // Mail tools
        else if (name === 'mail.listFolders') {
          const args_ = args as { accountId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          result = { folders: await providers.mail.listFolders() };
        }
        else if (name === 'mail.listMessages') {
          const args_ = args as { accountId: string; folderId: string; limit?: number; query?: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          result = { messages: await providers.mail.listMessages(args_.folderId, { limit: args_.limit, query: args_.query }) };
        }
        else if (name === 'mail.getMessage') {
          const args_ = args as { accountId: string; messageId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          result = { message: await providers.mail.getMessage(args_.messageId) };
        }
        else if (name === 'mail.sendMessage') {
          const args_ = args as { accountId: string; to: any[]; cc?: any[]; bcc?: any[]; subject: string; body: string; htmlBody?: string; inReplyTo?: string; };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          result = { message: await providers.mail.sendMessage(args_) };
        }
        else if (name === 'mail.searchMessages') {
          const args_ = args as { accountId: string; query: string; limit?: number };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          result = { messages: await providers.mail.searchMessages(args_.query, { limit: args_.limit }) };
        }
        else if (name === 'mail.moveMessage') {
          const args_ = args as { accountId: string; messageId: string; folderId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          await providers.mail.moveMessage(args_.messageId, args_.folderId);
          result = { success: true };
        }
        else if (name === 'mail.setFlags') {
          const args_ = args as { accountId: string; messageId: string; addFlags?: string[]; removeFlags?: string[] };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          await providers.mail.setFlags(args_.messageId, args_.addFlags || [], args_.removeFlags || []);
          result = { success: true };
        }
        else if (name === 'mail.deleteMessage') {
          const args_ = args as { accountId: string; messageId: string; permanent?: boolean };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.mail) throw new Error('Mail not supported for this account');
          await providers.mail.deleteMessage(args_.messageId, args_.permanent);
          result = { success: true };
        }

        // Calendar tools
        else if (name === 'calendar.listCalendars') {
          const args_ = args as { accountId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          result = { calendars: await providers.calendar.listCalendars() };
        }
        else if (name === 'calendar.listEvents') {
          const args_ = args as { accountId: string; calendarId: string; timeMin?: number; timeMax?: number; limit?: number };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          result = { events: await providers.calendar.listEvents(args_.calendarId, { timeMin: args_.timeMin, timeMax: args_.timeMax, limit: args_.limit }) };
        }
        else if (name === 'calendar.getEvent') {
          const args_ = args as { accountId: string; calendarId: string; eventId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          result = { event: await providers.calendar.getEvent(args_.calendarId, args_.eventId) };
        }
        else if (name === 'calendar.createEvent') {
          const args_ = args as { accountId: string; calendarId: string; summary: string; startAt: number; endAt: number; description?: string; location?: string; attendees?: any[]; allDay?: boolean; recurrenceRule?: string; };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          result = { event: await providers.calendar.createEvent(args_.calendarId, args_) };
        }
        else if (name === 'calendar.updateEvent') {
          const args_ = args as { accountId: string; calendarId: string; eventId: string; summary?: string; startAt?: number; endAt?: number; description?: string; location?: string; attendees?: any[]; status?: string; };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          result = { event: await providers.calendar.updateEvent(args_.calendarId, args_.eventId, args_) };
        }
        else if (name === 'calendar.deleteEvent') {
          const args_ = args as { accountId: string; calendarId: string; eventId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          await providers.calendar.deleteEvent(args_.calendarId, args_.eventId);
          result = { success: true };
        }
        else if (name === 'calendar.freeBusy') {
          const args_ = args as { accountId: string; calendarIds: string[]; timeMin: number; timeMax: number };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.calendar) throw new Error('Calendar not supported for this account');
          result = { freeBusy: await providers.calendar.freeBusy(args_.calendarIds, args_.timeMin, args_.timeMax) };
        }

        // Contacts tools
        else if (name === 'contacts.list') {
          const args_ = args as { accountId: string; limit?: number; cursor?: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.contacts) throw new Error('Contacts not supported for this account');
          result = { contacts: await providers.contacts.listContacts({ limit: args_.limit, cursor: args_.cursor }) };
        }
        else if (name === 'contacts.get') {
          const args_ = args as { accountId: string; contactId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.contacts) throw new Error('Contacts not supported for this account');
          result = { contact: await providers.contacts.getContact(args_.contactId) };
        }
        else if (name === 'contacts.create') {
          const args_ = args as { accountId: string; displayName: string; emails: any[]; phones?: any[]; organization?: string; jobTitle?: string; notes?: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.contacts) throw new Error('Contacts not supported for this account');
          result = { contact: await providers.contacts.createContact(args_) };
        }
        else if (name === 'contacts.update') {
          const args_ = args as { accountId: string; contactId: string; displayName?: string; emails?: any[]; phones?: any[]; organization?: string; jobTitle?: string; notes?: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.contacts) throw new Error('Contacts not supported for this account');
          result = { contact: await providers.contacts.updateContact(args_.contactId, args_) };
        }
        else if (name === 'contacts.delete') {
          const args_ = args as { accountId: string; contactId: string };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.contacts) throw new Error('Contacts not supported for this account');
          await providers.contacts.deleteContact(args_.contactId);
          result = { success: true };
        }
        else if (name === 'contacts.search') {
          const args_ = args as { accountId: string; query: string; limit?: number };
          const providers = await this.getOrCreateProviders(args_.accountId);
          if (!providers.contacts) throw new Error('Contacts not supported for this account');
          result = { contacts: await providers.contacts.searchContacts(args_.query, { limit: args_.limit }) };
        }

        else {
          throw new Error(`Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    });

    // Prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        { name: 'daily_briefing', description: 'Generate a daily briefing from all accounts', arguments: [] },
        { name: 'weekly_review', description: 'Generate a weekly review from all accounts', arguments: [] },
      ],
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name } = request.params;
      if (name === 'daily_briefing') {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Generate a daily briefing from all connected accounts including today\'s calendar events, unread emails, and important contacts.' } }] };
      }
      if (name === 'weekly_review') {
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Generate a weekly review from all connected accounts including upcoming events, email summaries, and contact updates.' } }] };
      }
      throw new Error(`Unknown prompt: ${name}`);
    });
  }
}