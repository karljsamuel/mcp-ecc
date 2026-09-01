import { createDAVClient } from 'tsdav';
import type { DAVAddressBook } from 'tsdav';
import type {
  AccountCredentials,
  IContactsProvider,
  Contact,
  ListContactsOptions,
  CreateContactInput,
  UpdateContactInput,
  SearchOptions,
} from '@mcp-ecc/core';

// Minimal vCard 3.0 escaping
function vcardEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function buildVCard(contact: CreateContactInput, uid?: string): string {
  const vcardUid = uid || `mcp-ecc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${vcardUid}`,
    `FN:${vcardEscape(contact.displayName || 'Contact')}`,
    `N:${vcardEscape(contact.displayName || 'Contact')};;;;`,
  ];
  for (const e of contact.emails || []) {
    lines.push(`EMAIL;TYPE=${e.type === 'home' ? 'HOME' : 'WORK'}:${e.email}`);
  }
  for (const p of contact.phones || []) {
    lines.push(`TEL;TYPE=${String(p.type || 'CELL').toUpperCase().replace('MOBILE', 'CELL')}:${p.number}`);
  }
  if (contact.organization) lines.push(`ORG:${vcardEscape(contact.organization)}`);
  if (contact.jobTitle) lines.push(`TITLE:${vcardEscape(contact.jobTitle)}`);
  if (contact.notes) lines.push(`NOTE:${vcardEscape(contact.notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function parseVCard(data: string, url: string, etag?: string): Contact {
  const field = (name: string): string => {
    const m = data.match(new RegExp(`^${name}[:;](.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const fullName = field('FN') || field('N')?.replace(/;/g, ' ') || 'Contact';
  const emailsRaw = data.match(/^EMAIL[^:]*:(.*)$/gm) || [];
  const phonesRaw = data.match(/^TEL[^:]*:(.*)$/gm) || [];
  return {
    id: url,
    displayName: fullName,
    emails: emailsRaw.map(l => ({ email: l.replace(/^EMAIL[^:]*:/, '').trim(), type: 'work' as const })),
    phones: phonesRaw.map(l => ({ number: l.replace(/^TEL[^:]*:/, '').trim(), type: 'mobile' as const })),
    organization: field('ORG') || undefined,
    jobTitle: field('TITLE') || undefined,
    notes: field('NOTE') || undefined,
    raw: { url, etag, vcard: data },
  };
}

export class CardDAVProvider implements IContactsProvider {
  private clientPromise: Promise<any> | null = null;

  constructor(private accountId: string, private credentials: AccountCredentials) {}

  private getServerUrl(): string {
    const url = this.credentials.config?.carddavUrl || this.credentials.config?.davUrl;
    return typeof url === 'string' ? url : '';
  }

  private async getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = createDAVClient({
        serverUrl: this.getServerUrl(),
        credentials: {
          username: this.accountId,
          password: this.credentials.appPassword || '',
        },
        authMethod: 'Basic',
        defaultAccountType: 'carddav',
      });
    }
    return this.clientPromise;
  }

  private async getAddressBooks(): Promise<DAVAddressBook[]> {
    const client = await this.getClient();
    const account = await client.createAccount({ account: { serverUrl: this.getServerUrl(), accountType: 'carddav', credentials: { username: this.accountId, password: this.credentials.appPassword || '' } }, loadCollections: false, loadObjects: false });
    // tsdav's exported fetchAddressBooks uses the broken raw propfind —
    // discover address books via the client's propfind instead.
    const res = await client.propfind({
      url: account.homeUrl || this.getServerUrl(),
      props: { 'd:resourcetype': {}, 'd:displayname': {} },
      depth: '1',
    });
    const books: DAVAddressBook[] = [];
    for (const r of res) {
      const rt = r.props?.resourcetype as Record<string, unknown> | undefined;
      if (!rt || !('addressbook' in rt)) continue;
      books.push({
        url: new URL(r.href || '', account.rootUrl || this.getServerUrl()).href,
        displayName: typeof r.props?.displayname === 'string' ? r.props.displayname : undefined,
      });
    }
    return books;
  }

  async listContacts(options: ListContactsOptions = {}): Promise<Contact[]> {
    const books = await this.getAddressBooks();
    const contacts: Contact[] = [];
    for (const book of books) {
      const vcards = await this.fetchVCardObjects(book);
      contacts.push(...vcards);
    }
    return options.limit ? contacts.slice(0, options.limit) : contacts;
  }

  private async fetchVCardObjects(book: DAVAddressBook): Promise<Contact[]> {
    const client = await this.getClient();
    const res = await client.propfind({
      url: book.url,
      props: { 'd:resourcetype': {}, 'd:getetag': {} },
      depth: '1',
    });
    const contacts: Contact[] = [];
    for (const r of res) {
      const href = r.href || '';
      if (!href.endsWith('.vcf')) continue;
      const rt = r.props?.resourcetype as Record<string, unknown> | undefined;
      if (rt && Object.keys(rt).length > 0) continue; // collection, not object
      try {
        const url = new URL(href, book.url).href;
        const text = await this.fetchObject(url);
        if (!text) continue;
        contacts.push(parseVCard(text, url, r.props?.getetag as string | undefined));
      } catch (e) {
        console.error(`Failed to fetch vcard ${href}:`, e);
      }
    }
    return contacts;
  }

  private async fetchObject(url: string): Promise<string | null> {
    const client = await this.getClient();
    const res = await client.davRequest({ url, init: { method: 'GET' } });
    const first = Array.isArray(res) ? res[0] : res;
    if (!first) return null;
    if (typeof first.raw === 'string' && first.raw.length > 0) return first.raw;
    if (first.raw && typeof first.raw.text === 'function') {
      return await first.raw.text();
    }
    return (first as any).data || (first as any).body || (first as any).text || null;
  }

  async getContact(contactId: string): Promise<Contact> {
    const contacts = await this.listContacts();
    const c = contacts.find(x => x.id === contactId);
    if (!c) throw new Error(`Contact not found: ${contactId}`);
    return c;
  }

  async createContact(contact: CreateContactInput): Promise<Contact> {
    const books = await this.getAddressBooks();
    const book = books[0];
    if (!book) throw new Error('No address book found');
    const client = await this.getClient();
    const vcard = buildVCard(contact);
    const filename = `mcp-ecc-${Date.now()}.vcf`;
    const url = `${book.url.endsWith('/') ? book.url : book.url + '/'}${filename}`;
    await client.createObject({
      url,
      data: vcard,
      headers: { 'Content-Type': 'text/vcard; charset=utf-8' },
    });
    return parseVCard(vcard, url);
  }

  async updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact> {
    const existing = await this.getContact(contactId);
    const merged: CreateContactInput = {
      displayName: patches.displayName ?? existing.displayName,
      emails: patches.emails ?? existing.emails,
      phones: patches.phones ?? existing.phones,
      organization: patches.organization ?? existing.organization,
      jobTitle: patches.jobTitle ?? existing.jobTitle,
      notes: patches.notes ?? existing.notes,
    };
    const vcard = buildVCard(merged, (existing.raw?.vcard as string | undefined)?.match(/^UID:(.*)$/m)?.[1]?.trim());
    const client = await this.getClient();
    const resp = await client.updateObject({
      url: contactId,
      data: vcard,
      etag: existing.raw?.etag as string | undefined,
      headers: { 'Content-Type': 'text/vcard; charset=utf-8' },
    });
    if (resp && resp.status && resp.status >= 400) {
      throw new Error(`CardDAV update failed: ${resp.status} ${resp.statusText || ''} ${typeof resp.raw === 'string' ? resp.raw.slice(0, 120) : ''}`);
    }
    return parseVCard(vcard, contactId);
  }

  async deleteContact(contactId: string): Promise<void> {
    const existing = await this.getContact(contactId);
    const client = await this.getClient();
    await client.deleteObject({
      url: contactId,
      etag: existing.raw?.etag as string | undefined,
    });
  }

  async searchContacts(query: string, options: SearchOptions = {}): Promise<Contact[]> {
    const contacts = await this.listContacts();
    const q = query.toLowerCase();
    return contacts.filter(c =>
      c.displayName.toLowerCase().includes(q) ||
      c.emails.some(e => e.email.toLowerCase().includes(q)) ||
      (c.organization || '').toLowerCase().includes(q)
    );
  }
}
