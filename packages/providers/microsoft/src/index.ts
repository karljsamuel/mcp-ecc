import { Client } from '@microsoft/microsoft-graph-client';
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

export class MicrosoftProvider implements IMailProvider, ICalendarProvider, IContactsProvider {
  private client: Client;

  constructor(private accountId: string, private credentials: AccountCredentials) {
    this.client = Client.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => {
          await this.ensureFreshToken();
          return this.credentials.accessToken || '';
        },
      },
    });
  }

  private async ensureFreshToken(): Promise<void> {
    const expiry = this.credentials.expiryDate || 0;
    if (Date.now() + 60000 >= expiry && this.credentials.refreshToken) {
      try {
        const tokenUrl = `https://login.microsoftonline.com/${this.credentials.tenantId || 'common'}/oauth2/v2.0/token`;
        const body: Record<string, string> = {
          client_id: this.credentials.clientId || '',
          grant_type: 'refresh_token',
          refresh_token: this.credentials.refreshToken,
          scope: 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.ReadWrite https://graph.microsoft.com/User.Read',
        };
        // Public (mobile/desktop) clients must NOT send a client secret —
        // doing so returns AADSTS90023.
        if (this.credentials.clientSecret && !this.credentials.isPublicClient) {
          body.client_secret = this.credentials.clientSecret;
        }

        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body).toString(),
        });
        const data: any = await response.json();
        if (!response.ok || !data.access_token) {
          throw new Error(`refresh failed: ${data.error} - ${data.error_description || ''}`);
        }
        this.credentials.accessToken = data.access_token;
        if (data.refresh_token) this.credentials.refreshToken = data.refresh_token;
        this.credentials.expiryDate = Date.now() + (data.expires_in || 3600) * 1000;
      } catch (error) {
        throw new Error(`Failed to refresh Microsoft token: ${error}`);
      }
    }
  }

  private async getHeaders(): Promise<Record<string, string>> {
    await this.ensureFreshToken();
    return {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async fetchGraph<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://graph.microsoft.com/v1.0${url}`, {
      ...options,
      headers: { ...await this.getHeaders(), ...options.headers },
    });

    if (!response.ok) {
      const error: any = await response.json().catch(() => ({}));
      throw new Error(`Graph API error: ${response.status} - ${error.error?.message || response.statusText}`);
    }

    // Some endpoints (e.g. sendMail) return 202 with an empty body.
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // --- IMailProvider ---

  async listFolders(): Promise<MailFolder[]> {
    const res = await this.fetchGraph<{ value: any[] }>('/me/mailFolders');
    return (res.value || []).map(f => ({
      id: f.id,
      name: f.displayName,
      parentId: f.parentFolderId,
      type: this.mapFolderType(f.displayName),
      unreadCount: f.unreadItemCount || 0,
      totalCount: 0,
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  async listMessages(folderId: string, options: ListMessagesOptions = {}): Promise<EmailMessage[]> {
    let url = folderId === 'ALL' 
      ? '/me/messages'
      : `/me/mailFolders/${folderId}/messages`;

    const params = new URLSearchParams();
    params.set('$top', String(options.limit || 50));
    params.set('$select', 'id,subject,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,categories,hasAttachments,importance,conversationId');
    
    if (options.query) {
      params.set('$search', `"${options.query}"`);
    }
    if (options.cursor) {
      params.set('$skip', options.cursor);
    }

    const res = await this.fetchGraph<{ value: any[]; '@odata.nextLink'?: string }>(`${url}?${params}`);
    return (res.value || []).map(item => this.mapMessage(item));
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const res = await this.fetchGraph<any>(`/me/messages/${messageId}?$select=id,subject,body,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,categories,hasAttachments,importance,conversationId,internetMessageHeaders`);
    return this.mapMessage(res);
  }

  async sendMessage(message: SendMessageInput): Promise<EmailMessage> {
    const requestBody = {
      message: {
        subject: message.subject,
        body: {
          contentType: message.htmlBody ? 'HTML' : 'Text',
          content: message.htmlBody || message.body,
        },
        toRecipients: message.to.map(a => ({ emailAddress: { address: a.address, name: a.name } })),
        ccRecipients: message.cc?.map(a => ({ emailAddress: { address: a.address, name: a.name } })),
        bccRecipients: message.bcc?.map(a => ({ emailAddress: { address: a.address, name: a.name } })),
        ...(message.inReplyTo ? { internetMessageHeaders: [
          { name: 'In-Reply-To', value: message.inReplyTo },
          ...(message.references?.map(r => ({ name: 'References', value: r })) || [])
        ]} : {}),
      },
      saveToSentItems: true,
    };

    await this.fetchGraph('/me/sendMail', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    // Return a minimal message - actual sent message ID not returned by Graph sendMail
    return {
      id: 'sent',
      from: { address: (this.credentials.config?.email as string) || '' },
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
    return this.listMessages('ALL', { ...options, query });
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    await this.fetchGraph(`/me/messages/${messageId}/move`, {
      method: 'POST',
      body: JSON.stringify({ destinationId: folderId }),
    });
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    const updates: Record<string, any> = {};
    
    if (addFlags.includes('\\Seen') || removeFlags.includes('\\Seen')) {
      updates.isRead = addFlags.includes('\\Seen');
    }
    if (addFlags.includes('\\Flagged') || removeFlags.includes('\\Flagged')) {
      const categories = addFlags.includes('\\Flagged') ? ['Starred'] : [];
      updates.categories = categories;
    }

    if (Object.keys(updates).length > 0) {
      await this.fetchGraph(`/me/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    }
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    if (permanent) {
      await this.fetchGraph(`/me/messages/${messageId}`, { method: 'DELETE' });
    } else {
      // Move to deleted items
      await this.moveMessage(messageId, 'deleteditems');
    }
  }

  // --- ICalendarProvider ---

  async listCalendars(): Promise<Calendar[]> {
    const res = await this.fetchGraph<{ value: any[] }>('/me/calendars');
    return (res.value || []).map(cal => ({
      id: cal.id,
      name: cal.name,
      description: undefined,
      color: cal.hexColor || undefined,
      primary: cal.isDefaultCalendar === true,
      accessRole: cal.canEdit ? 'writer' : 'reader',
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  async listEvents(calendarId: string, options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    const params = new URLSearchParams();
    params.set('$top', String(options.limit || 100));
    params.set('$orderby', 'start/dateTime');
    
    if (options.timeMin) {
      params.set('startDateTime', new Date(options.timeMin).toISOString());
    }
    if (options.timeMax) {
      params.set('endDateTime', new Date(options.timeMax).toISOString());
    }
    if (options.query) {
      params.set('$search', `"${options.query}"`);
    }

    const res = await this.fetchGraph<{ value: any[] }>(`/me/calendars/${calendarId}/events?${params}`);
    return (res.value || []).map(evt => this.mapEvent(evt));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const res = await this.fetchGraph<any>(`/me/calendars/${calendarId}/events/${eventId}`);
    return this.mapEvent(res);
  }

  async createEvent(calendarId: string, event: CreateEventInput): Promise<CalendarEvent> {
    const requestBody = {
      subject: event.summary,
      body: event.description ? { contentType: 'HTML', content: event.description } : undefined,
      start: { dateTime: new Date(event.startAt).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(event.endAt).toISOString(), timeZone: 'UTC' },
      attendees: event.attendees?.map(a => ({
        emailAddress: { address: a.address, name: a.name },
        type: 'required',
      })),
      location: event.location ? { displayName: event.location } : undefined,
      isAllDay: event.allDay,
      recurrence: event.recurrenceRule ? { pattern: { type: 'absoluteMonthly', interval: 1 }, range: { type: 'noEnd' } } : undefined,
    };

    const res = await this.fetchGraph<any>(`/me/calendars/${calendarId}/events`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return this.mapEvent(res);
  }

  async updateEvent(calendarId: string, eventId: string, patches: UpdateEventInput): Promise<CalendarEvent> {
    const requestBody: any = {};
    if (patches.summary) requestBody.subject = patches.summary;
    if (patches.description !== undefined) requestBody.body = { contentType: 'HTML', content: patches.description };
    if (patches.location !== undefined) requestBody.location = { displayName: patches.location };
    if (patches.startAt) requestBody.start = { dateTime: new Date(patches.startAt).toISOString(), timeZone: 'UTC' };
    if (patches.endAt) requestBody.end = { dateTime: new Date(patches.endAt).toISOString(), timeZone: 'UTC' };
    if (patches.attendees) requestBody.attendees = patches.attendees.map(a => ({
      emailAddress: { address: a.address, name: a.name },
      type: 'required',
    }));
    if (patches.status) requestBody.showAs = patches.status === 'cancelled' ? 'free' : 'busy';

    const res = await this.fetchGraph<any>(`/me/calendars/${calendarId}/events/${eventId}`, {
      method: 'PATCH',
      body: JSON.stringify(requestBody),
    });
    return this.mapEvent(res);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.fetchGraph(`/me/calendars/${calendarId}/events/${eventId}`, { method: 'DELETE' });
  }

  async freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }>> {
    const res = await this.fetchGraph<any>('/me/calendar/getSchedule', {
      method: 'POST',
      body: JSON.stringify({
        schedules: calendarIds.map(id => id),
        startTime: { dateTime: new Date(timeMin).toISOString(), timeZone: 'UTC' },
        endTime: { dateTime: new Date(timeMax).toISOString(), timeZone: 'UTC' },
        availabilityViewInterval: 30,
      }),
    });

    return (res.value || []).map((item: any) => ({
      calendarId: item.scheduleId,
      busy: (item.scheduleItems || []).map((s: any) => ({
        start: new Date(s.start.dateTime).getTime(),
        end: new Date(s.end.dateTime).getTime(),
      })),
    }));
  }

  // --- IContactsProvider ---

  async listContacts(options: ListContactsOptions = {}): Promise<Contact[]> {
    const params = new URLSearchParams();
    params.set('$top', String(options.limit || 100));
    params.set('$select', 'id,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName,jobTitle,personalNotes');
    if (options.cursor) params.set('$skip', options.cursor);

    const res = await this.fetchGraph<{ value: any[] }>(`/me/contacts?${params}`);
    return (res.value || []).map(c => this.mapContact(c));
  }

  async getContact(contactId: string): Promise<Contact> {
    const res = await this.fetchGraph<any>(`/me/contacts/${contactId}`);
    return this.mapContact(res);
  }

  async createContact(contact: CreateContactInput): Promise<Contact> {
    const requestBody = {
      displayName: contact.displayName,
      emailAddresses: contact.emails.map((e, i) => ({
        address: e.email,
        name: e.type || (i === 0 ? 'Work' : 'Personal'),
      })),
      businessPhones: contact.phones?.filter(p => p.type === 'work').map(p => p.number) || [],
      homePhones: contact.phones?.filter(p => p.type === 'home').map(p => p.number) || [],
      mobilePhone: contact.phones?.find(p => p.type === 'mobile')?.number,
      companyName: contact.organization,
      jobTitle: contact.jobTitle,
      personalNotes: contact.notes,
    };

    const res = await this.fetchGraph<any>('/me/contacts', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    return this.mapContact(res);
  }

  async updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact> {
    const requestBody: any = {};
    if (patches.displayName) requestBody.displayName = patches.displayName;
    if (patches.emails) requestBody.emailAddresses = patches.emails.map((e, i) => ({
      address: e.email,
      name: e.type || (i === 0 ? 'Work' : 'Personal'),
    }));
    if (patches.phones) {
      requestBody.businessPhones = patches.phones.filter(p => p.type === 'work').map(p => p.number);
      requestBody.homePhones = patches.phones.filter(p => p.type === 'home').map(p => p.number);
      requestBody.mobilePhone = patches.phones.find(p => p.type === 'mobile')?.number;
    }
    if (patches.organization) requestBody.companyName = patches.organization;
    if (patches.jobTitle) requestBody.jobTitle = patches.jobTitle;
    if (patches.notes) requestBody.personalNotes = patches.notes;

    const res = await this.fetchGraph<any>(`/me/contacts/${contactId}`, {
      method: 'PATCH',
      body: JSON.stringify(requestBody),
    });
    return this.mapContact(res);
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.fetchGraph(`/me/contacts/${contactId}`, { method: 'DELETE' });
  }

  async searchContacts(query: string, options: SearchOptions = {}): Promise<Contact[]> {
    const params = new URLSearchParams();
    params.set('$top', String(options.limit || 50));
    params.set('$search', `"${query}"`);
    params.set('$select', 'id,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName,jobTitle,personalNotes');

    const res = await this.fetchGraph<{ value: any[] }>(`/me/contacts?${params}`);
    return (res.value || []).map(c => this.mapContact(c));
  }

  // --- Helpers ---

  private mapFolderType(displayName: string): MailFolder['type'] {
    const name = displayName.toLowerCase();
    if (name.includes('inbox')) return 'inbox';
    if (name.includes('sent')) return 'sent';
    if (name.includes('draft')) return 'drafts';
    if (name.includes('deleted') || name.includes('trash')) return 'trash';
    if (name.includes('junk') || name.includes('spam')) return 'spam';
    if (name.includes('archive')) return 'archive';
    return 'custom';
  }

  private mapMessage(item: any): EmailMessage {
    return {
      id: item.id,
      threadId: item.conversationId,
      from: { name: item.from?.emailAddress?.name, address: item.from?.emailAddress?.address || '' },
      to: item.toRecipients?.map((r: any) => ({ name: r.emailAddress?.name, address: r.emailAddress?.address })) || [],
      cc: item.ccRecipients?.map((r: any) => ({ name: r.emailAddress?.name, address: r.emailAddress?.address })) || [],
      bcc: item.bccRecipients?.map((r: any) => ({ name: r.emailAddress?.name, address: r.emailAddress?.address })) || [],
      subject: item.subject || '',
      snippet: item.bodyPreview || '',
      body: item.body?.contentType === 'text' ? item.body.content : item.bodyPreview,
      htmlBody: item.body?.contentType === 'html' ? item.body.content : undefined,
      date: new Date(item.receivedDateTime).getTime(),
      unread: !item.isRead,
      starred: item.categories?.includes('Starred') || false,
      labelsOrFolders: item.categories || [],
      attachments: item.hasAttachments ? [{ filename: 'attachment', mimeType: 'application/octet-stream', size: 0 }] : undefined,
    };
  }

  private mapEvent(evt: any): CalendarEvent {
    return {
      id: evt.id,
      calendarId: evt.organizer?.emailAddress?.address || 'primary',
      summary: evt.subject || 'No Title',
      description: evt.body?.content || undefined,
      location: evt.location?.displayName || undefined,
      startAt: new Date(evt.start?.dateTime).getTime(),
      endAt: new Date(evt.end?.dateTime).getTime(),
      allDay: evt.isAllDay === true,
      status: evt.showAs === 'free' ? 'tentative' : evt.isCancelled ? 'cancelled' : 'confirmed',
      attendees: evt.attendees?.map((a: any) => ({
        name: a.emailAddress?.name,
        address: a.emailAddress?.address,
      })) || [],
      recurrenceRule: evt.recurrence?.pattern?.type ? 'RRULE:FREQ=WEEKLY' : undefined, // Simplified
      raw: evt,
    };
  }

  private mapContact(c: any): Contact {
    return {
      id: c.id,
      displayName: c.displayName,
      emails: c.emailAddresses?.map((e: any) => ({
        email: e.address,
        type: e.name?.toLowerCase().includes('work') ? 'work' : 'home',
      })) || [],
      phones: [
        ...(c.businessPhones?.map((n: string) => ({ number: n, type: 'work' as const })) || []),
        ...(c.homePhones?.map((n: string) => ({ number: n, type: 'home' as const })) || []),
        ...(c.mobilePhone ? [{ number: c.mobilePhone, type: 'mobile' as const }] : []),
      ],
      organization: c.companyName,
      jobTitle: c.jobTitle,
      notes: c.personalNotes,
      raw: c,
    };
  }
}