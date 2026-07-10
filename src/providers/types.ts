export interface EmailMessage {
  id: string;
  threadId?: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  snippet?: string;
  body?: string; // Text or clean Markdown content
  htmlBody?: string;
  date: string;
  unread: boolean;
  starred: boolean;
  labelsOrFolders: string[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  attendees?: string[];
  location?: string;
  status?: string;
}

export interface ContactInfo {
  id: string;
  name: string;
  emails: string[];
  phones?: string[];
  organization?: string;
}

export interface IEmailProvider {
  listEmails(folder?: string, limit?: number, query?: string): Promise<EmailMessage[]>;
  getEmail(messageId: string): Promise<EmailMessage>;
  sendEmail(to: string[], subject: string, body: string, cc?: string[], bcc?: string[]): Promise<EmailMessage>;
  manageEmail(messageId: string, action: 'archive' | 'read' | 'unread' | 'star'): Promise<void>;
  deleteEmail(messageId: string): Promise<void>;
}

export interface ICalendarProvider {
  listEvents(startTime?: string, endTime?: string): Promise<CalendarEvent[]>;
  createEvent(title: string, startTime: string, endTime: string, description?: string, attendees?: string[]): Promise<CalendarEvent>;
  updateEvent(eventId: string, patches: Partial<CalendarEvent>): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface IContactsProvider {
  searchContacts(query: string): Promise<ContactInfo[]>;
  createContact(name: string, email: string, phone?: string): Promise<ContactInfo>;
  deleteContact(contactId: string): Promise<void>;
}

export interface IProviderRegistry {
  getEmailProvider(accountId: string): Promise<IEmailProvider | null>;
  getCalendarProvider(accountId: string): Promise<ICalendarProvider | null>;
  getContactsProvider(accountId: string): Promise<IContactsProvider | null>;
}
