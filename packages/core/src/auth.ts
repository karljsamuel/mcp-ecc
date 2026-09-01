import type { User } from './types.js';
import { AuthError } from './types.js';
import type { StorageAdapter } from './storage.js';
import { generateId } from './utils.js';
import * as crypto from 'crypto';

// Argon2 is the modern password hasher, but to avoid a native dependency we use
// scrypt (Node built-in, memory-hard, NIST-recommended) which is fully
// satisfactory for credential storage.
export interface AuthServiceOptions {
  sessionTtlMs?: number;
}

export class AuthService {
  private sessionTtlMs: number;

  constructor(private storage: StorageAdapter, options: AuthServiceOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  // --- Password hashing (scrypt, Node built-in) ---

  async hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await this.scryptAsync(password, salt);
    return `scrypt$${salt}$${derived}`;
  }

  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const derived = await this.scryptAsync(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(derived, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private scryptAsync(password: string, salt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, derived) => {
        if (err) return reject(err);
        resolve(derived.toString('hex'));
      });
    });
  }

  // --- Session tokens ---

  newSessionToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  sessionExpiry(now = Date.now()): number {
    return now + this.sessionTtlMs;
  }

  // --- User management ---

  async createUser(opts: { username: string; displayName?: string; password: string; role?: 'admin' | 'user' }): Promise<User> {
    const existing = await this.storage.getUserByUsername(opts.username);
    if (existing) throw new AuthError('Username already taken');
    const now = Date.now();
    const user: User = {
      id: generateId(),
      username: opts.username,
      displayName: opts.displayName || opts.username,
      passwordHash: await this.hashPassword(opts.password),
      role: opts.role || 'user',
      mcpApiKey: crypto.randomBytes(32).toString('hex'),
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.saveUser(user);
    return user;
  }

  async authenticate(username: string, password: string): Promise<User> {
    const user = await this.storage.getUserByUsername(username);
    if (!user) throw new AuthError('Invalid username or password');
    const ok = await this.verifyPassword(password, user.passwordHash);
    if (!ok) throw new AuthError('Invalid username or password');
    return user;
  }

  async validateApiKey(apiKey: string): Promise<User> {
    const user = await this.storage.getUserByApiKey(apiKey);
    if (!user) throw new AuthError('Invalid API key');
    return user;
  }

  async rotateApiKey(userId: string): Promise<string> {
    const newKey = crypto.randomBytes(32).toString('hex');
    await this.storage.updateUser(userId, { mcpApiKey: newKey });
    return newKey;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.storage.getUser(userId);
    if (!user) throw new AuthError('User not found');
    const ok = await this.verifyPassword(currentPassword, user.passwordHash);
    if (!ok) throw new AuthError('Current password is incorrect');
    await this.storage.updateUser(userId, { passwordHash: await this.hashPassword(newPassword) });
  }

  async resetPassword(userId: string, newPassword: string): Promise<void> {
    await this.storage.updateUser(userId, { passwordHash: await this.hashPassword(newPassword) });
  }

  // First-run bootstrap: create the admin when no users exist.
  async bootstrapAdmin(opts: { username: string; displayName?: string; password: string }): Promise<User> {
    const count = await this.storage.countUsers();
    if (count > 0) throw new AuthError('Admin already configured');
    return this.createUser({ ...opts, role: 'admin' });
  }
}