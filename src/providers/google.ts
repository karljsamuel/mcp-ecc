import { google } from 'googleapis';
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

export class GoogleProvider implements IEmailProvider, ICalendarProvider, IContactsProvider {
  private oauth2Client;

  constructor(private account: AccountCredentials) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    this.oauth2Client.setCredentials({
      access_token: account.tokens.accessToken,
      refresh_token: account.tokens.refreshToken,
      expiry_date: account.tokens.expiryDate
    });
  }

  private async ensureFreshToken() {
    const expiry = this.account.tokens.expiryDate || 0;
    if (Date.now() + 60000 >= expiry) {
      // Token is expired or expiring within a minute
      const newAccessToken = await HeadlessAuthManager.refreshAccessToken(this.account);
      this.oauth2Client.setCredentials({
        access_token: newAccessToken
      });
    }
  }

  // --- IEmailProvider ---
  async listEmails(folder = 'INBOX', limit = 10, query?: string): Promise<EmailMessage[]> {
    await this.ensureFreshToken();
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    
    let q = query || '';
    if (folder && folder !== 'ALL') {
      if (folder.toLowerCase() === 'inbox') q += ' label:INBOX';
      else if (folder.toLowerCase() === 'starred') q += ' label:STARRED';
      else if (folder.toLowerCase() === 'sent') q += ' label:SENT';
      else if (folder.toLowerCase() === 'draft') q += ' label:DRAFT';
      else if (folder.toLowerCase() === 'trash') q += ' label:TRASH';
    }

    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: limit,
      q: q.trim() || undefined
    });

    if (!res.data.messages) return [];

    const messages: EmailMessage[] = [];
    for (const msg of res.data.messages) {
      if (msg.id) {
        try {
          const detail = await this.getEmail(msg.id);
          messages.push(detail);
        } catch (err) {
          console.error(`Failed to fetch email detail for ${msg.id}:`, err);
        }
      }
    }
    return messages;
  }

  async getEmail(messageId: string): Promise<EmailMessage> {
    await this.ensureFreshToken();
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const payload = res.data.payload;
    const headers = payload?.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const from = getHeader('from');
    const to = getHeader('to').split(',').map(s => s.trim());
    const cc = getHeader('cc') ? getHeader('cc').split(',').map(s => s.trim()) : [];
    const bcc = getHeader('bcc') ? getHeader('bcc').split(',').map(s => s.trim()) : [];
    const subject = getHeader('subject');
    const date = getHeader('date');

    // Extract body
    let body = '';
    let htmlBody = '';
    
    const parsePart = (part: any) => {
      const mimeType = part.mimeType;
      const data = part.body?.data;
      if (data) {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        if (mimeType === 'text/plain') {
          body = decoded;
        } else if (mimeType === 'text/html') {
          htmlBody = decoded;
        }
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
      date,
      unread: labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      labelsOrFolders: labels
    };
  }

  async sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[]): Promise<EmailMessage> {
    await this.ensureFreshToken();
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    const mailLines = [];
    mailLines.push(`To: ${to.join(', ')}`);
    if (cc && cc.length > 0) mailLines.push(`Cc: ${cc.join(', ')}`);
    if (bcc && bcc.length > 0) mailLines.push(`Bcc: ${bcc.join(', ')}`);
    mailLines.push(`Subject: ${subject}`);
    mailLines.push('Content-Type: text/plain; charset=utf-8');
    mailLines.push('');
    mailLines.push(body);

    const raw = Buffer.from(mailLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw }
    });

    return {
      id: res.data.id || '',
      threadId: res.data.threadId || undefined,
      from: 'me',
      to,
      cc,
      bcc,
      subject,
      date: new Date().toISOString(),
      unread: false,
      starred: false,
      labelsOrFolders: res.data.labelIds || []
    };
  }

  async manageEmail(messageId: string, action: 'archive' | 'read' | 'unread' | 'star'): Promise<void> {
    await this.ensureFreshToken();
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    
    const requestBody: any = {
      addLabelIds: [],
      removeLabelIds: []
    };

    if (action === 'archive') {
      requestBody.removeLabelIds.push('INBOX');
    } else if (action === 'read') {
      requestBody.removeLabelIds.push('UNREAD');
    } else if (action === 'unread') {
      requestBody.addLabelIds.push('UNREAD');
    } else if (action === 'star') {
      requestBody.addLabelIds.push('STARRED');
    }

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody
    });
  }

  async deleteEmail(messageId: string): Promise<void> {
    await this.ensureFreshToken();
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    await gmail.users.messages.trash({
      userId: 'me',
      id: messageId
    });
  }

  // --- ICalendarProvider ---
  async listEvents(startTime?: string, endTime?: string): Promise<CalendarEvent[]> {
    await this.ensureFreshToken();
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startTime || new Date().toISOString(),
      timeMax: endTime || undefined,
      singleEvents: true,
      orderBy: 'startTime'
    });

    return (res.data.items || []).map(evt => ({
      id: evt.id || '',
      title: evt.summary || 'No Title',
      description: evt.description || undefined,
      startTime: evt.start?.dateTime || evt.start?.date || '',
      endTime: evt.end?.dateTime || evt.end?.date || '',
      attendees: evt.attendees?.map(a => a.email || '').filter(Boolean),
      location: evt.location || undefined,
      status: evt.status || undefined
    }));
  }

  async createEvent(title: string, startTime: string, endTime: string, description?: string, attendees?: string[]): Promise<CalendarEvent> {
    await this.ensureFreshToken();
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description,
        start: { dateTime: startTime },
        end: { dateTime: endTime },
        attendees: attendees?.map(email => ({ email }))
      }
    });

    const evt = res.data;
    return {
      id: evt.id || '',
      title: evt.summary || '',
      description: evt.description || undefined,
      startTime: evt.start?.dateTime || evt.start?.date || '',
      endTime: evt.end?.dateTime || evt.end?.date || '',
      attendees: evt.attendees?.map(a => a.email || '').filter(Boolean),
      location: evt.location || undefined,
      status: evt.status || undefined
    };
  }

  async updateEvent(eventId: string, patches: Partial<CalendarEvent>): Promise<CalendarEvent> {
    await this.ensureFreshToken();
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const requestBody: any = {};
    if (patches.title !== undefined) requestBody.summary = patches.title;
    if (patches.description !== undefined) requestBody.description = patches.description;
    if (patches.startTime !== undefined) requestBody.start = { dateTime: patches.startTime };
    if (patches.endTime !== undefined) requestBody.end = { dateTime: patches.endTime };
    if (patches.attendees !== undefined) requestBody.attendees = patches.attendees.map(email => ({ email }));
    if (patches.location !== undefined) requestBody.location = patches.location;

    const res = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody
    });

    const evt = res.data;
    return {
      id: evt.id || '',
      title: evt.summary || '',
      description: evt.description || undefined,
      startTime: evt.start?.dateTime || evt.start?.date || '',
      endTime: evt.end?.dateTime || evt.end?.date || '',
      attendees: evt.attendees?.map(a => a.email || '').filter(Boolean),
      location: evt.location || undefined,
      status: evt.status || undefined
    };
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.ensureFreshToken();
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId
    });
  }

  // --- IContactsProvider ---
  async searchContacts(query: string): Promise<ContactInfo[]> {
    await this.ensureFreshToken();
    const people = google.people({ version: 'v1', auth: this.oauth2Client });
    
    // Google People API search
    const res = await people.people.searchContacts({
      query,
      readMask: 'names,emailAddresses,phoneNumbers,organizations'
    });

    const connections = res.data.results || [];
    return connections.map(c => {
      const person = c.person;
      if (!person) return null;
      const names = person.names || [];
      const emails = person.emailAddresses || [];
      const phones = person.phoneNumbers || [];
      const orgs = person.organizations || [];

      return {
        id: person.resourceName || '',
        name: names[0]?.displayName || 'Unnamed',
        emails: emails.map(e => e.value || '').filter(Boolean),
        phones: phones.map(p => p.value || '').filter(Boolean),
        organization: orgs[0]?.name || undefined
      };
    }).filter(Boolean) as ContactInfo[];
  }

  async createContact(name: string, email: string, phone?: string): Promise<ContactInfo> {
    await this.ensureFreshToken();
    const people = google.people({ version: 'v1', auth: this.oauth2Client });
    
    const res = await people.people.createContact({
      requestBody: {
        names: [{ givenName: name }],
        emailAddresses: [{ value: email }],
        phoneNumbers: phone ? [{ value: phone }] : []
      }
    });

    const person = res.data;
    return {
      id: person.resourceName || '',
      name: person.names?.[0]?.displayName || name,
      emails: person.emailAddresses?.map(e => e.value || '').filter(Boolean) || [email],
      phones: person.phoneNumbers?.map(p => p.value || '').filter(Boolean) || []
    };
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.ensureFreshToken();
    const people = google.people({ version: 'v1', auth: this.oauth2Client });
    await people.people.deleteContact({
      resourceName: contactId
    });
  }
}
