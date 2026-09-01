import { google } from 'googleapis';
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
  ContactPhone,
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

export class GoogleProvider implements IMailProvider, ICalendarProvider, IContactsProvider {
  private oauth2Client: InstanceType<typeof google.auth.OAuth2>;
  private gmail: ReturnType<typeof google.gmail>;
  private calendar: ReturnType<typeof google.calendar>;
  private people: ReturnType<typeof google.people>;

  constructor(private accountId: string, private credentials: AccountCredentials) {
    this.oauth2Client = new google.auth.OAuth2(
      credentials.clientId,
      credentials.clientSecret
    );

    this.oauth2Client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expiry_date: credentials.expiryDate,
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    this.people = google.people({ version: 'v1', auth: this.oauth2Client });
  }

  private async ensureFreshToken(): Promise<void> {
    const expiry = this.credentials.expiryDate || 0;
    if (Date.now() + 60000 >= expiry && this.credentials.refreshToken) {
      try {
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);
        // Note: In real implementation, update stored credentials
      } catch (error) {
        throw new Error(`Failed to refresh Google token: ${error}`);
      }
    }
  }

  // --- IMailProvider ---

  async listFolders(): Promise<MailFolder[]> {
    await this.ensureFreshToken();
    const res = await this.gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];

    const systemFolders: MailFolder[] = [
      { id: 'INBOX', name: 'Inbox', type: 'inbox', unreadCount: 0, totalCount: 0, createdAt: 0, updatedAt: 0 },
      { id: 'SENT', name: 'Sent', type: 'sent', unreadCount: 0, totalCount: 0, createdAt: 0, updatedAt: 0 },
      { id: 'DRAFT', name: 'Drafts', type: 'drafts', unreadCount: 0, totalCount: 0, createdAt: 0, updatedAt: 0 },
      { id: 'TRASH', name: 'Trash', type: 'trash', unreadCount: 0, totalCount: 0, createdAt: 0, updatedAt: 0 },
      { id: 'SPAM', name: 'Spam', type: 'spam', unreadCount: 0, totalCount: 0, createdAt: 0, updatedAt: 0 },
      { id: 'STARRED', name: 'Starred', type: 'custom', unreadCount: 0, totalCount: 0, createdAt: 0, updatedAt: 0 },
    ];

    const customFolders: MailFolder[] = labels
      .filter(l => !['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].includes(l.id || ''))
      .map(l => ({
        id: l.id!,
        name: l.name!,
        type: 'custom' as const,
        unreadCount: l.messagesUnread || 0,
        totalCount: l.messagesTotal || 0,
        createdAt: 0,
        updatedAt: 0,
      }));

    return [...systemFolders, ...customFolders];
  }

  async listMessages(folderId: string, options: ListMessagesOptions = {}): Promise<EmailMessage[]> {
    await this.ensureFreshToken();

    let q = options.query || '';
    const folderLabel = this.mapFolderToLabel(folderId);
    if (folderLabel) {
      q += q ? ` label:${folderLabel}` : `label:${folderLabel}`;
    }

    const res = await this.gmail.users.messages.list({
      userId: 'me',
      maxResults: options.limit || 50,
      q: q.trim() || undefined,
      pageToken: options.cursor,
    });

    if (!res.data.messages) return [];

    const messages: EmailMessage[] = [];
    for (const msg of res.data.messages) {
      if (msg.id) {
        try {
          const detail = await this.getMessage(msg.id);
          messages.push(detail);
        } catch (err) {
          console.error(`Failed to fetch email detail for ${msg.id}:`, err);
        }
      }
    }

    return messages;
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    await this.ensureFreshToken();
    const res = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const payload = res.data.payload;
    const headers = payload?.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const from = this.parseAddress(getHeader('from'));
    const to = getHeader('to').split(',').map(s => this.parseAddress(s.trim()));
    const cc = getHeader('cc') ? getHeader('cc').split(',').map(s => this.parseAddress(s.trim())) : [];
    const bcc = getHeader('bcc') ? getHeader('bcc').split(',').map(s => this.parseAddress(s.trim())) : [];
    const subject = getHeader('subject');
    const date = getHeader('date');

    // Extract body
    let body = '';
    let htmlBody = '';
    const attachments: EmailAttachment[] = [];

    const parsePart = (part: any) => {
      const mimeType = part.mimeType;
      const data = part.body?.data;
      const attachmentId = part.body?.attachmentId;
      const filename = part.filename;

      if (data) {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        if (mimeType === 'text/plain') {
          body = decoded;
        } else if (mimeType === 'text/html') {
          htmlBody = decoded;
        }
      }

      if (attachmentId && filename) {
        attachments.push({
          filename,
          mimeType,
          size: part.body?.size || 0,
          contentId: part.headers?.find((h: any) => h.name?.toLowerCase() === 'content-id')?.value,
        });
      }

      if (part.parts) {
        for (const subPart of part.parts) {
          parsePart(subPart);
        }
      }
    };

    if (payload) {
      parsePart(payload);
    }

    const labels = res.data.labelIds || [];

    return {
      id: messageId,
      threadId: res.data.threadId || undefined,
      from,
      to,
      cc,
      bcc,
      subject,
      snippet: res.data.snippet || '',
      body: body || res.data.snippet || '',
      htmlBody: htmlBody || undefined,
      date: new Date(date).getTime() || Date.now(),
      unread: labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      labelsOrFolders: labels,
      attachments: attachments.length > 0 ? attachments : undefined,
      headers: Object.fromEntries(headers.map(h => [h.name!, h.value!])),
    };
  }

  async sendMessage(message: SendMessageInput): Promise<EmailMessage> {
    await this.ensureFreshToken();

    const mailLines = [
      `From: ${this.credentials.config?.email || 'me'}`,
      `To: ${message.to.map(a => `${a.name ? `"${a.name}" ` : ''}<${a.address}>`).join(', ')}`,
    ];

    if (message.cc?.length) {
      mailLines.push(`Cc: ${message.cc.map(a => `${a.name ? `"${a.name}" ` : ''}<${a.address}>`).join(', ')}`);
    }

    mailLines.push(`Subject: ${message.subject}`);

    if (message.inReplyTo) {
      mailLines.push(`In-Reply-To: ${message.inReplyTo}`);
    }
    if (message.references?.length) {
      mailLines.push(`References: ${message.references.join(' ')}`);
    }

    mailLines.push('MIME-Version: 1.0');

    if (message.htmlBody) {
      mailLines.push('Content-Type: multipart/alternative; boundary="boundary123"');
      mailLines.push('');
      mailLines.push('--boundary123');
      mailLines.push('Content-Type: text/plain; charset=utf-8');
      mailLines.push('');
      mailLines.push(message.body);
      mailLines.push('');
      mailLines.push('--boundary123');
      mailLines.push('Content-Type: text/html; charset=utf-8');
      mailLines.push('');
      mailLines.push(message.htmlBody);
      mailLines.push('');
      mailLines.push('--boundary123--');
    } else {
      mailLines.push('Content-Type: text/plain; charset=utf-8');
      mailLines.push('');
      mailLines.push(message.body);
    }

    const raw = Buffer.from(mailLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return this.getMessage(res.data.id!);
  }

  async searchMessages(query: string, options: SearchOptions = {}): Promise<EmailMessage[]> {
    return this.listMessages('ALL', { ...options, query });
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    await this.ensureFreshToken();
    const labelIds = this.mapFolderToLabelIds(folderId);
    await this.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: labelIds.add,
        removeLabelIds: labelIds.remove,
      },
    });
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    await this.ensureFreshToken();
    // Gmail models read state via the UNREAD label: adding \Seen (mark read)
    // must REMOVE the UNREAD label; removing \Seen (mark unread) must ADD it.
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];

    if (addFlags.includes('\\Seen')) removeLabelIds.push('UNREAD');
    if (removeFlags.includes('\\Seen')) addLabelIds.push('UNREAD');
    if (addFlags.includes('\\Flagged')) addLabelIds.push('STARRED');
    if (removeFlags.includes('\\Flagged')) removeLabelIds.push('STARRED');
    if (addFlags.includes('\\Deleted')) addLabelIds.push('TRASH');
    if (removeFlags.includes('\\Deleted')) removeLabelIds.push('TRASH');

    await this.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    await this.ensureFreshToken();
    if (permanent) {
      await this.gmail.users.messages.delete({ userId: 'me', id: messageId });
    } else {
      await this.gmail.users.messages.trash({ userId: 'me', id: messageId });
    }
  }

  // --- ICalendarProvider ---

  async listCalendars(): Promise<Calendar[]> {
    await this.ensureFreshToken();
    const res = await this.calendar.calendarList.list();
    const items = res.data.items || [];

    return items.map(cal => ({
      id: cal.id!,
      name: cal.summary!,
      description: cal.description || undefined,
      color: cal.backgroundColor || undefined,
      primary: cal.primary === true,
      accessRole: cal.accessRole as Calendar['accessRole'],
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  async listEvents(calendarId: string, options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    await this.ensureFreshToken();
    const res = await this.calendar.events.list({
      calendarId: calendarId === 'primary' ? 'primary' : calendarId,
      timeMin: options.timeMin ? new Date(options.timeMin).toISOString() : new Date().toISOString(),
      timeMax: options.timeMax ? new Date(options.timeMax).toISOString() : undefined,
      maxResults: options.limit || 100,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken: options.cursor,
      q: options.query,
    });

    const items = res.data.items || [];
    return items.map(evt => this.mapEvent(evt));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    await this.ensureFreshToken();
    const res = await this.calendar.events.get({
      calendarId: calendarId === 'primary' ? 'primary' : calendarId,
      eventId,
    });
    return this.mapEvent(res.data);
  }

  async createEvent(calendarId: string, event: CreateEventInput): Promise<CalendarEvent> {
    await this.ensureFreshToken();
    const res = await this.calendar.events.insert({
      calendarId: calendarId === 'primary' ? 'primary' : calendarId,
      requestBody: {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: { dateTime: new Date(event.startAt).toISOString(), timeZone: 'UTC' },
        end: { dateTime: new Date(event.endAt).toISOString(), timeZone: 'UTC' },
        attendees: event.attendees?.map(a => ({ email: a.address, displayName: a.name })),
        recurrence: event.recurrenceRule ? [`RRULE:${event.recurrenceRule}`] : undefined,
      },
    });
    return this.mapEvent(res.data);
  }

  async updateEvent(calendarId: string, eventId: string, patches: UpdateEventInput): Promise<CalendarEvent> {
    await this.ensureFreshToken();
    const requestBody: any = {};
    if (patches.summary) requestBody.summary = patches.summary;
    if (patches.description !== undefined) requestBody.description = patches.description;
    if (patches.location !== undefined) requestBody.location = patches.location;
    if (patches.startAt) requestBody.start = { dateTime: new Date(patches.startAt).toISOString(), timeZone: 'UTC' };
    if (patches.endAt) requestBody.end = { dateTime: new Date(patches.endAt).toISOString(), timeZone: 'UTC' };
    if (patches.attendees) requestBody.attendees = patches.attendees.map(a => ({ email: a.address, displayName: a.name }));
    if (patches.status) requestBody.status = patches.status;

    const res = await this.calendar.events.patch({
      calendarId: calendarId === 'primary' ? 'primary' : calendarId,
      eventId,
      requestBody,
    });
    return this.mapEvent(res.data);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.ensureFreshToken();
    await this.calendar.events.delete({
      calendarId: calendarId === 'primary' ? 'primary' : calendarId,
      eventId,
    });
  }

  async freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }>> {
    await this.ensureFreshToken();
    const res = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        items: calendarIds.map(id => ({ id: id === 'primary' ? 'primary' : id })),
      },
    });

    const results: Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }> = [];
    for (const [calId, calData] of Object.entries(res.data.calendars || {})) {
      results.push({
        calendarId: calId,
        busy: (calData as any).busy?.map((b: any) => ({
          start: new Date(b.start).getTime(),
          end: new Date(b.end).getTime(),
        })) || [],
      });
    }
    return results;
  }

  // --- IContactsProvider ---

  async listContacts(options: ListContactsOptions = {}): Promise<Contact[]> {
    await this.ensureFreshToken();
    const res = await this.people.people.connections.list({
      resourceName: 'people/me',
      pageSize: options.limit || 100,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,photos,biographies',
      pageToken: options.cursor,
    });

    const connections = res.data.connections || [];
    return connections.map(person => this.mapContact(person));
  }

  async getContact(contactId: string): Promise<Contact> {
    await this.ensureFreshToken();
    const res = await this.people.people.get({
      resourceName: contactId,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,photos,biographies',
    });
    return this.mapContact(res.data);
  }

  async createContact(contact: CreateContactInput): Promise<Contact> {
    await this.ensureFreshToken();
    const res = await this.people.people.createContact({
      requestBody: {
        names: [{ givenName: contact.displayName }],
        emailAddresses: contact.emails.map(e => ({ value: e.email, type: e.type || 'work' })),
        phoneNumbers: contact.phones?.map(p => ({ value: p.number, type: p.type || 'mobile' })),
        organizations: contact.organization ? [{ name: contact.organization, title: contact.jobTitle }] : undefined,
        biographies: contact.notes ? [{ value: contact.notes }] : undefined,
      },
    });
    return this.mapContact(res.data);
  }

  async updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact> {
    await this.ensureFreshToken();
    const current = await this.getContact(contactId);
    
    const res = await this.people.people.updateContact({
      resourceName: contactId,
      updatePersonFields: 'names,emailAddresses,phoneNumbers,organizations,biographies',
      requestBody: {
        names: patches.displayName ? [{ givenName: patches.displayName }] : current.emails.length > 0 ? [{ givenName: current.displayName }] : undefined,
        emailAddresses: patches.emails?.map(e => ({ value: e.email, type: e.type || 'work' })),
        phoneNumbers: patches.phones?.map(p => ({ value: p.number, type: p.type || 'mobile' })),
        organizations: patches.organization ? [{ name: patches.organization, title: patches.jobTitle }] : undefined,
        biographies: patches.notes ? [{ value: patches.notes }] : undefined,
      },
    });
    return this.mapContact(res.data);
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.ensureFreshToken();
    await this.people.people.deleteContact({ resourceName: contactId });
  }

  async searchContacts(query: string, options: SearchOptions = {}): Promise<Contact[]> {
    await this.ensureFreshToken();
    const res = await this.people.people.searchContacts({
      query,
      pageSize: options.limit || 50,
      readMask: 'names,emailAddresses,phoneNumbers,organizations',
    });
    const results = res.data.results || [];
    return results.map(r => this.mapContact(r.person!));
  }

  // --- Helpers ---

  private mapFolderToLabel(folderId: string): string | null {
    const map: Record<string, string> = {
      'INBOX': 'INBOX',
      'SENT': 'SENT',
      'DRAFT': 'DRAFT',
      'DRAFTS': 'DRAFT',
      'TRASH': 'TRASH',
      'SPAM': 'SPAM',
      'STARRED': 'STARRED',
      'ALL': '',
    };
    return map[folderId.toUpperCase()] || folderId;
  }

  private mapFolderToLabelIds(folderId: string): { add: string[]; remove: string[] } {
    const label = this.mapFolderToLabel(folderId);
    if (!label) return { add: [], remove: [] };
    
    // Remove all system labels, add target
    const systemLabels = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED'];
    return {
      add: [label],
      remove: systemLabels.filter(l => l !== label),
    };
  }

  private parseAddress(header: string): EmailAddress {
    const match = header.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      return { name: match[1].replace(/"/g, '').trim(), address: match[2].trim() };
    }
    return { address: header.trim() };
  }

  private mapEvent(evt: any): CalendarEvent {
    return {
      id: evt.id!,
      calendarId: evt.organizer?.email || 'primary',
      summary: evt.summary || 'No Title',
      description: evt.description || undefined,
      location: evt.location || undefined,
      startAt: new Date(evt.start?.dateTime || evt.start?.date).getTime(),
      endAt: new Date(evt.end?.dateTime || evt.end?.date).getTime(),
      allDay: !evt.start?.dateTime,
      status: evt.status as CalendarEvent['status'],
      attendees: evt.attendees?.map((a: any) => ({
        name: a.displayName,
        address: a.email,
      })) || [],
      recurrenceRule: evt.recurrence?.[0]?.replace('RRULE:', ''),
      raw: evt,
    };
  }

  private mapContact(person: any): Contact {
    const name = person.names?.[0];
    const emails = person.emailAddresses?.map((e: any) => ({
      email: e.value,
      type: e.type?.toLowerCase() as Contact['emails'][0]['type'],
      primary: e.metadata?.primary,
    })) || [];

    return {
      id: person.resourceName!,
      displayName: name?.displayName || emails[0]?.email || 'Unknown',
      emails,
      phones: person.phoneNumbers?.map((p: any) => ({
        number: p.value,
        type: (p.type?.toLowerCase() || 'mobile') as ContactPhone['type'],
      })) || [],
      organization: person.organizations?.[0]?.name,
      jobTitle: person.organizations?.[0]?.title,
      notes: person.biographies?.[0]?.value,
      raw: person,
    };
  }
}