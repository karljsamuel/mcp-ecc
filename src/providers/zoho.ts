import axios from 'axios';
import {
  IEmailProvider,
  ICalendarProvider,
  IContactsProvider,
  EmailMessage,
  CalendarEvent,
  ContactInfo
} from './types.js';
import { AccountCredentials } from '../storage.js';
import { HeadlessAuthManager } from '../auth.js';

export class ZohoProvider implements IEmailProvider, ICalendarProvider, IContactsProvider {
  private zohoMailAccountId: string | null = null;

  constructor(private account: AccountCredentials) {}

  private async getHeaders() {
    const expiry = this.account.tokens.expiryDate || 0;
    let token = this.account.tokens.accessToken;
    
    if (Date.now() + 60000 >= expiry) {
      token = await HeadlessAuthManager.refreshAccessToken(this.account);
    }
    
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  private async getZohoMailAccountId(headers: any): Promise<string> {
    if (this.zohoMailAccountId) return this.zohoMailAccountId;
    try {
      const res = await axios.get('https://mail.zoho.com/api/v1/accounts', { headers });
      const accounts = res.data?.data || [];
      if (accounts.length > 0) {
        this.zohoMailAccountId = accounts[0].accountId;
        return this.zohoMailAccountId!;
      }
      throw new Error('No Zoho Mail accounts found for this authorization.');
    } catch (error: any) {
      throw new Error(`Failed to resolve Zoho account ID: ${error.message}`);
    }
  }

  // --- IEmailProvider ---
  async listEmails(folder = 'inbox', limit = 10, query?: string): Promise<EmailMessage[]> {
    const headers = await this.getHeaders();
    const zuid = await this.getZohoMailAccountId(headers);
    
    const params: any = {
      limit
    };
    if (query) {
      params.searchKey = query;
    }

    // Map common folders to Zoho folder names if necessary
    // Zoho folder lookup can be dynamic, but default is INBOX, SENT, etc.
    const url = `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/view`;
    const res = await axios.get(url, { headers, params });
    const items = res.data?.data || [];

    return items.map((item: any) => ({
      id: item.messageId,
      from: item.sender || '',
      to: item.toAddress ? [item.toAddress] : [],
      subject: item.subject || '',
      snippet: item.summary || '',
      body: item.summary || '',
      date: new Date(Number(item.receivedTime)).toISOString(),
      unread: item.status === '0', // 0 = unread
      starred: item.flagged === 'true',
      labelsOrFolders: item.folderName ? [item.folderName] : []
    }));
  }

  async getEmail(messageId: string): Promise<EmailMessage> {
    const headers = await this.getHeaders();
    const zuid = await this.getZohoMailAccountId(headers);
    const url = `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}/content`;
    const res = await axios.get(url, { headers });
    const item = res.data?.data || {};

    return {
      id: messageId,
      from: item.sender || '',
      to: item.toAddress ? [item.toAddress] : [],
      subject: item.subject || '',
      snippet: item.summary || '',
      body: item.content || '',
      htmlBody: item.content,
      date: new Date(Number(item.receivedTime)).toISOString(),
      unread: item.status === '0',
      starred: item.flagged === 'true',
      labelsOrFolders: []
    };
  }

  async sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[]): Promise<EmailMessage> {
    const headers = await this.getHeaders();
    const zuid = await this.getZohoMailAccountId(headers);
    const url = `https://mail.zoho.com/api/v1/accounts/${zuid}/messages`;

    const requestBody = {
      toAddress: to.join(','),
      ccAddress: cc?.join(','),
      bccAddress: bcc?.join(','),
      subject,
      content: body,
      mailFormat: 'plaintext'
    };

    await axios.post(url, requestBody, { headers });

    return {
      id: 'sent_via_zoho',
      from: 'me',
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
    const headers = await this.getHeaders();
    const zuid = await this.getZohoMailAccountId(headers);
    const url = `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}`;

    if (action === 'read' || action === 'unread') {
      const status = action === 'read' ? '1' : '0';
      await axios.put(url, { status }, { headers });
    } else if (action === 'star') {
      await axios.put(url, { flagged: 'true' }, { headers });
    } else if (action === 'archive') {
      // Archive usually means moving to Archive folder
      await axios.put(url, { folderId: 'archive' }, { headers });
    }
  }

  async deleteEmail(messageId: string): Promise<void> {
    const headers = await this.getHeaders();
    const zuid = await this.getZohoMailAccountId(headers);
    const url = `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}`;
    await axios.delete(url, { headers });
  }

  // --- ICalendarProvider (Zoho Calendar API is distinct, stubbing or returning empty) ---
  async listEvents(): Promise<CalendarEvent[]> {
    console.warn('Zoho Calendar API is not implemented in this server.');
    return [];
  }

  async createEvent(): Promise<CalendarEvent> {
    throw new Error('Zoho Calendar API is not implemented.');
  }

  async updateEvent(): Promise<CalendarEvent> {
    throw new Error('Zoho Calendar API is not implemented.');
  }

  async deleteEvent(): Promise<void> {
    throw new Error('Zoho Calendar API is not implemented.');
  }

  // --- IContactsProvider (Zoho Contacts API is distinct, stubbing or returning empty) ---
  async searchContacts(): Promise<ContactInfo[]> {
    console.warn('Zoho Contacts API is not implemented in this server.');
    return [];
  }

  async createContact(): Promise<ContactInfo> {
    throw new Error('Zoho Contacts API is not implemented.');
  }

  async deleteContact(): Promise<void> {
    throw new Error('Zoho Contacts API is not implemented.');
  }
}
