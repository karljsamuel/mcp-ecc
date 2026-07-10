import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { AccountProviderRegistry } from './providers/registry.js';
import { HeadlessAuthManager } from './auth.js';
import { TokenStorage } from './storage.js';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'mcp-email-calendar-contacts',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  // --- Register Resource Lists ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const accounts = TokenStorage.listAccounts();
    const resources = [];

    for (const acc of accounts) {
      if (acc.provider !== 'imap_smtp') {
        resources.push({
          uri: `comms://${acc.accountId}/today-agenda`,
          name: `Today's agenda for ${acc.accountId}`,
          mimeType: 'text/markdown',
          description: `Consolidated daily calendar view and unread messages count for ${acc.accountId}`
        });
      }
    }

    return { resources };
  });

  // --- Read Resource Content ---
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const match = uri.match(/^comms:\/\/([^/]+)\/today-agenda$/);
    if (!match) {
      throw new Error(`Resource ${uri} not found.`);
    }

    const accountId = match[1];
    
    try {
      const calendar = await AccountProviderRegistry.getCalendarProvider(accountId);
      const email = await AccountProviderRegistry.getEmailProvider(accountId);

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const [events, unreadEmails] = await Promise.all([
        calendar.listEvents(startOfDay.toISOString(), endOfDay.toISOString()),
        email.listEmails('INBOX', 5).catch(() => []) // Read first few
      ]);

      let markdown = `# Agenda and Overview for ${accountId}\n\n`;
      
      markdown += `## Today's Events (${new Date().toDateString()})\n`;
      if (events.length === 0) {
        markdown += `- No events scheduled for today.\n`;
      } else {
        events.forEach(evt => {
          const start = new Date(evt.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const end = new Date(evt.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          markdown += `- **${start} - ${end}**: ${evt.title} (${evt.location || 'No Location'})\n`;
          if (evt.description) {
            markdown += `  *Description: ${evt.description}*\n`;
          }
        });
      }

      markdown += `\n## Recent Inbox Messages\n`;
      const unread = unreadEmails.filter(e => e.unread);
      if (unread.length === 0) {
        markdown += `- No unread messages in the top INBOX.\n`;
      } else {
        unread.forEach(m => {
          markdown += `- **From**: ${m.from} | **Subject**: ${m.subject} *(ID: ${m.id})*\n`;
        });
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: markdown
          }
        ]
      };
    } catch (error: any) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: `# Error Loading Agenda for ${accountId}\n\n${error.message}`
          }
        ]
      };
    }
  });

  // --- Register Tool Definitions ---
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'authenticate_account',
          description: 'Authenticate and register a Google, Microsoft, Zoho, or IMAP/SMTP account. Supports headless OAuth (device code flow) with custom client/tenant configurations.',
          inputSchema: {
            type: 'object',
            properties: {
              provider: { type: 'string', enum: ['google', 'microsoft', 'zoho', 'imap_smtp'] },
              accountId: { type: 'string', description: 'Unique identifier / email address for this account' },
              clientId: { type: 'string', description: 'OAuth Client ID (required for Google, Microsoft, Zoho)' },
              clientSecret: { type: 'string', description: 'OAuth Client Secret (optional/required depending on provider)' },
              tenantId: { type: 'string', description: 'Microsoft Tenant ID (optional, defaults to common; use organizations for M365 accounts)' },
              appPassword: { type: 'string', description: 'Plain text App Password (required for IMAP/SMTP)' },
              config: {
                type: 'object',
                description: 'Additional configurations (e.g., host/ports for IMAP/SMTP or redirect URIs)',
                properties: {
                  imapHost: { type: 'string' },
                  imapPort: { type: 'number' },
                  imapTls: { type: 'boolean' },
                  smtpHost: { type: 'string' },
                  smtpPort: { type: 'number' },
                  smtpSecure: { type: 'boolean' }
                }
              }
            },
            required: ['provider', 'accountId']
          }
        },
        // --- Email Tools ---
        {
          name: 'email_list_emails',
          description: 'Search or view recent emails.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              folder: { type: 'string', default: 'INBOX' },
              limit: { type: 'number', default: 10 },
              query: { type: 'string', description: 'Search keywords or parameters' }
            },
            required: ['accountId']
          }
        },
        {
          name: 'email_get_email',
          description: 'Fetch the body and metadata of a specific email.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              messageId: { type: 'string' }
            },
            required: ['accountId', 'messageId']
          }
        },
        {
          name: 'email_send_email',
          description: 'Send a plain text or HTML email.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              to: { type: 'array', items: { type: 'string' } },
              subject: { type: 'string' },
              body: { type: 'string' },
              cc: { type: 'array', items: { type: 'string' } },
              bcc: { type: 'array', items: { type: 'string' } }
            },
            required: ['accountId', 'to', 'subject', 'body']
          }
        },
        {
          name: 'email_manage_email',
          description: 'Archive, mark read/unread, or star an email.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              messageId: { type: 'string' },
              action: { type: 'string', enum: ['archive', 'read', 'unread', 'star'] }
            },
            required: ['accountId', 'messageId', 'action']
          }
        },
        {
          name: 'email_delete_email',
          description: 'Move email to Trash or delete permanently.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              messageId: { type: 'string' }
            },
            required: ['accountId', 'messageId']
          }
        },
        // --- Calendar Tools ---
        {
          name: 'calendar_list_events',
          description: 'View scheduled events/appointments within a time range.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              startTime: { type: 'string', description: 'ISO 8601 string start time (defaults to now)' },
              endTime: { type: 'string', description: 'ISO 8601 string end time' }
            },
            required: ['accountId']
          }
        },
        {
          name: 'calendar_create_event',
          description: 'Create a calendar event.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              title: { type: 'string' },
              startTime: { type: 'string', description: 'ISO 8601 start time' },
              endTime: { type: 'string', description: 'ISO 8601 end time' },
              description: { type: 'string' },
              attendees: { type: 'array', items: { type: 'string' } }
            },
            required: ['accountId', 'title', 'startTime', 'endTime']
          }
        },
        {
          name: 'calendar_update_event',
          description: 'Modify an existing calendar event.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              eventId: { type: 'string' },
              patches: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  startTime: { type: 'string' },
                  endTime: { type: 'string' },
                  description: { type: 'string' },
                  attendees: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            required: ['accountId', 'eventId', 'patches']
          }
        },
        {
          name: 'calendar_delete_event',
          description: 'Delete/remove a calendar event.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              eventId: { type: 'string' }
            },
            required: ['accountId', 'eventId']
          }
        },
        // --- Contacts Tools ---
        {
          name: 'contacts_search_contacts',
          description: 'Find contact entries by name or query term.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              query: { type: 'string' }
            },
            required: ['accountId', 'query']
          }
        },
        {
          name: 'contacts_create_contact',
          description: 'Inject a new contact into the address book.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              name: { type: 'string' },
              email: { type: 'string' },
              phone: { type: 'string' }
            },
            required: ['accountId', 'name', 'email']
          }
        },
        {
          name: 'contacts_delete_contact',
          description: 'Remove a contact entry.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              contactId: { type: 'string' }
            },
            required: ['accountId', 'contactId']
          }
        }
      ]
    };
  });

  // --- Handlers for Tools ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      if (name === 'authenticate_account') {
        const { provider, accountId, clientId, clientSecret, tenantId, appPassword, accessToken, refreshToken, config } = args as any;

        if (provider === 'imap_smtp') {
          if (!appPassword) {
            return {
              content: [{ type: 'text', text: 'Error: appPassword is required for IMAP/SMTP provider authentication.' }],
              isError: true
            };
          }
          TokenStorage.saveAccount({
            accountId,
            provider: 'imap_smtp',
            tokens: { appPassword, config }
          });
          return {
            content: [{ type: 'text', text: `Success: IMAP/SMTP account '${accountId}' successfully saved.` }]
          };
        } else if (provider === 'google' || provider === 'microsoft') {
          if (!clientId) {
            return {
              content: [{ type: 'text', text: `Error: clientId is required for OAuth authentication.` }],
              isError: true
            };
          }
          // Device Flow Authorization
          const deviceCodeRes = await HeadlessAuthManager.initiateDeviceFlow(provider, clientId, tenantId);
          
          console.error(`Please visit: ${deviceCodeRes.verification_uri}`);
          console.error(`And enter this code: ${deviceCodeRes.user_code}`);

          // Return instruction to host / agent, then start async polling and save token in background.
          const prompt = `Please configure this account by going to: ${deviceCodeRes.verification_uri}\nEnter the code: ${deviceCodeRes.user_code}\n\nWaiting for completion...`;
          
          // Poll (will block this call until resolved or timed out)
          const result = await HeadlessAuthManager.pollForTokens(
            provider,
            deviceCodeRes.device_code,
            deviceCodeRes.interval,
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

          return {
            content: [{ type: 'text', text: `Success: Account ${accountId} successfully authorized via Device Code Flow.` }]
          };
        } else {
          // Zoho out-of-band ingestion
          if (!clientId) {
            return {
              content: [{ type: 'text', text: `Error: clientId is required for Zoho token ingestion.` }],
              isError: true
            };
          }
          TokenStorage.saveAccount({
            accountId,
            provider: 'zoho',
            tokens: {
              clientId,
              clientSecret,
              accessToken,
              refreshToken,
              expiryDate: Date.now() + 3600 * 1000
            }
          });
          return {
            content: [{ type: 'text', text: `Success: Zoho account ${accountId} saved.` }]
          };
        }
      }

      // Route all other tools based on accountId
      const accountId = (args as any).accountId;
      if (!accountId) {
        throw new Error('Missing parameter: accountId');
      }

      if (name.startsWith('email_')) {
        const provider = await AccountProviderRegistry.getEmailProvider(accountId);
        
        switch (name) {
          case 'email_list_emails':
            const { folder, limit, query } = args as any;
            const emails = await provider.listEmails(folder, limit, query);
            return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
          
          case 'email_get_email':
            const { messageId } = args as any;
            const email = await provider.getEmail(messageId);
            return { content: [{ type: 'text', text: JSON.stringify(email, null, 2) }] };

          case 'email_send_email':
            const { to, subject, body, cc, bcc } = args as any;
            const sent = await provider.sendEmail(to, subject, body, cc, bcc);
            return { content: [{ type: 'text', text: `Email sent successfully. Message ID: ${sent.id}` }] };

          case 'email_manage_email':
            const { messageId: mId, action } = args as any;
            await provider.manageEmail(mId, action);
            return { content: [{ type: 'text', text: `Successfully applied '${action}' action to message ${mId}.` }] };

          case 'email_delete_email':
            const { messageId: delId } = args as any;
            await provider.deleteEmail(delId);
            return { content: [{ type: 'text', text: `Successfully deleted message ${delId}.` }] };

          default:
            throw new Error(`Unhandled tool name: ${name}`);
        }
      }

      if (name.startsWith('calendar_')) {
        const provider = await AccountProviderRegistry.getCalendarProvider(accountId);

        switch (name) {
          case 'calendar_list_events':
            const { startTime, endTime } = args as any;
            const events = await provider.listEvents(startTime, endTime);
            return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };

          case 'calendar_create_event':
            const { title, startTime: sTime, endTime: eTime, description, attendees } = args as any;
            const event = await provider.createEvent(title, sTime, eTime, description, attendees);
            return { content: [{ type: 'text', text: `Event created successfully. Event ID: ${event.id}` }] };

          case 'calendar_update_event':
            const { eventId, patches } = args as any;
            const updated = await provider.updateEvent(eventId, patches);
            return { content: [{ type: 'text', text: `Event updated successfully: ${JSON.stringify(updated, null, 2)}` }] };

          case 'calendar_delete_event':
            const { eventId: delEvtId } = args as any;
            await provider.deleteEvent(delEvtId);
            return { content: [{ type: 'text', text: `Successfully deleted event ${delEvtId}.` }] };

          default:
            throw new Error(`Unhandled tool name: ${name}`);
        }
      }

      if (name.startsWith('contacts_')) {
        const provider = await AccountProviderRegistry.getContactsProvider(accountId);

        switch (name) {
          case 'contacts_search_contacts':
            const { query } = args as any;
            const contacts = await provider.searchContacts(query);
            return { content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }] };

          case 'contacts_create_contact':
            const { name: cName, email: cEmail, phone: cPhone } = args as any;
            const contact = await provider.createContact(cName, cEmail, cPhone);
            return { content: [{ type: 'text', text: `Contact created successfully: ${JSON.stringify(contact, null, 2)}` }] };

          case 'contacts_delete_contact':
            const { contactId } = args as any;
            await provider.deleteContact(contactId);
            return { content: [{ type: 'text', text: `Successfully deleted contact ${contactId}.` }] };

          default:
            throw new Error(`Unhandled tool name: ${name}`);
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  });

  return server;
}
