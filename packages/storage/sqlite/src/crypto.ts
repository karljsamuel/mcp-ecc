import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

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
 * (`encryptionKeyGeneration` on SQLite, `encryption_key_generation` on D1),
 * never inside the blob.
 *
 * The encryption key is derived PER OWNER from the master key, so a blob is
 * useless without both the master key (or the retired key for its generation)
 * and the owning principal's id. A blob encrypted for owner A cannot be
 * decrypted as owner B.
 *
 * packages/storage/d1/src/crypto.ts MUST emit and accept exactly these bytes.
 * Web Crypto appends the GCM tag to the ciphertext internally, so the D1
 * module splits/re-joins the tag to match this layout; the two implementations
 * are cross-checked in tests.
 */

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

/**
 * Per-owner key derivation: HKDF-SHA256 over the master key.
 *
 *   key = HKDF-SHA256( ikm  = masterKey,
 *                      salt = owner id (utf8),
 *                      info = CREDENTIAL_ENCRYPTION_CONTEXT,
 *                      len  = 32 bytes )
 *
 * The owner id is the HKDF salt (equivalently: the owner id is mixed into the
 * master key), which is what stops one owner's blob from being read as
 * another's. `masterKey` here is the master key for the row's generation.
 */
export function deriveOwnerKey(masterKey: string, ownerId: string): Buffer {
  if (!ownerId) {
    throw new EncryptionError('owner id is required to derive a credential encryption key');
  }
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from(ownerId, 'utf8'),
    Buffer.from(CREDENTIAL_ENCRYPTION_CONTEXT, 'utf8'),
    KEY_BYTES,
  ));
}

/** Encrypts `value` for `ownerId` under `masterKey` using the canonical layout. */
export function encrypt(value: string, masterKey: string, ownerId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveOwnerKey(masterKey, ownerId), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * Decrypts a canonical blob. Throws EncryptionError for anything that is not a
 * well-formed, authentic blob for this owner — wrong key, wrong owner,
 * truncation or tampering. It never returns a blank string as a failure value.
 */
export function decrypt(ciphertext: string, masterKey: string, ownerId: string): string {
  const raw = Buffer.from(ciphertext, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new EncryptionError('ciphertext is shorter than the IV + authentication tag');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveOwnerKey(masterKey, ownerId), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new EncryptionError('GCM authentication failed (wrong key, wrong owner, truncated or tampered ciphertext)', { cause: error });
  }
}
