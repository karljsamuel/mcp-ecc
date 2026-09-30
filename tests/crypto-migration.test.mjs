import test from 'node:test';
import assert from 'node:assert/strict';
import CryptoJS from 'crypto-js';
import { decrypt, encrypt, isCurrent } from '../packages/storage/sqlite/dist/crypto.js';

test('SQLite crypto encrypts and authenticates AES-256-GCM values', () => {
  const encrypted = encrypt('secret-value', 'test-master-key');
  assert.equal(isCurrent(encrypted), true);
  assert.equal(decrypt(encrypted, 'test-master-key'), 'secret-value');
  assert.throws(() => decrypt(encrypted, 'wrong-key'));
});

test('SQLite crypto detects tampering', () => {
  const encrypted = encrypt('secret-value', 'test-master-key');
  const bytes = Buffer.from(encrypted.slice('mcp-ecc:v2:'.length), 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => decrypt(`mcp-ecc:v2:${bytes.toString('base64')}`, 'test-master-key'));
});

test('SQLite crypto reads CryptoJS legacy ciphertext during migration', () => {
  const legacy = CryptoJS.AES.encrypt('legacy-value', 'test-master-key').toString();
  assert.equal(decrypt(legacy, 'test-master-key'), 'legacy-value');
  assert.equal(isCurrent(legacy), false);
});
