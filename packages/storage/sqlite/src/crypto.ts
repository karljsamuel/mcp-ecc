import CryptoJS from 'crypto-js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'mcp-ecc:v2:';

function keyFor(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export function isCurrent(value: string): boolean { return value.startsWith(PREFIX); }

export function encrypt(value: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(value: string, masterKey: string): string {
  if (!value) return '';
  if (!isCurrent(value)) {
    const plaintext = CryptoJS.AES.decrypt(value, masterKey).toString(CryptoJS.enc.Utf8);
    if (!plaintext) throw new Error('Unable to decrypt legacy ciphertext');
    return plaintext;
  }
  const input = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(masterKey), input.subarray(0, 12));
  decipher.setAuthTag(input.subarray(12, 28));
  return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8');
}
