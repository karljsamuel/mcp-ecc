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

export class MicrosoftProvider implements IEmailProvider, ICalendarProvider, IContactsProvider {
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

  // --- IEmailProvider ---
  async listEmails(folder = 'inbox', limit = 10, query?: string): Promise<EmailMessage[]> {
    const headers = await this.getHeaders();
    let url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages`;
    if (folder.toLowerCase() === 'all') {
      url = 'https://graph.microsoft.com/v1.0/me/messages';
    }

    const params: any = {
      $top: limit,
      $select: 'id,subject,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,categories'
    };

    if (query) {
      params.$search = `"${query}"`;
    }

    const res = await axios.get(url, { headers, params });
    const items = res.data.value || [];

    return items.map((item: any) => ({
      id: item.id,
      from: item.from?.emailAddress?.address || '',
      to: item.toRecipients?.map((r: any) => r.emailAddress?.address).filter(Boolean) || [],
      cc: item.ccRecipients?.map((r: any) => r.emailAddress?.address).filter(Boolean) || [],
      bcc: item.bccRecipients?.map((r: any) => r.emailAddress?.address).filter(Boolean) || [],
      subject: item.subject || '',
      snippet: item.bodyPreview || '',
      body: item.bodyPreview || '',
      date: item.receivedDateTime || '',
      unread: !item.isRead,
      starred: item.categories?.includes('Starred') || false,
      labelsOrFolders: item.categories || []
    }));
  }

  async getEmail(messageId: string): Promise<EmailMessage> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/messages/${messageId}`;
    const res = await axios.get(url, { headers });
    const item = res.data;

    return {
      id: item.id,
      from: item.from?.emailAddress?.address || '',
      to: item.toRecipients?.map((r: any) => r.emailAddress?.address).filter(Boolean) || [],
      cc: item.ccRecipients?.map((r: any) => r.emailAddress?.address).filter(Boolean) || [],
      bcc: item.bccRecipients?.map((r: any) => r.emailAddress?.address).filter(Boolean) || [],
      subject: item.subject || '',
      snippet: item.bodyPreview || '',
      body: item.body?.content || item.bodyPreview || '',
      htmlBody: item.body?.contentType === 'html' ? item.body.content : undefined,
      date: item.receivedDateTime || '',
      unread: !item.isRead,
      starred: item.categories?.includes('Starred') || false,
      labelsOrFolders: item.categories || []
    };
  }

  async sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[]): Promise<EmailMessage> {
    const headers = await this.getHeaders();
    const url = 'https://graph.microsoft.com/v1.0/me/sendMail';
    
    const requestBody = {
      message: {
        subject,
        body: {
          contentType: 'Text',
          content: body
        },
        toRecipients: to.map(email => ({ emailAddress: { address: email } })),
        ccRecipients: cc?.map(email => ({ emailAddress: { address: email } })) || [],
        bccRecipients: bcc?.map(email => ({ emailAddress: { address: email } })) || []
      }
    };

    await axios.post(url, requestBody, { headers });

    return {
      id: 'sent_via_graph',
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
    const url = `https://graph.microsoft.com/v1.0/me/messages/${messageId}`;
    
    const patches: any = {};
    if (action === 'read') {
      patches.isRead = true;
    } else if (action === 'unread') {
      patches.isRead = false;
    }

    if (patches.isRead !== undefined) {
      await axios.patch(url, patches, { headers });
    }

    if (action === 'archive') {
      // Moves to archive folder
      const moveUrl = `${url}/move`;
      await axios.post(moveUrl, { destinationId: 'archive' }, { headers });
    } else if (action === 'star') {
      // Graph uses categories or custom fields for flags. Let's flag it.
      await axios.patch(url, {
        flag: { flagStatus: 'flagged' }
      }, { headers });
    }
  }

  async deleteEmail(messageId: string): Promise<void> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/messages/${messageId}`;
    await axios.delete(url, { headers });
  }

  // --- ICalendarProvider ---
  async listEvents(startTime?: string, endTime?: string): Promise<CalendarEvent[]> {
    const headers = await this.getHeaders();
    const url = 'https://graph.microsoft.com/v1.0/me/calendar/events';
    const params: any = {
      $select: 'id,subject,bodyPreview,start,end,attendees,location,status'
    };

    if (startTime || endTime) {
      // Must use calendarView for date filters
      const viewUrl = 'https://graph.microsoft.com/v1.0/me/calendar/calendarView';
      params.startDateTime = startTime || new Date().toISOString();
      params.endDateTime = endTime || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days default
      
      const res = await axios.get(viewUrl, { headers, params });
      return (res.data.value || []).map((evt: any) => ({
        id: evt.id,
        title: evt.subject || 'No Title',
        description: evt.bodyPreview || undefined,
        startTime: evt.start?.dateTime || '',
        endTime: evt.end?.dateTime || '',
        attendees: evt.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
        location: evt.location?.displayName || undefined,
        status: evt.status?.response || undefined
      }));
    }

    const res = await axios.get(url, { headers, params });
    return (res.data.value || []).map((evt: any) => ({
      id: evt.id,
      title: evt.subject || 'No Title',
      description: evt.bodyPreview || undefined,
      startTime: evt.start?.dateTime || '',
      endTime: evt.end?.dateTime || '',
      attendees: evt.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
      location: evt.location?.displayName || undefined,
      status: evt.status?.response || undefined
    }));
  }

  async createEvent(title: string, startTime: string, endTime: string, description?: string, attendees?: string[]): Promise<CalendarEvent> {
    const headers = await this.getHeaders();
    const url = 'https://graph.microsoft.com/v1.0/me/calendar/events';
    
    const requestBody = {
      subject: title,
      body: description ? { contentType: 'HTML', content: description } : undefined,
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: attendees?.map(email => ({
        emailAddress: { address: email },
        type: 'required'
      }))
    };

    const res = await axios.post(url, requestBody, { headers });
    const evt = res.data;

    return {
      id: evt.id,
      title: evt.subject || '',
      description: evt.bodyPreview || undefined,
      startTime: evt.start?.dateTime || '',
      endTime: evt.end?.dateTime || '',
      attendees: evt.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
      location: evt.location?.displayName || undefined
    };
  }

  async updateEvent(eventId: string, patches: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/calendar/events/${eventId}`;

    const requestBody: any = {};
    if (patches.title !== undefined) requestBody.subject = patches.title;
    if (patches.description !== undefined) requestBody.body = { contentType: 'HTML', content: patches.description };
    if (patches.startTime !== undefined) requestBody.start = { dateTime: patches.startTime, timeZone: 'UTC' };
    if (patches.endTime !== undefined) requestBody.end = { dateTime: patches.endTime, timeZone: 'UTC' };
    if (patches.attendees !== undefined) {
      requestBody.attendees = patches.attendees.map(email => ({
        emailAddress: { address: email },
        type: 'required'
      }));
    }

    const res = await axios.patch(url, requestBody, { headers });
    const evt = res.data;

    return {
      id: evt.id,
      title: evt.subject || '',
      description: evt.bodyPreview || undefined,
      startTime: evt.start?.dateTime || '',
      endTime: evt.end?.dateTime || '',
      attendees: evt.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
      location: evt.location?.displayName || undefined
    };
  }

  async deleteEvent(eventId: string): Promise<void> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/calendar/events/${eventId}`;
    await axios.delete(url, { headers });
  }

  // --- IContactsProvider ---
  async searchContacts(query: string): Promise<ContactInfo[]> {
    const headers = await this.getHeaders();
    const url = 'https://graph.microsoft.com/v1.0/me/contacts';
    const params: any = {
      $select: 'id,displayName,emailAddresses,phoneNumbers,companyName'
    };

    if (query) {
      params.$search = `"${query}"`;
    }

    const res = await axios.get(url, { headers, params });
    const items = res.data.value || [];

    return items.map((item: any) => ({
      id: item.id,
      name: item.displayName || 'Unnamed',
      emails: item.emailAddresses?.map((e: any) => e.address).filter(Boolean) || [],
      phones: item.phoneNumbers?.map((p: any) => p.number).filter(Boolean) || [],
      organization: item.companyName || undefined
    }));
  }

  async createContact(name: string, email: string, phone?: string): Promise<ContactInfo> {
    const headers = await this.getHeaders();
    const url = 'https://graph.microsoft.com/v1.0/me/contacts';

    const parts = name.split(' ');
    const givenName = parts[0] || '';
    const surname = parts.slice(1).join(' ') || '';

    const requestBody = {
      givenName,
      surname,
      emailAddresses: [{ address: email, name: name }],
      businessPhones: phone ? [phone] : []
    };

    const res = await axios.post(url, requestBody, { headers });
    const item = res.data;

    return {
      id: item.id,
      name: item.displayName || name,
      emails: item.emailAddresses?.map((e: any) => e.address).filter(Boolean) || [email],
      phones: item.businessPhones || []
    };
  }

  async deleteContact(contactId: string): Promise<void> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/contacts/${contactId}`;
    await axios.delete(url, { headers });
  }
}
