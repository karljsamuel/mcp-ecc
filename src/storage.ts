import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface AccountCredentials {
  accountId: string;
  provider: 'google' | 'microsoft' | 'zoho' | 'imap_smtp';
  tokens: {
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number; // timestamp ms
    appPassword?: string; // For IMAP/SMTP or app password scenarios
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
    config?: Record<string, any>; // Arbitrary additional configurations
  };
}

const STORAGE_FILE = process.env.MCP_STORAGE_FILE || path.join(process.cwd(), 'config.json');
const ENCRYPTION_KEY = process.env.MCP_ENCRYPTION_KEY; // 32-byte key or password

export class TokenStorage {
  private static loadRawData(): Record<string, AccountCredentials> {
    if (!fs.existsSync(STORAGE_FILE)) {
      return {};
    }
    try {
      const data = fs.readFileSync(STORAGE_FILE, 'utf8');
      if (!data.trim()) return {};

      if (ENCRYPTION_KEY) {
        return this.decrypt(data);
      }
      return JSON.parse(data);
    } catch (e) {
      console.error('Failed to load credentials:', e);
      return {};
    }
  }

  private static saveRawData(data: Record<string, AccountCredentials>) {
    try {
      let serialized = JSON.stringify(data, null, 2);
      if (ENCRYPTION_KEY) {
        serialized = this.encrypt(serialized);
      }
      fs.writeFileSync(STORAGE_FILE, serialized, 'utf8');
    } catch (e) {
      console.error('Failed to save credentials:', e);
    }
  }

  private static encrypt(text: string): string {
    // Derive key
    const key = crypto.scryptSync(ENCRYPTION_KEY!, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    
    return JSON.stringify({
      iv: iv.toString('hex'),
      encrypted,
      tag: authTag
    });
  }

  private static decrypt(encryptedJson: string): Record<string, AccountCredentials> {
    try {
      const { iv, encrypted, tag } = JSON.parse(encryptedJson);
      const key = crypto.scryptSync(ENCRYPTION_KEY!, 'salt', 32);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return JSON.parse(decrypted);
    } catch (e) {
      console.error('Decryption failed, falling back to empty. Ensure MCP_ENCRYPTION_KEY matches.');
      return {};
    }
  }

  static getAccount(accountId: string): AccountCredentials | null {
    const data = this.loadRawData();
    return data[accountId] || null;
  }

  static listAccounts(): AccountCredentials[] {
    return Object.values(this.loadRawData());
  }

  static saveAccount(account: AccountCredentials) {
    const data = this.loadRawData();
    data[account.accountId] = account;
    this.saveRawData(data);
  }

  static deleteAccount(accountId: string) {
    const data = this.loadRawData();
    if (data[accountId]) {
      delete data[accountId];
      this.saveRawData(data);
    }
  }
}
