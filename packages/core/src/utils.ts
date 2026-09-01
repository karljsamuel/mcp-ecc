export function generateId(): string {
  return crypto.randomUUID();
}

export function sanitizeForLog(obj: unknown, sensitiveKeys = ['password', 'token', 'secret', 'key', 'authorization']): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLog(item, sensitiveKeys));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some(k => lowerKey.includes(k));
    if (isSensitive) {
      result[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeForLog(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number; backoff?: number; shouldRetry?: (error: unknown) => boolean } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, backoff = 2, shouldRetry = () => true } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      await delay(delayMs * Math.pow(backoff, attempt - 1));
    }
  }

  throw lastError;
}

export function base64Encode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64');
}

export function base64Decode(str: string): string {
  return Buffer.from(str, 'base64').toString('utf8');
}

export function base64URLEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function parseLinkHeader(header: string): Map<string, string> {
  const links = new Map<string, string>();
  if (!header) return links;

  const parts = header.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links.set(match[2], match[1]);
    }
  }
  return links;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

// Convert a human account name into a URL-safe slug.
// Allowed chars: a-z, 0-9, '-', '_'. Spaces -> '-'.
export function slugify(name: string, fallback = 'account'): string {
  let slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')   // spaces/special -> '-'
    .replace(/^-+|-+$/g, '');         // trim leading/trailing '-'
  if (!slug) slug = fallback;
  // guarantee uniqueness by appending short hash if provided separately
  return slug;
}

export function generateSlug(name: string, suffix?: string): string {
  const base = slugify(name);
  if (!suffix) return base;
  return `${base}-${suffix.slice(0, 8)}`;
}