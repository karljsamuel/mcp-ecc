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
      await this.refreshToken();
      token = this.credentials.accessToken;
    }

    return {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async refreshToken(): Promise<void> {
    const accountsServer = this.accountsServer;
    const response = await fetch(`https://${accountsServer}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.credentials.refreshToken || '',
        client_id: this.credentials.clientId || '',
        client_secret: this.credentials.clientSecret || '',
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data: any = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(`Zoho token refresh failed: ${data.error} - ${data.error_description || ''}`);
    }
    this.credentials.accessToken = data.access_token;
    if (data.refresh_token) this.credentials.refreshToken = data.refresh_token;
    this.credentials.expiryDate = Date.now() + (data.expires_in || 3600) * 1000;
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

    // Resolve folder name (e.g. "INBOX") to its Zoho folderId, otherwise the
    // view endpoint lists a different default folder.
    const folders = await this.fetchZoho<{ data: any[] }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/folders`
    );
    const folder = (folders.data || []).find(
      (f: any) => String(f.folderId) === String(folderId) || f.folderName?.toLowerCase() === String(folderId).toLowerCase()
    );
    if (folder?.folderId) {
      params.set('folderId', String(folder.folderId));
    }

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
    // Content endpoint requires the containing folderId and returns only
    // content — fetch metadata from the view list, then content separately.
    const folders = await this.fetchZoho<{ data: any[] }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/folders`
    );
    const inbox = (folders.data || []).find((f: any) => f.folderName?.toLowerCase() === 'inbox');
    const folderId = inbox?.folderId;
    if (!folderId) throw new Error('INBOX folder not found for Zoho account');

    const list = await this.fetchZoho<{ data: any[] }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/messages/view?folderId=${folderId}&limit=100`
    );
    const meta = (list.data || []).find((i: any) => String(i.messageId) === String(messageId));

    const contentRes = await this.fetchZoho<{ data: any }>(
      `https://mail.zoho.com/api/accounts/${zuid}/folders/${folderId}/messages/${messageId}/content`
    );
    
    const item = contentRes.data;
    return {
      id: messageId,
      from: { address: meta?.sender || '' },
      to: meta?.toAddress ? [{ address: meta.toAddress }] : [],
      subject: meta?.subject || '',
      snippet: meta?.summary || '',
      body: item.content || '',
      htmlBody: item.content,
      date: new Date(Number(meta?.receivedTime || Date.now())).getTime(),
      unread: meta?.status === '0',
      starred: meta?.flagged === 'true',
      labelsOrFolders: [],
    };
  }

  async sendMessage(message: SendMessageInput): Promise<EmailMessage> {
    const zuid = await this.getZohoMailAccountId();
    // From address must be the authenticated mailbox address (not an alias).
    const accounts = await this.fetchZoho<{ data: any[] }>('https://mail.zoho.com/api/v1/accounts');
    const fromAddress = accounts.data?.[0]?.mailboxAddress || accounts.data?.[0]?.emailAddress || this.accountId;

    const body: Record<string, any> = {
      fromAddress,
      toAddress: message.to.map(a => a.address).join(','),
      subject: message.subject,
      content: message.htmlBody || message.body,
      mailFormat: message.htmlBody ? 'html' : 'plaintext',
    };
    if (message.cc?.length) body.ccAddress = message.cc.map(a => a.address).join(',');
    if (message.bcc?.length) body.bccAddress = message.bcc.map(a => a.address).join(',');
    if (message.inReplyTo) body.inReplyTo = message.inReplyTo;

    await this.fetchZoho(`https://mail.zoho.com/api/accounts/${zuid}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      id: 'sent',
      from: { address: fromAddress },
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
    return this.listMessages('inbox', { ...options, query });
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    const zuid = await this.getZohoMailAccountId();
    await this.fetchZoho(`https://mail.zoho.com/api/accounts/${zuid}/updatemessage`, {
      method: 'PUT',
      body: JSON.stringify({ mode: 'moveMessage', messageId: [messageId], folderId }),
    });
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    const zuid = await this.getZohoMailAccountId();

    const wantsRead = addFlags.includes('\\Seen');
    const wantsUnread = removeFlags.includes('\\Seen');
    if (wantsRead || wantsUnread) {
      await this.fetchZoho(`https://mail.zoho.com/api/accounts/${zuid}/updatemessage`, {
        method: 'PUT',
        body: JSON.stringify({
          mode: wantsRead ? 'markAsRead' : 'markAsUnread',
          messageId: [messageId],
        }),
      });
    }
    if (addFlags.includes('\\Flagged')) {
      await this.fetchZoho(`https://mail.zoho.com/api/accounts/${zuid}/updatemessage`, {
        method: 'PUT',
        body: JSON.stringify({ mode: 'flagMessage', messageId: [messageId] }),
      });
    }
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    const zuid = await this.getZohoMailAccountId();
    // Zoho delete requires the containing folderId — resolve INBOX.
    const folders = await this.fetchZoho<{ data: any[] }>(
      `https://mail.zoho.com/api/v1/accounts/${zuid}/folders`
    );
    const inbox = (folders.data || []).find((f: any) => f.folderName?.toLowerCase() === 'inbox');
    const folderId = inbox?.folderId;
    if (!folderId) throw new Error('INBOX folder not found for Zoho account');
    await this.fetchZoho(
      `https://mail.zoho.com/api/accounts/${zuid}/folders/${folderId}/messages/${messageId}`,
      { method: 'DELETE' }
    );
  }

  // --- ICalendarProvider ---

  async listCalendars(): Promise<Calendar[]> {
    const res = await this.fetchZoho<{ calendars: any[] }>(
      `https://calendar.zoho.com/api/v1/calendars`
    );
    
    return (res.calendars || []).map(cal => ({
      // Events API requires the calendar UID (not the numeric id).
      id: cal.uid || cal.id || cal.calendarId,
      name: cal.name || cal.calendarName,
      description: cal.description,
      color: cal.color,
      primary: cal.isdefault === true || cal.isPrimary === true,
      accessRole: cal.privilege as Calendar['accessRole'],
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  private zohoEventTime(d: number): string {
    const s = new Date(d).toISOString();
    return s.slice(0,4) + s.slice(5,7) + s.slice(8,10) + 'T' + s.slice(11,13) + s.slice(14,16) + s.slice(17,19) + 'Z';
  }

  async listEvents(calendarId: string, options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    const params = new URLSearchParams();
    if (options.timeMin) params.set('startTime', new Date(options.timeMin).toISOString());
    if (options.timeMax) params.set('endTime', new Date(options.timeMax).toISOString());
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this.fetchZoho<{ events: any[] }>(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events?${params}`
    );
    
    return (res.events || []).map(evt => this.mapEvent(evt));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const res = await this.fetchZoho<{ events?: any[]; event?: any }>(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events/${eventId}`
    );
    return this.mapEvent((res.events && res.events[0]) || res.event || res);
  }

  async createEvent(calendarId: string, event: CreateEventInput): Promise<CalendarEvent> {
    // Zoho expects the event payload as an `eventdata` query param with a
    // compact date format (yyyyMMdd'T'HHmmss'Z').
    const eventdata = {
      title: event.summary,
      description: event.description,
      location: event.location,
      dateandtime: {
        timezone: 'Asia/Kolkata',
        start: this.zohoEventTime(event.startAt),
        end: this.zohoEventTime(event.endAt),
      },
      isallday: event.allDay === true,
      attendees: event.attendees?.map(a => ({ email: a.address, is_organizer: false })),
    };
    const url = `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events?eventdata=${encodeURIComponent(JSON.stringify(eventdata))}`;
    const res = await this.fetchZoho<{ events: any[] }>(url, { method: 'POST' });
    return this.mapEvent((res.events || [])[0] || res);
  }

  async updateEvent(calendarId: string, eventId: string, patches: UpdateEventInput): Promise<CalendarEvent> {
    const res = await this.fetchZoho<{ event: any }>(
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
    return this.mapEvent(res.event || res);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    // Zoho requires the event UID in the path and the etag header (or eventdata
    // with UID). Accept either the UID or numeric id — fetch the event to get
    // its UID/etag when needed.
    let targetId = eventId;
    let etag = '';
    try {
      const ev = await this.getEvent(calendarId, eventId);
      const uid = ev.raw?.uid as string | undefined;
      if (uid) {
        targetId = uid;
        etag = ev.raw?.etag ? String(ev.raw.etag) : '';
      }
    } catch {}
    await this.fetchZoho(
      `https://calendar.zoho.com/api/v1/calendars/${calendarId}/events/${targetId}`,
      { method: 'DELETE', headers: etag ? { etag } : undefined }
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

    const res = await this.fetchZoho<{ contacts: any[] }>(
      `https://contacts.zoho.com/api/v1/accounts/self/contacts?${params}`
    );
    
    return (res.contacts || []).map(c => this.mapContact(c));
  }

  async getContact(contactId: string): Promise<Contact> {
    const res = await this.fetchZoho<{ contact: any }>(
      `https://contacts.zoho.com/api/v1/accounts/self/contacts/${contactId}`
    );
    return this.mapContact(res.contact || res);
  }

  async createContact(contact: CreateContactInput): Promise<Contact> {
    const payload = {
      contacts: [{
        first_name: contact.displayName,
        emails: contact.emails.map((e, i) => ({ email_id: e.email, is_primary: i === 0 })),
        phones: contact.phones?.map(p => ({ number: p.number, type: p.type || 'mobile' })),
        company: contact.organization,
        job_title: contact.jobTitle,
        notes: contact.notes,
      }],
    };
    const res = await this.fetchZoho<{ contacts: any }>(
      `https://contacts.zoho.com/api/v1/accounts/self/contacts?source=mcp-ecc`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return this.mapContact(res.contacts || res);
  }

  async updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact> {
    const res = await this.fetchZoho<{ contact: any }>(
      `https://contacts.zoho.com/api/v1/accounts/self/contacts/${contactId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          first_name: patches.displayName,
          email: patches.emails?.map(e => e.email).join(','),
          phone: patches.phones?.map(p => p.number).join(','),
          company: patches.organization,
          job_title: patches.jobTitle,
          notes: patches.notes,
        }),
      }
    );
    return this.mapContact(res.contact || res);
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.fetchZoho(
      `https://contacts.zoho.com/api/v1/accounts/self/contacts/${contactId}`,
      { method: 'DELETE' }
    );
  }

  async searchContacts(query: string, options: SearchOptions = {}): Promise<Contact[]> {
    const params = new URLSearchParams();
    params.set('searchKey', query);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this.fetchZoho<{ contacts: any[] }>(
      `https://contacts.zoho.com/api/v1/accounts/self/contacts?${params}`
    );
    return (res.contacts || []).map(c => this.mapContact(c));
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
      id: evt.eventid || evt.eventId || evt.uid,
      calendarId: evt.calid || evt.calendarId,
      summary: evt.title || evt.summary || 'No Title',
      description: evt.description,
      location: evt.location,
      startAt: this.parseZohoTime(evt.start || evt.startTime),
      endAt: this.parseZohoTime(evt.end || evt.endTime),
      allDay: evt.isallday === true || evt.allDay === true,
      status: evt.status as CalendarEvent['status'],
      attendees: Array.isArray(evt.attendees) ? evt.attendees.map((a: any) => ({ address: typeof a === 'string' ? a : a.email })) : [],
      raw: evt,
    };
  }

  private parseZohoTime(value: any): number {
    if (!value) return Date.now();
    if (typeof value === 'number') return value;
    // Zoho v1 returns ISO-like or compact strings; ISO parses directly
    const t = Date.parse(value);
    return Number.isNaN(t) ? Date.now() : t;
  }

  private mapContact(c: any): Contact {
    return {
      id: c.contact_id || c.contactId,
      displayName: (c.first_name || c.firstName || '') + (c.last_name || c.lastName ? ` ${c.last_name || c.lastName}` : ''),
      emails: c.email ? String(c.email).split(',').map((e: string) => ({ email: e.trim(), type: 'work' })) : [],
      phones: c.phone ? String(c.phone).split(',').map((p: string) => ({ number: p.trim(), type: 'mobile' })) : [],
      organization: c.company,
      jobTitle: c.job_title || c.jobTitle,
      notes: c.notes,
      raw: c,
    };
  }
}