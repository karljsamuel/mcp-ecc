import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import {
  IEmailProvider,
  ICalendarProvider,
  IContactsProvider,
  EmailMessage,
  CalendarEvent,
  ContactInfo
} from './types.js';
import { AccountCredentials } from '../storage.js';

export class ImapSmtpProvider implements IEmailProvider, ICalendarProvider, IContactsProvider {
  private imapConfig: any;
  private smtpConfig: any;

  constructor(private account: AccountCredentials) {
    const config = account.tokens.config || {};
    
    this.imapConfig = {
      imap: {
        user: account.accountId,
        password: account.tokens.appPassword || '',
        host: config.imapHost || 'imap.gmail.com',
        port: config.imapPort || 993,
        tls: config.imapTls !== false,
        authTimeout: 5000
      }
    };

    this.smtpConfig = {
      host: config.smtpHost || 'smtp.gmail.com',
      port: config.smtpPort || 465,
      secure: config.smtpSecure !== false,
      auth: {
        user: account.accountId,
        pass: account.tokens.appPassword || ''
      }
    };
  }

  // --- IEmailProvider ---
  async listEmails(folder = 'INBOX', limit = 10, query?: string): Promise<EmailMessage[]> {
    const connection = await imaps.connect(this.imapConfig);
    try {
      await connection.openBox(folder);
      
      let searchCriteria: any[] = ['ALL'];
      if (query) {
        searchCriteria = [['TEXT', query]];
      }

      const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        struct: true
      };

      const messages = await connection.search(searchCriteria, fetchOptions);
      // Sort messages descending by UID to get the most recent ones first
      messages.sort((a, b) => b.attributes.uid - a.attributes.uid);
      const sliced = messages.slice(0, limit);

      const emailMessages: EmailMessage[] = [];

      for (const msg of sliced) {
        const allPart = msg.parts.find(p => p.which === '');
        const id = String(msg.attributes.uid);
        
        if (allPart && allPart.body) {
          const parsed = await simpleParser(allPart.body);
          
          emailMessages.push({
            id,
            from: parsed.from?.text || '',
            to: Array.isArray(parsed.to) ? parsed.to.map(t => t.text) : parsed.to ? [parsed.to.text] : [],
            cc: Array.isArray(parsed.cc) ? parsed.cc.map(t => t.text) : parsed.cc ? [parsed.cc.text] : [],
            bcc: Array.isArray(parsed.bcc) ? parsed.bcc.map(t => t.text) : parsed.bcc ? [parsed.bcc.text] : [],
            subject: parsed.subject || '',
            snippet: parsed.text ? parsed.text.substring(0, 100) : '',
            body: parsed.text || '',
            htmlBody: typeof parsed.html === 'string' ? parsed.html : undefined,
            date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            unread: !msg.attributes.flags.includes('\\Seen'),
            starred: msg.attributes.flags.includes('\\Flagged'),
            labelsOrFolders: [folder]
          });
        }
      }
      return emailMessages;
    } finally {
      connection.end();
    }
  }

  async getEmail(messageId: string): Promise<EmailMessage> {
    const connection = await imaps.connect(this.imapConfig);
    try {
      await connection.openBox('INBOX');
      const messages = await connection.search([[ 'UID', messageId ]], {
        bodies: [''],
        struct: true
      });

      if (messages.length === 0) {
        throw new Error(`Email with UID ${messageId} not found.`);
      }

      const allPart = messages[0].parts.find(p => p.which === '');
      if (!allPart || !allPart.body) {
        throw new Error(`Could not parse body for email UID ${messageId}`);
      }

      const parsed = await simpleParser(allPart.body);

      return {
        id: messageId,
        from: parsed.from?.text || '',
        to: Array.isArray(parsed.to) ? parsed.to.map(t => t.text) : parsed.to ? [parsed.to.text] : [],
        cc: Array.isArray(parsed.cc) ? parsed.cc.map(t => t.text) : parsed.cc ? [parsed.cc.text] : [],
        bcc: Array.isArray(parsed.bcc) ? parsed.bcc.map(t => t.text) : parsed.bcc ? [parsed.bcc.text] : [],
        subject: parsed.subject || '',
        snippet: parsed.text ? parsed.text.substring(0, 100) : '',
        body: parsed.text || '',
        htmlBody: typeof parsed.html === 'string' ? parsed.html : undefined,
        date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
        unread: !messages[0].attributes.flags.includes('\\Seen'),
        starred: messages[0].attributes.flags.includes('\\Flagged'),
        labelsOrFolders: ['INBOX']
      };
    } finally {
      connection.end();
    }
  }

  async sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[]): Promise<EmailMessage> {
    const transporter = nodemailer.createTransport(this.smtpConfig);
    
    const info = await transporter.sendMail({
      from: this.account.accountId,
      to: to.join(', '),
      cc: cc?.join(', '),
      bcc: bcc?.join(', '),
      subject,
      text: body
    });

    return {
      id: info.messageId,
      from: this.account.accountId,
      to,
      cc,
      bcc,
      subject,
      date: new Date().toISOString(),
      unread: false,
      starred: false,
      labelsOrFolders: []
    };
  }

  async manageEmail(messageId: string, action: 'archive' | 'read' | 'unread' | 'star'): Promise<void> {
    const connection = await imaps.connect(this.imapConfig);
    try {
      await connection.openBox('INBOX');
      const uid = parseInt(messageId, 10);
      
      if (action === 'read') {
        await connection.addFlags(uid, '\\Seen');
      } else if (action === 'unread') {
        await connection.delFlags(uid, '\\Seen');
      } else if (action === 'star') {
        await connection.addFlags(uid, '\\Flagged');
      } else if (action === 'archive') {
        // IMAP archive typically moves to a different folder
        const config = this.account.tokens.config || {};
        const archiveBox = config.archiveFolder || 'Archive';
        await connection.moveMessage(messageId, archiveBox);
      }
    } finally {
      connection.end();
    }
  }

  async deleteEmail(messageId: string): Promise<void> {
    const connection = await imaps.connect(this.imapConfig);
    try {
      await connection.openBox('INBOX');
      const uid = parseInt(messageId, 10);
      const config = this.account.tokens.config || {};
      const trashBox = config.trashFolder || 'Trash';
      try {
        await connection.moveMessage(messageId, trashBox);
      } catch {
        // If move fails, delete permanently
        await connection.addFlags(uid, '\\Deleted');
        await connection.deleteMessage(uid);
      }
    } finally {
      connection.end();
    }
  }

  // --- ICalendarProvider (Unsupported for IMAP/SMTP) ---
  async listEvents(): Promise<CalendarEvent[]> {
    return [];
  }
  async createEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar features are not supported by the IMAP/SMTP provider.');
  }
  async updateEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar features are not supported by the IMAP/SMTP provider.');
  }
  async deleteEvent(): Promise<void> {
    throw new Error('Calendar features are not supported by the IMAP/SMTP provider.');
  }

  // --- IContactsProvider (Unsupported for IMAP/SMTP) ---
  async searchContacts(): Promise<ContactInfo[]> {
    return [];
  }
  async createContact(): Promise<ContactInfo> {
    throw new Error('Contacts features are not supported by the IMAP/SMTP provider.');
  }
  async deleteContact(): Promise<void> {
    throw new Error('Contacts features are not supported by the IMAP/SMTP provider.');
  }
}
