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

export class ZohoProvider implements IMailProvider, ICalendarProvider, IContactsProvider {
  private mailAccountId: string | null = null;
  private accountsServer: string;

  constructor(private accountId: string, private credentials: AccountCredentials) {
    this.accountsServer = credentials.config?.accountsServer || 'accounts.zoho.com';
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const expiry = this.credentials.expiryDate || 0;
    let token = this.credentials.accessToken;
    
    if (Date.now() + 60000 >= expiry && this.credentials.refreshToken) {
      // Token refresh would be handled by OAuthManager
      // This is a placeholder
    }
    
    return {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async fetchZoho<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: { ...await this.getHeaders(), ...options.headers },
    });

    if (!response.ok) {
      const error: any = await response.json().catch(() => ({}));
      throw new Error(`Zoho API error: ${response.status} - ${error.message || response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private async getZohoMailAccountId(): Promise<string> {
    if (this.mailAccountId) return this.mailAccountId;
    
    const res = await this.fetchZoho<{ data: Array<{ accountId: string }> }>(
      `https://mail.zoho.com/api/v1/accounts`
    );
    
    if (res.data?.length > 0) {
      this.mailAccountId = res.data[0].accountId;
      return this.mailAccountId;
    }
    
    throw new Error('No Zoho Mail accounts found for this authorization');
  }

  // --- IMailProvider ---

  async listFolders(): Promise<MailFolder[]> {
    const zuid = await this.getZohoMailAccountId();
    const res = await this.fetchZoho<{ data: any[] }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/folders`
    );
    
    return (res.data || []).map(f => ({
      id: f.folderId,
      name: f.folderName,
      parentId: f.parentFolderId,
      type: this.mapFolderType(f.folderName),
      unreadCount: f.unreadCount || 0,
      totalCount: f.messageCount || 0,
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  async listMessages(folderId: string, options: ListMessagesOptions = {}): Promise<EmailMessage[]> {
    const zuid = await this.getZohoMailAccountId();
    const params = new URLSearchParams();
    params.set('limit', String(options.limit || 50));
    
    if (options.query) {
      params.set('searchKey', options.query);
    }

    const res = await this.fetchZoho<{ data: any[] }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/view?${params}`
    );
    
    return (res.data || []).map(item => this.mapMessage(item));
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const zuid = await this.getZohoMailAccountId();
    const res = await this.fetchZoho<{ data: any }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}/content`
    );
    
    const item = res.data;
    return {
      id: messageId,
      from: { address: item.sender || '' },
      to: item.toAddress ? [{ address: item.toAddress }] : [],
      subject: item.subject || '',
      snippet: item.summary || '',
      body: item.content || '',
      htmlBody: item.content,
      date: new Date(Number(item.receivedTime)).getTime(),
      unread: item.status === '0',
      starred: item.flagged === 'true',
      labelsOrFolders: [],
    };
  }

  async sendMessage(message: SendMessageInput): Promise<EmailMessage> {
    const zuid = await this.getZohoMailAccountId();
    
    await this.fetchZoho(`https://mail.zoho.com/api/v1/accounts/${zuid}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        toAddress: message.to.map(a => a.address).join(','),
        ccAddress: message.cc?.map(a => a.address).join(','),
        bccAddress: message.bcc?.map(a => a.address).join(','),
        subject: message.subject,
        content: message.body,
        mailFormat: 'plaintext',
      }),
    });

    return {
      id: 'sent',
      from: { address: (this.credentials.config?.email as string) || '' },
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body: message.body,
      date: Date.now(),
      unread: false,
      starred: false,
      labelsOrFolders: ['SENT'],
    };
  }

  async searchMessages(query: string, options: SearchOptions = {}): Promise<EmailMessage[]> {
    return this.listMessages('inbox', { ...options, query });
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    const zuid = await this.getZohoMailAccountId();
    // Zoho uses folder operations - this would need specific implementation
    await this.fetchZoho(`https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}/move`, {
      method: 'POST',
      body: JSON.stringify({ folderId }),
    });
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    const zuid = await this.getZohoMailAccountId();
    
    if (addFlags.includes('\\Seen') || removeFlags.includes('\\Seen')) {
      const status = addFlags.includes('\\Seen') ? '1' : '0';
      await this.fetchZoho(`https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
    }
    if (addFlags.includes('\\Flagged')) {
      await this.fetchZoho(`https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}`, {
        method: 'PUT',
        body: JSON.stringify({ flagged: 'true' }),
      });
    }
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    const zuid = await this.getZohoMailAccountId();
    await this.fetchZoho(`https://mail.zoho.com/api/v1/accounts/${zuid}/messages/${messageId}`, {
      method: 'DELETE',
    });
  }

  // --- ICalendarProvider ---

  async listCalendars(): Promise<Calendar[]> {
    const res = await this.fetchZoho<{ data: any[] }>(
      `https://calendar.zoho.com/api/v1/calendars`
    );
    
    return (res.data || []).map(cal => ({
      id: cal.calendarId,
      name: cal.calendarName,
      description: cal.description,
      color: cal.color,
      primary: cal.isPrimary === true,
      accessRole: cal.permission as Calendar['accessRole'],
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  async listEvents(calendarId: string, options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    const params = new URLSearchParams();
    if (options.timeMin) params.set('startTime', new Date(options.timeMin).toISOString());
    if (options.timeMax) params.set('endTime', new Date(options.timeMax).toISOString());
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this.fetchZoho<{ data: any[] }>(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events?${params}`
    );
    
    return (res.data || []).map(evt => this.mapEvent(evt));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const res = await this.fetchZoho<{ data: any }>(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events/${eventId}`
    );
    return this.mapEvent(res.data);
  }

  async createEvent(calendarId: string, event: CreateEventInput): Promise<CalendarEvent> {
    const res = await this.fetchZoho<{ data: any }>(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: event.summary,
          description: event.description,
          location: event.location,
          startTime: new Date(event.startAt).toISOString(),
          endTime: new Date(event.endAt).toISOString(),
          allDay: event.allDay,
          attendees: event.attendees?.map(a => a.address),
        }),
      }
    );
    return this.mapEvent(res.data);
  }

  async updateEvent(calendarId: string, eventId: string, patches: UpdateEventInput): Promise<CalendarEvent> {
    const res = await this.fetchZoho<{ data: any }>(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events/${eventId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          title: patches.summary,
          description: patches.description,
          location: patches.location,
          startTime: patches.startAt ? new Date(patches.startAt).toISOString() : undefined,
          endTime: patches.endAt ? new Date(patches.endAt).toISOString() : undefined,
          allDay: patches.allDay,
        }),
      }
    );
    return this.mapEvent(res.data);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.fetchZoho(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events/${eventId}`,
      { method: 'DELETE' }
    );
  }

  async freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }>> {
    // Zoho free/busy API would be implemented here
    return calendarIds.map(id => ({ calendarId: id, busy: [] }));
  }

  // --- IContactsProvider ---

  async listContacts(options: ListContactsOptions = {}): Promise<Contact[]> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this.fetchZoho<{ data: any[] }>(
      `https://contacts.zoho.com/api/v1/contacts?${params}`
    );
    
    return (res.data || []).map(c => this.mapContact(c));
  }

  async getContact(contactId: string): Promise<Contact> {
    const res = await this.fetchZoho<{ data: any }>(
      `https://contacts.zoho.com/api/v1/contacts/${contactId}`
    );
    return this.mapContact(res.data);
  }

  async createContact(contact: CreateContactInput): Promise<Contact> {
    const res = await this.fetchZoho<{ data: any }>(
      `https://contacts.zoho.com/api/v1/contacts`,
      {
        method: 'POST',
        body: JSON.stringify({
          firstName: contact.displayName,
          email: contact.emails.map(e => e.email).join(','),
          phone: contact.phones?.map(p => p.number).join(','),
          company: contact.organization,
          jobTitle: contact.jobTitle,
          notes: contact.notes,
        }),
      }
    );
    return this.mapContact(res.data);
  }

  async updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact> {
    const res = await this.fetchZoho<{ data: any }>(
      `https://contacts.zoho.com/api/v1/contacts/${contactId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          firstName: patches.displayName,
          email: patches.emails?.map(e => e.email).join(','),
          phone: patches.phones?.map(p => p.number).join(','),
          company: patches.organization,
          jobTitle: patches.jobTitle,
          notes: patches.notes,
        }),
      }
    );
    return this.mapContact(res.data);
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.fetchZoho(
      `https://contacts.zoho.com/api/v1/contacts/${contactId}`,
      { method: 'DELETE' }
    );
  }

  async searchContacts(query: string, options: SearchOptions = {}): Promise<Contact[]> {
    const params = new URLSearchParams();
    params.set('searchKey', query);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this.fetchZoho<{ data: any[] }>(
      `https://contacts.zoho.com/api/v1/contacts?${params}`
    );
    return (res.data || []).map(c => this.mapContact(c));
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

  private mapMessage(item: any): EmailMessage {
    return {
      id: item.messageId,
      from: { address: item.sender || '' },
      to: item.toAddress ? [{ address: item.toAddress }] : [],
      subject: item.subject || '',
      snippet: item.summary || '',
      body: item.content || item.summary || '',
      date: new Date(Number(item.receivedTime)).getTime(),
      unread: item.status === '0',
      starred: item.flagged === 'true',
      labelsOrFolders: [],
    };
  }

  private mapEvent(evt: any): CalendarEvent {
    return {
      id: evt.eventId,
      calendarId: evt.calendarId,
      summary: evt.title || 'No Title',
      description: evt.description,
      location: evt.location,
      startAt: new Date(evt.startTime).getTime(),
      endAt: new Date(evt.endTime).getTime(),
      allDay: evt.allDay === true,
      status: evt.status as CalendarEvent['status'],
      attendees: evt.attendees?.map((a: string) => ({ address: a })) || [],
      raw: evt,
    };
  }

  private mapContact(c: any): Contact {
    return {
      id: c.contactId,
      displayName: c.firstName + (c.lastName ? ` ${c.lastName}` : ''),
      emails: c.email ? c.email.split(',').map((e: string) => ({ email: e.trim(), type: 'work' })) : [],
      phones: c.phone ? c.phone.split(',').map((p: string) => ({ number: p.trim(), type: 'mobile' })) : [],
      organization: c.company,
      jobTitle: c.jobTitle,
      notes: c.notes,
      raw: c,
    };
  }
}