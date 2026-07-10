import { TokenStorage } from '../storage.js';
import { IEmailProvider, ICalendarProvider, IContactsProvider } from './types.js';
import { GoogleProvider } from './google.js';
import { MicrosoftProvider } from './microsoft.js';
import { ZohoProvider } from './zoho.js';
import { ImapSmtpProvider } from './imap-smtp.js';

export class AccountProviderRegistry {
  private static emailInstances: Map<string, IEmailProvider> = new Map();
  private static calendarInstances: Map<string, ICalendarProvider> = new Map();
  private static contactsInstances: Map<string, IContactsProvider> = new Map();

  private static getOrInitialize(accountId: string) {
    const creds = TokenStorage.getAccount(accountId);
    if (!creds) {
      throw new Error(`Account with ID '${accountId}' is not registered or found in local storage.`);
    }

    // Check cache
    if (this.emailInstances.has(accountId)) {
      return {
        email: this.emailInstances.get(accountId)!,
        calendar: this.calendarInstances.get(accountId)!,
        contacts: this.contactsInstances.get(accountId)!
      };
    }

    let provider: any;
    switch (creds.provider) {
      case 'google':
        provider = new GoogleProvider(creds);
        break;
      case 'microsoft':
        provider = new MicrosoftProvider(creds);
        break;
      case 'zoho':
        provider = new ZohoProvider(creds);
        break;
      case 'imap_smtp':
        provider = new ImapSmtpProvider(creds);
        break;
      default:
        throw new Error(`Unsupported provider type: ${creds.provider}`);
    }

    this.emailInstances.set(accountId, provider);
    this.calendarInstances.set(accountId, provider);
    this.contactsInstances.set(accountId, provider);

    return { email: provider, calendar: provider, contacts: provider };
  }

  static async getEmailProvider(accountId: string): Promise<IEmailProvider> {
    return this.getOrInitialize(accountId).email;
  }

  static async getCalendarProvider(accountId: string): Promise<ICalendarProvider> {
    return this.getOrInitialize(accountId).calendar;
  }

  static async getContactsProvider(accountId: string): Promise<IContactsProvider> {
    return this.getOrInitialize(accountId).contacts;
  }
}
