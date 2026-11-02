/**
 * CANONICAL CREDENTIAL CIPHERTEXT LAYOUT — shared contract for every backend
 * =========================================================================
 *
 *     base64( iv[12] || authTag[16] || ciphertext )        AES-256-GCM
 *
 *   iv         12 random bytes, generated fresh for every encryption.
 *   authTag    16-byte (128-bit) GCM authentication tag.
 *   ciphertext everything after the tag; length equals the plaintext length.
 *
 * There is deliberately NO prefix, algorithm tag or format version inside the
 * blob: ciphertext is opaque and interchangeable between backends. The key
 * generation that produced a value is recorded in a sibling database column
 * (`encryption_key_generation` on D1, `encryptionKeyGeneration` on SQLite),
 * never inside the blob.
 *
 * The encryption key is derived PER OWNER from the master key, so a blob is
 * useless without both the master key (or the retired key for its generation)
 * and the owning principal's id. A blob encrypted for owner A cannot be
 * decrypted as owner B.
 *
 * Web Crypto appends the GCM tag to the ciphertext, so this module splits the
 * tag out and re-joins it to match the layout byte-for-byte with
 * packages/storage/sqlite/src/crypto.ts. The two are cross-checked in tests.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** HKDF `info` string. Changing it silently invalidates every stored blob. */
export const CREDENTIAL_ENCRYPTION_CONTEXT = 'mcp-ecc/credential-encryption/v1';
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

/** Raised whenever a blob cannot be produced or authenticated. Never swallowed. */
export class EncryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EncryptionError';
  }
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  } catch (error) {
    // atob is strict about invalid base64 (unlike Node's lenient Buffer.from), so
    // surface the failure as EncryptionError rather than letting a raw DOMException
    // escape the documented error contract.
    throw new EncryptionError('ciphertext is not valid base64', { cause: error });
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Copies a view into a plain ArrayBuffer for Web Crypto / BufferSource typing. */
function source(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/**
 * Per-owner key derivation: HKDF-SHA256 over the master key.
 *
 *   key = HKDF-SHA256( ikm  = masterKey,
 *                      salt = owner id (utf8),
 *                      info = CREDENTIAL_ENCRYPTION_CONTEXT,
 *                      len  = 32 bytes )
 *
 * Byte-identical to the SQLite implementation. `masterKey` here is the master
 * key for the row's generation.
 */
export async function deriveOwnerKey(masterKey: string, ownerId: string): Promise<CryptoKey> {
  if (!ownerId) {
    throw new EncryptionError('owner id is required to derive a credential encryption key');
  }
  const material = await crypto.subtle.importKey('raw', encoder.encode(masterKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(ownerId),
      info: encoder.encode(CREDENTIAL_ENCRYPTION_CONTEXT),
    },
    material,
    KEY_BYTES * 8,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts `value` for `ownerId` under `masterKey` using the canonical layout. */
export async function encrypt(value: string, masterKey: string, ownerId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: source(iv), tagLength: TAG_BYTES * 8 },
    await deriveOwnerKey(masterKey, ownerId),
    encoder.encode(value),
  ));
  // Web Crypto returns ciphertext || tag; the canonical layout is iv || tag || ciphertext.
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  const body = sealed.slice(0, sealed.length - TAG_BYTES);
  return encodeBase64(join(iv, tag, body));
}

/**
 * Decrypts a canonical blob. Throws EncryptionError for anything that is not a
 * well-formed, authentic blob for this owner — wrong key, wrong owner,
 * truncation or tampering. It never returns a blank string as a failure value.
 */
export async function decrypt(ciphertext: string, masterKey: string, ownerId: string): Promise<string> {
  const raw = decodeBase64(ciphertext);
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new EncryptionError('ciphertext is shorter than the IV + authentication tag');
  }
  const iv = raw.slice(0, IV_BYTES);
  const tag = raw.slice(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.slice(IV_BYTES + TAG_BYTES);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: source(iv), tagLength: TAG_BYTES * 8 },
      await deriveOwnerKey(masterKey, ownerId),
      source(join(body, tag)),
    );
    return decoder.decode(plaintext);
  } catch (error) {
    throw new EncryptionError('GCM authentication failed (wrong key, wrong owner, truncated or tampered ciphertext)', { cause: error });
  }
}
