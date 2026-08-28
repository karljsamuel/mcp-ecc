import imaps from 'imap-simple';
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
  private imapConfig: imaps.ImapSimpleOptions;
  private smtpConfig: nodemailer.TransportOptions;

  constructor(private accountId: string, private credentials: AccountCredentials) {
    const config = credentials.config || {};

    this.imapConfig = {
      imap: {
        user: accountId,
        password: credentials.appPassword || '',
        host: config.imapHost || 'imap.gmail.com',
        port: config.imapPort || 993,
        tls: config.imapTls !== false,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
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

  private async connect(): Promise<imaps.ImapSimple> {
    return imaps.connect(this.imapConfig);
  }

  // --- IMailProvider ---

  async listFolders(): Promise<MailFolder[]> {
    const connection = await this.connect();
    try {
      const boxes = await connection.getBoxes();
      return Object.entries(boxes).map(([name, box]) => ({
        id: name,
        name,
        type: this.mapFolderType(name),
        unreadCount: (box as any).unseen || 0,
        totalCount: (box as any).messages?.total || 0,
        createdAt: 0,
        updatedAt: 0,
      }));
    } finally {
      connection.end();
    }
  }

  async listMessages(folderId: string, options: ListMessagesOptions = {}): Promise<EmailMessage[]> {
    const connection = await this.connect();
    try {
      await connection.openBox(folderId);

      let searchCriteria: any[] = ['ALL'];
      if (options.query) {
        searchCriteria = [['TEXT', options.query]];
      }

      const fetchOptions = {
        bodies: ['HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)', 'TEXT', ''],
        struct: true,
      };

      const messages = await connection.search(searchCriteria, fetchOptions);
      messages.sort((a, b) => b.attributes.uid - a.attributes.uid);
      const sliced = messages.slice(0, options.limit || 50);

      const emailMessages: EmailMessage[] = [];

      for (const msg of sliced) {
        const headerPart = msg.parts.find(p => p.which === 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)');
        const textPart = msg.parts.find(p => p.which === 'TEXT');
        const fullPart = msg.parts.find(p => p.which === '');
        const uid = String(msg.attributes.uid);

        if (headerPart) {
          const parsed: any = await simpleParser(headerPart.body);
          
          emailMessages.push({
            id: uid,
            threadId: parsed.references ? parsed.references[0] : undefined,
            from: parsed.from ? { name: parsed.from.text, address: parsed.from.value[0]?.address } : { address: '' },
            to: Array.isArray(parsed.to) ? parsed.to.map((t: any) => ({ name: t.name, address: t.address })) : parsed.to ? [{ name: parsed.to.name, address: parsed.to.address }] : [],
            cc: Array.isArray(parsed.cc) ? parsed.cc.map((t: any) => ({ name: t.name, address: t.address })) : parsed.cc ? [{ name: (parsed.cc as any).name, address: (parsed.cc as any).address }] : [],
            bcc: [],
            subject: parsed.subject || '',
            snippet: textPart?.body?.substring(0, 200) || '',
            body: textPart?.body || '',
            htmlBody: fullPart?.body || undefined,
            date: new Date(parsed.date || Date.now()).getTime(),
            unread: !msg.attributes.flags?.includes('\\Seen'),
            starred: msg.attributes.flags?.includes('\\Flagged') || false,
            labelsOrFolders: [folderId],
            attachments: parsed.attachments?.map((a: any) => ({
              filename: a.filename || 'attachment',
              mimeType: a.contentType,
              size: a.size,
              contentId: a.contentId,
            })),
          });
        }
      }

      return emailMessages;
    } finally {
      connection.end();
    }
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const connection = await this.connect();
    try {
      await connection.openBox('INBOX'); // Would need to know folder
      const fetchOptions = { bodies: [''], struct: true };
      const messages = await connection.search([['UID', messageId]], fetchOptions);
      
      if (messages.length === 0) {
        throw new Error(`Message ${messageId} not found`);
      }

      const msg = messages[0];
      const fullPart = msg.parts.find(p => p.which === '');
      const parsed: any = fullPart ? await simpleParser(fullPart.body) : { subject: '', from: null, to: [], cc: [], date: new Date() };

      return {
        id: messageId,
        from: parsed.from ? { name: parsed.from.text, address: parsed.from.value[0]?.address } : { address: '' },
        to: Array.isArray(parsed.to) ? parsed.to.map((t: any) => ({ name: t.name, address: t.address })) : parsed.to ? [{ name: parsed.to.name, address: parsed.to.address }] : [],
        cc: Array.isArray(parsed.cc) ? parsed.cc.map((t: any) => ({ name: t.name, address: t.address })) : parsed.cc ? [{ name: (parsed.cc as any).name, address: (parsed.cc as any).address }] : [],
        subject: parsed.subject || '',
        body: parsed.text || '',
        htmlBody: parsed.html || undefined,
        date: new Date(parsed.date || Date.now()).getTime(),
        unread: !msg.attributes.flags?.includes('\\Seen'),
        starred: msg.attributes.flags?.includes('\\Flagged') || false,
        labelsOrFolders: ['INBOX'],
        attachments: parsed.attachments?.map((a: any) => ({
          filename: a.filename || 'attachment',
          mimeType: a.contentType,
          size: a.size,
          contentId: a.contentId,
        })),
      };
    } finally {
      connection.end();
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
    const connection = await this.connect();
    try {
      await connection.openBox('INBOX');
      await connection.moveMessage(messageId, folderId);
    } finally {
      connection.end();
    }
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    const connection = await this.connect();
    try {
      await connection.openBox('INBOX');
      
      if (addFlags.includes('\\Seen') || removeFlags.includes('\\Seen')) {
        if (addFlags.includes('\\Seen')) await (connection as any).addFlags(messageId, '\\Seen');
        if (removeFlags.includes('\\Seen')) await (connection as any).removeFlags(messageId, '\\Seen');
      }
      if (addFlags.includes('\\Flagged') || removeFlags.includes('\\Flagged')) {
        if (addFlags.includes('\\Flagged')) await (connection as any).addFlags(messageId, '\\Flagged');
        if (removeFlags.includes('\\Flagged')) await (connection as any).removeFlags(messageId, '\\Flagged');
      }
      if (addFlags.includes('\\Deleted') || removeFlags.includes('\\Deleted')) {
        if (addFlags.includes('\\Deleted')) await (connection as any).addFlags(messageId, '\\Deleted');
        if (removeFlags.includes('\\Deleted')) await (connection as any).removeFlags(messageId, '\\Deleted');
      }
    } finally {
      connection.end();
    }
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    const connection = await this.connect();
    try {
      await connection.openBox('INBOX');
      if (permanent) {
        await (connection as any).addFlags(messageId, '\\Deleted');
        await (connection as any).deleteMessage(messageId);
      } else {
        await connection.moveMessage(messageId, 'Trash');
      }
    } finally {
      connection.end();
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