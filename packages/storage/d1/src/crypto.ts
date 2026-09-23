import CryptoJS from 'crypto-js';

const PREFIX = 'mcp-ecc:v2:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function source(value: Uint8Array): ArrayBuffer { return new Uint8Array(value).buffer as ArrayBuffer; }
async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(masterKey));
  return crypto.subtle.importKey('raw', source(new Uint8Array(digest)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function decryptLegacyD1(value: string, masterKey: string): Promise<string> {
  const input = decodeBase64(value);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: source(input.slice(0, 12)) }, await deriveKey(masterKey), source(input.slice(12)),
  );
  return decoder.decode(plaintext);
}
async function decryptLegacy(value: string, masterKey: string): Promise<string> {
  try {
    const plaintext = CryptoJS.AES.decrypt(value, masterKey).toString(CryptoJS.enc.Utf8);
    if (!plaintext) throw new Error('CryptoJS returned empty plaintext');
    return plaintext;
  } catch { return decryptLegacyD1(value, masterKey); }
}
export function isCurrent(value: string): boolean { return value.startsWith(PREFIX); }
export async function encrypt(value: string, masterKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: source(iv) }, await deriveKey(masterKey), encoder.encode(value),
  ));
  return PREFIX + encodeBase64(new Uint8Array([...iv, ...ciphertext]));
}
export async function decrypt(value: string, masterKey: string): Promise<string> {
  if (!value) return '';
  if (!isCurrent(value)) return decryptLegacy(value, masterKey);
  const input = decodeBase64(value.slice(PREFIX.length));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: source(input.slice(0, 12)) }, await deriveKey(masterKey), source(input.slice(12)),
  );
  return decoder.decode(plaintext);
}
