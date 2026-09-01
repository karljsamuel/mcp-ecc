import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type {
  AccountCredentials,
  IMailProvider,
  ICalendarProvider,
  IContactsProvider,
  EmailMessage,
  MailFolder,
  CalendarEvent,
  Calendar,
  Contact,
  EmailAddress,
  EmailAttachment,
  ListMessagesOptions,
  SearchOptions,
  SendMessageInput,
  ListEventsOptions,
  CreateEventInput,
  UpdateEventInput,
  ListContactsOptions,
  CreateContactInput,
  UpdateContactInput,
} from '@mcp-ecc/core';

export class ImapSmtpProvider implements IMailProvider, ICalendarProvider, IContactsProvider {
  private imapConfig: ConstructorParameters<typeof ImapFlow>[0];
  private smtpConfig: nodemailer.TransportOptions;

  constructor(private accountId: string, private credentials: AccountCredentials) {
    const config = credentials.config || {};

    this.imapConfig = {
      host: config.imapHost || 'imap.gmail.com',
      port: config.imapPort || 993,
      secure: config.imapTls !== false,
      auth: {
        user: accountId,
        pass: credentials.appPassword || '',
      },
      logger: false,
    };

    this.smtpConfig = {
      host: config.smtpHost || 'smtp.gmail.com',
      port: config.smtpPort || 465,
      secure: config.smtpSecure !== false,
      auth: {
        user: accountId,
        pass: credentials.appPassword || '',
      },
      tls: { rejectUnauthorized: false },
    } as nodemailer.TransportOptions;
  }

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow(this.imapConfig);
    await client.connect();
    return client;
  }

  // --- IMailProvider ---

  async listFolders(): Promise<MailFolder[]> {
    const client = await this.connect();
    try {
      const boxes = await client.list();
      return boxes.map(box => ({
        id: box.path,
        name: box.name || box.path,
        type: this.mapFolderType(box.name || box.path),
        unreadCount: 0,
        totalCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }));
    } finally {
      await client.logout();
    }
  }

  async listMessages(folderId: string, options: ListMessagesOptions = {}): Promise<EmailMessage[]> {
    const client = await this.connect();
    try {
      await client.mailboxOpen(folderId);

      const search: any = { all: true };
      if (options.query) {
        search.text = options.query;
      }
      if (options.unreadOnly) {
        search.seen = false;
      }

      const messages = await client.search(search, { uid: true });
      const list = messages || [];
      const sliced = list.slice(-(options.limit || 50)); // newest last, take tail

      const emailMessages: EmailMessage[] = [];
      for (const range of sliced) {
        try {
          const fetched = await client.fetchOne(range, { source: true, flags: true }, { uid: true });
          if (!fetched || !fetched.source) continue;
          const parsed = await simpleParser(fetched.source);
          emailMessages.push(this.mapParsedMessage(parsed, String(fetched.uid), folderId, fetched.flags));
        } catch (err) {
          console.error(`Failed to parse message ${range}:`, err);
        }
      }

      return emailMessages;
    } finally {
      await client.logout();
    }
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const client = await this.connect();
    try {
      await client.mailboxOpen('INBOX');
      const uid = messageId.includes(':') ? messageId.split(':').pop()! : messageId;
      const fetched = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message ${messageId} not found`);
      }
      const parsed = await simpleParser(fetched.source);
      return this.mapParsedMessage(parsed, String(fetched.uid), 'INBOX', fetched.flags);
    } finally {
      await client.logout();
    }
  }

  async sendMessage(message: SendMessageInput): Promise<EmailMessage> {
    const transporter = nodemailer.createTransport(this.smtpConfig);

    const mailOptions = {
      from: this.accountId,
      to: message.to.map(a => a.address).join(', '),
      cc: message.cc?.map(a => a.address).join(', '),
      bcc: message.bcc?.map(a => a.address).join(', '),
      subject: message.subject,
      text: message.body,
      html: message.htmlBody,
      inReplyTo: message.inReplyTo,
      references: message.references?.join(' '),
    };

    await transporter.sendMail(mailOptions);
    transporter.close();

    return {
      id: 'sent',
      from: { address: this.accountId },
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body: message.body,
      htmlBody: message.htmlBody,
      date: Date.now(),
      unread: false,
      starred: false,
      labelsOrFolders: ['SENT'],
    };
  }

  async searchMessages(query: string, options: SearchOptions = {}): Promise<EmailMessage[]> {
    return this.listMessages('INBOX', { ...options, query });
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    const client = await this.connect();
    try {
      await client.mailboxOpen('INBOX');
      await client.messageMove(messageId, folderId, { uid: true });
    } finally {
      await client.logout();
    }
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    const client = await this.connect();
    try {
      await client.mailboxOpen('INBOX');
      const toAdd: string[] = [];
      const toRemove: string[] = [];

      if (addFlags.includes('\\Seen')) toAdd.push('\\Seen');
      if (addFlags.includes('\\Flagged')) toAdd.push('\\Flagged');
      if (addFlags.includes('\\Deleted')) toAdd.push('\\Deleted');

      if (removeFlags.includes('\\Seen')) toRemove.push('\\Seen');
      if (removeFlags.includes('\\Flagged')) toRemove.push('\\Flagged');
      if (removeFlags.includes('\\Deleted')) toRemove.push('\\Deleted');

      if (toAdd.length) await client.messageFlagsAdd(messageId, toAdd, { uid: true });
      if (toRemove.length) await client.messageFlagsRemove(messageId, toRemove, { uid: true });
    } finally {
      await client.logout();
    }
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    const client = await this.connect();
    try {
      await client.mailboxOpen('INBOX');
      if (permanent) {
        await client.messageDelete(messageId, { uid: true });
      } else {
        await client.messageMove(messageId, 'Trash', { uid: true });
      }
    } finally {
      await client.logout();
    }
  }

  // --- ICalendarProvider (Unsupported) ---

  async listCalendars(): Promise<Calendar[]> {
    return [];
  }

  async listEvents(): Promise<CalendarEvent[]> {
    return [];
  }

  async getEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async createEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async updateEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async deleteEvent(): Promise<void> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async freeBusy(): Promise<Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }>> {
    return [];
  }

  // --- IContactsProvider (Unsupported) ---

  async listContacts(): Promise<Contact[]> {
    return [];
  }

  async getContact(): Promise<Contact> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async createContact(): Promise<Contact> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async updateContact(): Promise<Contact> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async deleteContact(): Promise<void> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async searchContacts(): Promise<Contact[]> {
    return [];
  }

  // --- Helpers ---

  private mapParsedMessage(parsed: any, id: string, folderId: string, flags: any = []): EmailMessage {
    // imapflow returns flags as a Set — normalise to an array.
    const flagList = Array.isArray(flags) ? flags : Array.from(flags || []);
    return {
      id,
      threadId: parsed.references ? parsed.references[0] : undefined,
      from: parsed.from ? { name: parsed.from.text, address: parsed.from.value[0]?.address } : { address: '' },
      to: Array.isArray(parsed.to) ? parsed.to.map((t: any) => ({ name: t.name, address: t.address })) : parsed.to ? [{ name: parsed.to.name, address: parsed.to.address }] : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((t: any) => ({ name: t.name, address: t.address })) : parsed.cc ? [{ name: parsed.cc.name, address: parsed.cc.address }] : [],
      bcc: [],
      subject: parsed.subject || '',
      snippet: (parsed.text || '').substring(0, 200),
      body: parsed.text || '',
      htmlBody: parsed.html || undefined,
      date: new Date(parsed.date || Date.now()).getTime(),
      unread: !flagList.includes('\\Seen'),
      starred: flagList.includes('\\Flagged') || false,
      labelsOrFolders: [folderId],
      attachments: parsed.attachments?.map((a: any) => ({
        filename: a.filename || 'attachment',
        mimeType: a.contentType,
        size: a.size,
        contentId: a.contentId,
      })),
    };
  }

  private mapFolderType(name: string): MailFolder['type'] {
    const lower = name.toLowerCase();
    if (lower.includes('inbox')) return 'inbox';
    if (lower.includes('sent')) return 'sent';
    if (lower.includes('draft')) return 'drafts';
    if (lower.includes('trash') || lower.includes('deleted')) return 'trash';
    if (lower.includes('spam') || lower.includes('junk')) return 'spam';
    if (lower.includes('archive')) return 'archive';
    return 'custom';
  }
}