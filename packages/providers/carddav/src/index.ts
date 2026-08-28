import type {
  AccountCredentials,
  IContactsProvider,
  Contact,
  ListContactsOptions,
  CreateContactInput,
  UpdateContactInput,
  SearchOptions,
} from '@mcp-ecc/core';

export class CardDAVProvider implements IContactsProvider {
  constructor(private accountId: string, private credentials: AccountCredentials) {
    // TODO: Implement CardDAV with proper library
    console.warn('CardDAV provider is not fully implemented yet');
  }

  async listContacts(options: ListContactsOptions = {}): Promise<Contact[]> {
    return [];
  }

  async getContact(contactId: string): Promise<Contact> {
    throw new Error('CardDAV not implemented');
  }

  async createContact(contact: CreateContactInput): Promise<Contact> {
    throw new Error('CardDAV not implemented');
  }

  async updateContact(contactId: string, patches: UpdateContactInput): Promise<Contact> {
    throw new Error('CardDAV not implemented');
  }

  async deleteContact(contactId: string): Promise<void> {
    throw new Error('CardDAV not implemented');
  }

  async searchContacts(query: string, options: SearchOptions = {}): Promise<Contact[]> {
    return [];
  }
}