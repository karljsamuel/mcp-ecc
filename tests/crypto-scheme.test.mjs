import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CREDENTIAL_ENCRYPTION_CONTEXT,
  IV_BYTES,
  TAG_BYTES,
  deriveOwnerKey,
  decrypt as sqliteDecrypt,
  encrypt as sqliteEncrypt,
} from '../packages/storage/sqlite/dist/crypto.js';
import {
  decrypt as d1Decrypt,
  encrypt as d1Encrypt,
} from '../packages/storage/d1/dist/crypto.js';

const KEY = 'test-master-key';
const OWNER = 'user-1';

// The canonical layout under test, shared by both backends:
//   base64( iv[12] || authTag[16] || ciphertext )   AES-256-GCM, no prefix.
// These tests need packages/storage/{sqlite,d1}/dist to exist (npm run build).

test('layout: base64( iv[12] || tag[16] || ciphertext ) with no prefix or version marker', () => {
  const plaintext = 'secret-value';
  const ciphertext = sqliteEncrypt(plaintext, KEY, OWNER);

  assert.match(ciphertext, /^[A-Za-z0-9+/]+={0,2}$/, 'the blob is pure base64');
  const raw = Buffer.from(ciphertext, 'base64');
  assert.equal(raw.length, IV_BYTES + TAG_BYTES + Buffer.byteLength(plaintext));
  assert.equal(ciphertext.includes('mcp-ecc'), false, 'no format prefix survives into the blob');
  assert.equal(Buffer.from(ciphertext, 'base64').includes(Buffer.from('mcp-ecc')), false);
});

test('round-trip decryption requires both the master key and the owner id', () => {
  assert.equal(sqliteDecrypt(sqliteEncrypt('secret-value', KEY, OWNER), KEY, OWNER), 'secret-value');
  assert.equal(sqliteDecrypt(sqliteEncrypt('', KEY, OWNER), KEY, OWNER), '');
});

test('a fresh IV is used per encryption, so equal plaintexts produce different blobs', () => {
  assert.notEqual(sqliteEncrypt('same', KEY, OWNER), sqliteEncrypt('same', KEY, OWNER));
});

test('a different owner id or master key cannot decrypt (per-owner derivation)', () => {
  const ciphertext = sqliteEncrypt('secret-value', KEY, OWNER);
  assert.throws(() => sqliteDecrypt(ciphertext, KEY, 'user-2'), /authentication failed/i);
  assert.throws(() => sqliteDecrypt(ciphertext, 'other-master-key', OWNER), /authentication failed/i);
});

test('tampering with the IV, the tag or the ciphertext is detected', () => {
  const raw = Buffer.from(sqliteEncrypt('secret-value', KEY, OWNER), 'base64');
  for (const index of [0, IV_BYTES - 1, IV_BYTES, IV_BYTES + TAG_BYTES - 1, raw.length - 1]) {
    const tampered = Buffer.from(raw);
    tampered[index] ^= 0x01;
    assert.throws(() => sqliteDecrypt(tampered.toString('base64'), KEY, OWNER), undefined, `byte ${index} must not be accepted`);
  }
});

test('a truncated or empty blob throws instead of returning a blank string', () => {
  assert.throws(() => sqliteDecrypt('', KEY, OWNER), /shorter than the IV/i);
  assert.throws(() => sqliteDecrypt(Buffer.alloc(IV_BYTES + TAG_BYTES - 1).toString('base64'), KEY, OWNER), /shorter than the IV/i);
});

test('derivation is HKDF-SHA256 over the master key with the owner id as salt', () => {
  const derived = deriveOwnerKey(KEY, OWNER);
  assert.equal(derived.length, 32, 'AES-256 key length');
  assert.deepEqual(deriveOwnerKey(KEY, OWNER), derived, 'stable for the same inputs');
  assert.notDeepEqual(deriveOwnerKey(KEY, 'user-2'), derived, 'owner id changes the key');
  assert.notDeepEqual(
    derived,
    createHash('sha256').update(KEY, 'utf8').digest(),
    'not the bare sha256(masterKey) the old scheme used',
  );
  assert.equal(typeof CREDENTIAL_ENCRYPTION_CONTEXT, 'string');
});

test('a blank owner id is rejected on both backends', async () => {
  assert.throws(() => sqliteEncrypt('x', KEY, ''), /owner id is required/);
  await assert.rejects(d1Encrypt('x', KEY, ''), /owner id is required/);
});

test('SQLite and D1 produce interchangeable blobs (one shared layout)', async () => {
  const fromSqlite = sqliteEncrypt('cross-backend', KEY, OWNER);
  assert.equal(await d1Decrypt(fromSqlite, KEY, OWNER), 'cross-backend');

  const fromD1 = await d1Encrypt('cross-backend', KEY, OWNER);
  assert.equal(sqliteDecrypt(fromD1, KEY, OWNER), 'cross-backend');
  assert.equal(
    Buffer.from(fromD1, 'base64').length,
    Buffer.from(fromSqlite, 'base64').length,
  );
});

test('D1 enforces the same failure contract as SQLite', async () => {
  const ciphertext = await d1Encrypt('secret-value', KEY, OWNER);
  await assert.rejects(d1Decrypt(ciphertext, KEY, 'user-2'), /authentication failed/i);
  await assert.rejects(d1Decrypt(ciphertext, 'other-master-key', OWNER), /authentication failed/i);
  await assert.rejects(d1Decrypt('', KEY, OWNER), /shorter than the IV/i);

  const raw = Buffer.from(ciphertext, 'base64');
  raw[raw.length - 1] ^= 0x01;
  await assert.rejects(d1Decrypt(raw.toString('base64'), KEY, OWNER), /authentication failed/i);
});
